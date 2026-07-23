// BaileyOS Plugin: Apple TV
// Network control for Apple TV devices via pyatv — no IR needed, local WiFi only.
//
// SETUP (one-time per Apple TV):
//   1. pip install pyatv  (on Bailey-AI)
//   2. Add to config.json (see bottom of file)
//   3. POST /api/appletv/discover               ← finds all Apple TVs on LAN
//   4. POST /api/appletv/pair/start             { "address": "192.168.1.X", "protocol": "AirPlay" }
//      → A 4-digit PIN appears on the TV screen
//   5. POST /api/appletv/pair/finish            { "address": "...", "pin": "1234" }
//      → Returns credentials string — save it in config.json
//   6. GET /api/appletv/state                   ← confirm connected

import * as path from 'path';
import * as cp from 'child_process';
import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';

const SIDECAR_PORT = 8798;
const SIDECAR_STARTUP_MS = 4000;

interface AppleTvDevice {
  id: string;
  name: string;
  address: string;
  // Map of protocol name to credentials string returned from pairing.
  // e.g. { "AirPlay": "<long credentials string>" }
  credentials?: Record<string, string>;
}

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

class AppleTvPlugin extends BasePlugin {
  private sidecar: cp.ChildProcess | null = null;
  private devices: AppleTvDevice[] = [];

  constructor(manifest: PluginManifest) { super(manifest); }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    this.devices = config.devices ?? [];
  }

  async connect(): Promise<void> {
    if (this.isMock()) {
      this.connected = true;
      this.emit('connected', { mock: true });
      return;
    }
    const script = path.join(process.cwd(), 'src', 'plugins', 'apple-tv', 'python', 'appletv_server.py');
    this.sidecar = cp.spawn('python', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.sidecar.stdout?.on('data', (d: Buffer) => process.stdout.write(`[appletv-py] ${d}`));
    this.sidecar.stderr?.on('data', (d: Buffer) => process.stderr.write(`[appletv-py] ${d}`));
    this.sidecar.on('exit', code => {
      console.log('[appletv] sidecar exited code', code);
      if (this.connected) { this.connected = false; this.emit('disconnected'); }
    });
    await new Promise(r => setTimeout(r, SIDECAR_STARTUP_MS));
    try {
      const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`);
      if (!res.ok) throw new Error(`sidecar returned ${res.status}`);
      this.connected = true;
      this.emit('connected', { mock: false });
      // Auto-connect to devices that have saved credentials.
      for (const dev of this.devices) {
        if (dev.credentials && Object.keys(dev.credentials).length) {
          this.sidecar$(
            '/connect',
            { address: dev.address, credentials: dev.credentials },
          ).catch(e => console.warn(`[appletv] auto-connect ${dev.address} failed:`, e.message));
        }
      }
    } catch (e) {
      console.error('[appletv] sidecar not responding:', e);
      this.connected = false;
    }
  }

  async disconnect(): Promise<void> {
    this.sidecar?.kill();
    this.sidecar = null;
    this.connected = false;
    this.emit('disconnected');
  }

  getState() {
    return {
      connected: this.connected,
      mock: this.isMock(),
      devices: this.devices.map(d => ({ id: d.id, name: d.name, address: d.address, paired: !!d.credentials })),
    };
  }

  private async sidecar$(p: string, body: any): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async sidecarGet(p: string): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}${p}`);
    return res.json();
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/appletv/state',
        handler: (_req, res) => jsonResponse(res, this.getState()),
      },
      {
        method: 'GET',
        path: '/api/appletv/discover',
        handler: async (_req, res) => {
          if (this.isMock()) return jsonResponse(res, { devices: [], mock: true });
          try {
            const result = await this.sidecarGet('/scan');
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST',
        path: '/api/appletv/connect',
        handler: async (req, res) => {
          const body = await parseBody(req);
          if (!body.address) return jsonResponse(res, { error: 'address required' }, 400);
          if (this.isMock()) return jsonResponse(res, { ok: true, mock: true });
          const dev = this.devices.find(d => d.address === body.address);
          const credentials = body.credentials ?? dev?.credentials ?? {};
          try {
            const result = await this.sidecar$('/connect', { address: body.address, credentials });
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST',
        path: '/api/appletv/pair/start',
        handler: async (req, res) => {
          const body = await parseBody(req);
          if (!body.address) return jsonResponse(res, { error: 'address required' }, 400);
          if (this.isMock()) return jsonResponse(res, { ok: true, mock: true, awaiting_pin: true });
          try {
            const result = await this.sidecar$('/pair/start', {
              address: body.address, protocol: body.protocol ?? 'AirPlay',
            });
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST',
        path: '/api/appletv/pair/finish',
        handler: async (req, res) => {
          const body = await parseBody(req);
          if (!body.address || !body.pin) return jsonResponse(res, { error: 'address and pin required' }, 400);
          if (this.isMock()) return jsonResponse(res, { ok: true, mock: true, credentials: 'MOCK_CREDS' });
          try {
            const result = await this.sidecar$('/pair/finish', { address: body.address, pin: body.pin });
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST',
        path: '/api/appletv/:id/command',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/appletv\/([^/]+)\/command/);
          const devId = match?.[1];
          if (!devId) return jsonResponse(res, { error: 'device id required' }, 400);

          const dev = this.devices.find(d => d.id === devId || d.address === devId);
          if (!dev) return jsonResponse(res, { error: `device '${devId}' not found in config` }, 404);

          const body = await parseBody(req);
          const command = body.command;
          if (!command) return jsonResponse(res, { error: 'command required' }, 400);

          if (this.isMock()) return jsonResponse(res, { ok: true, mock: true, command });

          try {
            const result = await this.sidecar$(`/${dev.address}/command`, { command });
            jsonResponse(res, result, result.error ? 400 : 200);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'GET',
        path: '/api/appletv/:id/now-playing',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/appletv\/([^/]+)\/now-playing/);
          const devId = match?.[1];
          const dev = this.devices.find(d => d.id === devId || d.address === devId);
          if (!dev) return jsonResponse(res, { error: `device '${devId}' not found` }, 404);
          if (this.isMock()) return jsonResponse(res, { playing: null, mock: true });
          try {
            const result = await this.sidecarGet(`/nowplaying/${dev.address}`);
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): AppleTvPlugin {
  return new AppleTvPlugin(manifest);
}

/*
CONFIG TEMPLATE — add to config.json under "plugins":
"apple-tv": {
  "enabled": true,
  "devices": [
    {
      "id": "living-room",
      "name": "Living Room Apple TV",
      "address": "192.168.1.X",
      "credentials": {}
    },
    {
      "id": "theatre",
      "name": "Theatre Apple TV",
      "address": "192.168.1.Y",
      "credentials": {}
    }
  ]
}

After pairing, paste the credentials string from /pair/finish into the matching device entry.

COMMANDS: play, pause, stop, next, previous, menu, home, home_hold, select,
          up, down, left, right, volume_up, volume_down, turn_on, turn_off
*/
