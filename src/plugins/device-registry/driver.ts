// BaileyOS Plugin: Device Registry
// Tracks authorized camera devices by IP address

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';

// --- Types ---

interface DeviceEntry {
  ip: string;
  userAgent: string;
  deviceName: string;
  cameraGranted: boolean;
  grantedAt: string;
  lastSeen: string;
  lastUser: string | null;
  identifyCount: number;
}

// --- Helpers ---

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// --- Plugin Class ---

class DeviceRegistryPlugin extends BasePlugin {
  private devices: Map<string, DeviceEntry> = new Map();
  private storagePath: string = '';

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  // --- Lifecycle ---

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);
    // Store JSON file in the project root
    this.storagePath = path.resolve(__dirname, '..', '..', '..', 'device-registry.json');
  }

  async connect(): Promise<void> {
    if (this.mockMode) {
      this.initMockDevices();
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[device-registry] Connected in MOCK MODE with 2 test devices');
    } else {
      this.loadFromDisk();
      this.connected = true;
      this.emit('connected', { mock: false });
      console.log('[device-registry] Connected in LIVE mode, ' + this.devices.size + ' devices loaded');
    }
  }

  async disconnect(): Promise<void> {
    if (!this.mockMode) {
      this.saveToDisk();
    }
    this.connected = false;
    this.emit('disconnected');
    console.log('[device-registry] Disconnected');
  }

  // --- Mock Data ---

  private initMockDevices(): void {
    const now = new Date().toISOString();
    this.devices.set('10.0.0.10', {
      ip: '10.0.0.10',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
      deviceName: 'User Phone',
      cameraGranted: true,
      grantedAt: now,
      lastSeen: now,
      lastUser: 'User 1',
      identifyCount: 12,
    });
    this.devices.set('10.0.0.11', {
      ip: '10.0.0.11',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)',
      deviceName: 'User Tablet',
      cameraGranted: true,
      grantedAt: now,
      lastSeen: now,
      lastUser: 'User 2',
      identifyCount: 7,
    });
  }

  // --- Persistence ---

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const entries: DeviceEntry[] = JSON.parse(raw);
        for (const entry of entries) {
          this.devices.set(entry.ip, entry);
        }
      }
    } catch (err) {
      console.error('[device-registry] Failed to load from disk:', err);
    }
  }

  private saveToDisk(): void {
    try {
      const entries = Array.from(this.devices.values());
      fs.writeFileSync(this.storagePath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('[device-registry] Failed to save to disk:', err);
    }
  }

  // --- Helpers ---

  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return first.trim();
    }
    return req.socket?.remoteAddress || '127.0.0.1';
  }

  // --- State ---

  getState(): any {
    return {
      connected: this.connected,
      mock: this.mockMode,
      deviceCount: this.devices.size,
      devices: Array.from(this.devices.values()),
    };
  }

  // --- Routes ---

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/devices/state â€” full state
      {
        method: 'GET',
        path: '/api/devices/state',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.getState());
        },
      },

      // GET /api/devices â€” list all devices (alias)
      {
        method: 'GET',
        path: '/api/devices',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, {
            devices: Array.from(this.devices.values()),
            count: this.devices.size,
          });
        },
      },

      // POST /api/devices/register â€” register a new device
      {
        method: 'POST',
        path: '/api/devices/register',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBody(req);
          const ip = body.ip || this.getClientIp(req);
          const now = new Date().toISOString();

          const existing = this.devices.get(ip);
          const entry: DeviceEntry = {
            ip: ip,
            userAgent: body.userAgent || req.headers['user-agent'] || 'unknown',
            deviceName: body.deviceName || existing?.deviceName || 'Unknown Device',
            cameraGranted: body.cameraGranted ?? existing?.cameraGranted ?? true,
            grantedAt: existing?.grantedAt || now,
            lastSeen: now,
            lastUser: body.lastUser || existing?.lastUser || null,
            identifyCount: existing?.identifyCount || 0,
          };

          this.devices.set(ip, entry);
          if (!this.mockMode) this.saveToDisk();

          this.emit('stateChange', { type: 'device-registered', device: entry });
          jsonResponse(res, { ok: true, device: entry });
        },
      },

      // POST /api/devices/remove â€” remove a device by ip
      {
        method: 'POST',
        path: '/api/devices/remove',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBody(req);
          const ip = body.ip;
          if (!ip) {
            jsonResponse(res, { ok: false, error: 'ip required' }, 400);
            return;
          }
          const existed = this.devices.has(ip);
          this.devices.delete(ip);
          if (!this.mockMode) this.saveToDisk();

          this.emit('stateChange', { type: 'device-removed', ip: ip });
          jsonResponse(res, { ok: true, removed: existed });
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): DeviceRegistryPlugin {
  return new DeviceRegistryPlugin(manifest);
}
