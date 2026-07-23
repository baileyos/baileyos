// BaileyOS Plugin: Rain Bird Sprinklers
// Bridges to the rainbird_sidecar.py (pyrainbird) to control the ESP-ME3 via LNK WiFi.

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';

// --- Types ---

interface ZoneConfig {
  id: number;
  name: string;
}

interface ZoneState {
  id: number;
  name: string;
  active: boolean;
}

interface RainbirdState {
  online: boolean;
  configured: boolean;
  sidecarUp: boolean;
  rain_sensor: boolean;
  active_zone: number | null;
  irrigating: boolean;   // true when any zone is running (firmware 2.12 can't report which one)
  zones: ZoneState[];
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
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

async function httpGet(url: string, timeoutMs = 4000): Promise<any> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function httpPost(url: string, body: any, timeoutMs = 8000): Promise<any> {
  const http = await import('http');
  const bodyStr = JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port || 80, path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'Connection': 'close' },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(bodyStr);
  });
}

// --- Plugin ---

const DEFAULT_ZONES: ZoneConfig[] = [
  { id: 1,  name: 'Against House R' },
  { id: 2,  name: 'Down to Campfire R' },
  { id: 3,  name: 'Deck Flower Bed R' },
  { id: 4,  name: 'Campfire Yard' },
  { id: 5,  name: 'Campfire Yard' },
  { id: 6,  name: 'Campfire Yard' },
  { id: 7,  name: 'Yard R' },
  { id: 8,  name: 'Walkway R' },
  { id: 9,  name: 'Driveway R' },
  { id: 10, name: 'Gate R' },
  { id: 11, name: 'Street Light' },
  { id: 12, name: 'Driveway L' },
  { id: 13, name: 'Front Yard R' },
  { id: 14, name: 'Front Yard L' },
  { id: 15, name: 'Behind Garage' },
  { id: 16, name: 'Hydrangea Hill' },
];

class RainbirdPlugin extends BasePlugin {
  private sidecarUrl: string = 'http://127.0.0.1:5502';
  private zoneConfigs: ZoneConfig[] = [...DEFAULT_ZONES];
  private state: RainbirdState = {
    online: false, configured: false, sidecarUp: false,
    rain_sensor: false, active_zone: null, irrigating: false, zones: [],
  };
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(manifest: PluginManifest) { super(manifest); console.log('[rainbird] DRIVER_V2_LOADED_127001'); }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    this.sidecarUrl = config.sidecar_url || 'http://127.0.0.1:5502';
    if (config.zones && Array.isArray(config.zones)) {
      this.zoneConfigs = config.zones;
    }
    // Seed offline stubs so zones always show in UI
    this.state.zones = this.zoneConfigs.map(z => ({ id: z.id, name: z.name, active: false }));
  }

  async connect(): Promise<void> {
    if (this.mockMode) {
      this.state = {
        online: true, configured: true, sidecarUp: true,
        rain_sensor: false, active_zone: 2, irrigating: true,
        zones: this.zoneConfigs.map((z, i) => ({ id: z.id, name: z.name, active: i === 1 })),
      };
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[rainbird] Connected in MOCK MODE');
    } else {
      await this.poll();
      this.connected = true;
      this.emit('connected', { mock: false });
      console.log('[rainbird] Connected — sidecar=' + this.sidecarUrl + ' sidecarUp=' + this.state.sidecarUp);
    }
    this.pollTimer = setInterval(() => this.poll(), 10000);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.connected = false;
    this.emit('disconnected');
  }

  private async poll(): Promise<void> {
    try {
      const raw = await httpGet(this.sidecarUrl + '/state', 25000); // may wait up to 20s for bg zone poller to release lock
      this.state.sidecarUp = true;
      this.state.online     = raw.online ?? false;
      this.state.configured = raw.configured ?? false;
      this.state.rain_sensor = raw.rain_sensor ?? false;
      this.state.active_zone = raw.active_zone ?? null;
      this.state.irrigating  = raw.irrigating ?? false;

      // Merge sidecar zone activity with config names
      const activityMap: Record<number, boolean> = {};
      for (const z of (raw.zones || [])) activityMap[z.id] = z.active;
      this.state.zones = this.zoneConfigs.map(z => ({
        id: z.id, name: z.name, active: activityMap[z.id] ?? false,
      }));

      this.broadcastState();
    } catch {
      this.state.sidecarUp = false;
      this.state.online = false;
    }
  }

  private broadcastState(): void {
    this.emit('stateChange', { type: 'poll', state: this.getState() });
  }

  getState(): any {
    return { ...this.state, mock: this.mockMode, connected: this.connected };
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET', path: '/api/rainbird/state',
        handler: (_req, res) => { jsonResponse(res, this.getState()); },
      },
      {
        method: 'POST', path: '/api/rainbird/zones/:id/run',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/rainbird\/zones\/(\d+)\/run/);
          if (!match) { jsonResponse(res, { error: 'Invalid zone' }, 400); return; }
          const zoneId = parseInt(match[1], 10);
          const body   = await parseBody(req);
          const minutes = Math.max(1, Math.min(60, parseInt(body.minutes, 10) || 10));
          try {
            const result = await httpPost(this.sidecarUrl + '/zones/' + zoneId + '/run', { minutes });
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 502);
          }
        },
      },
      {
        method: 'POST', path: '/api/rainbird/stop',
        handler: async (_req, res) => {
          try {
            const result = await httpPost(this.sidecarUrl + '/stop', {});
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 502);
          }
        },
      },
      {
        method: 'GET', path: '/api/rainbird/programs',
        handler: async (_req, res) => {
          try {
            const result = await httpGet(this.sidecarUrl + '/programs', 30000);
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message, programs: [] }, 502);
          }
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): RainbirdPlugin {
  return new RainbirdPlugin(manifest);
}
