// BaileyOS Plugin: BroadLink IR/RF Control
// Controls TVs, cable boxes, AV receivers, and RF ceiling fans via BroadLink RM4 Pro.
//
// SETUP:
//   1. pip install broadlink  (on Bailey-AI)
//   2. Add to config.json (see bottom of this file for template)
//   3. POST /api/broadlink/connect { "host": "192.168.1.X" }   ← RM4 Pro IP
//   4. POST /api/broadlink/learn { "deviceId": "media-room", "name": "tv-power", "label": "TV Power" }
//      Point remote at RM4 Pro when prompted
//   5. POST /api/broadlink/send { "codeId": "media-room-tv-power" }

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';

const SIDECAR_PORT = 8797;
const SIDECAR_STARTUP_MS = 3000;

interface BroadLinkDevice {
  id: string;
  name: string;
  host: string;
}

interface LearnedCode {
  id: string;
  deviceId: string;
  name: string;
  label: string;
  code: string;
  learnedAt: string;
}

interface CodesStore {
  devices: BroadLinkDevice[];
  codes: LearnedCode[];
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

class BroadLinkPlugin extends BasePlugin {
  private sidecar: cp.ChildProcess | null = null;
  private codesPath!: string;
  private store: CodesStore = { devices: [], codes: [] };
  private learnActive: { deviceId: string; name: string } | null = null;

  constructor(manifest: PluginManifest) { super(manifest); }

  private loadStore() {
    try {
      if (fs.existsSync(this.codesPath)) {
        this.store = JSON.parse(fs.readFileSync(this.codesPath, 'utf8'));
      }
    } catch {
      this.store = { devices: [], codes: [] };
    }
  }

  private saveStore() {
    fs.writeFileSync(this.codesPath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    // codes.json lives next to this driver
    this.codesPath = path.join(process.cwd(), 'src', 'plugins', 'broadlink', 'codes.json');
    this.loadStore();
    // Merge any config-defined devices (initial seed, not overwrite)
    for (const d of (config.devices ?? [])) {
      if (!this.store.devices.find((x: BroadLinkDevice) => x.id === d.id)) {
        this.store.devices.push(d);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isMock()) {
      this.connected = true;
      this.emit('connected', { mock: true });
      return;
    }
    const script = path.join(process.cwd(), 'src', 'plugins', 'broadlink', 'python', 'broadlink_server.py');
    this.sidecar = cp.spawn('python', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.sidecar.stdout?.on('data', (d: Buffer) => process.stdout.write(`[broadlink-py] ${d}`));
    this.sidecar.stderr?.on('data', (d: Buffer) => process.stderr.write(`[broadlink-py] ${d}`));
    this.sidecar.on('exit', code => {
      console.log('[broadlink] sidecar exited code', code);
      if (this.connected) { this.connected = false; this.emit('disconnected'); }
    });
    await new Promise(r => setTimeout(r, SIDECAR_STARTUP_MS));
    try {
      const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`);
      if (res.ok) {
        this.connected = true;
        this.emit('connected', { mock: false });
      } else {
        throw new Error(`sidecar health returned ${res.status}`);
      }
    } catch (e) {
      console.error('[broadlink] sidecar not responding:', e);
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
      devices: this.store.devices,
      codeCount: this.store.codes.length,
      learnActive: this.learnActive,
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

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/broadlink/state',
        handler: (_req, res) => jsonResponse(res, this.getState()),
      },
      {
        method: 'GET',
        path: '/api/broadlink/devices',
        handler: (_req, res) => jsonResponse(res, { devices: this.store.devices }),
      },
      {
        method: 'POST',
        path: '/api/broadlink/discover',
        handler: async (req, res) => {
          if (this.isMock()) return jsonResponse(res, { found: [], mock: true });
          const body = await parseBody(req);
          try {
            const result = await this.sidecar$('/discover', { timeout: body.timeout ?? 5 });
            if (result.found) {
              for (const d of result.found) {
                if (!this.store.devices.find((x: BroadLinkDevice) => x.host === d.host)) {
                  this.store.devices.push({ id: d.host, name: `BroadLink ${d.type}`, host: d.host });
                }
              }
              this.saveStore();
            }
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST',
        path: '/api/broadlink/connect',
        handler: async (req, res) => {
          const body = await parseBody(req);
          if (!body.host) return jsonResponse(res, { error: 'host required' }, 400);
          if (this.isMock()) return jsonResponse(res, { ok: true, mock: true });
          try {
            const result = await this.sidecar$('/connect', { host: body.host });
            if (result.ok && !this.store.devices.find((x: BroadLinkDevice) => x.host === body.host)) {
              this.store.devices.push({
                id: body.id ?? body.host,
                name: body.name ?? `BroadLink @ ${body.host}`,
                host: body.host,
              });
              this.saveStore();
            }
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'GET',
        path: '/api/broadlink/codes',
        handler: (_req, res) => jsonResponse(res, { codes: this.store.codes }),
      },
      {
        method: 'POST',
        path: '/api/broadlink/learn',
        handler: async (req, res) => {
          const body = await parseBody(req);
          const { deviceId, name, label, timeout } = body;
          if (!deviceId || !name) return jsonResponse(res, { error: 'deviceId and name required' }, 400);
          const device = this.store.devices.find((d: BroadLinkDevice) => d.id === deviceId);
          if (!device) return jsonResponse(res, { error: `device '${deviceId}' not found — POST /connect first` }, 404);

          if (this.isMock()) {
            const code: LearnedCode = {
              id: `${deviceId}-${name}`, deviceId, name,
              label: label ?? name, code: 'MOCK_IR_CODE', learnedAt: new Date().toISOString(),
            };
            const i = this.store.codes.findIndex((c: LearnedCode) => c.id === code.id);
            if (i >= 0) this.store.codes[i] = code; else this.store.codes.push(code);
            this.saveStore();
            return jsonResponse(res, { ok: true, code });
          }

          try {
            this.learnActive = { deviceId, name };
            this.emit('stateChange', this.getState());
            await this.sidecar$('/connect', { host: device.host });
            const result = await this.sidecar$('/learn', { host: device.host, timeout: timeout ?? 10 });
            this.learnActive = null;

            if (result.ok && result.code) {
              const id = `${deviceId}-${name}`;
              const code: LearnedCode = {
                id, deviceId, name, label: label ?? name,
                code: result.code, learnedAt: new Date().toISOString(),
              };
              const i = this.store.codes.findIndex((c: LearnedCode) => c.id === id);
              if (i >= 0) this.store.codes[i] = code; else this.store.codes.push(code);
              this.saveStore();
              jsonResponse(res, { ok: true, code });
            } else {
              jsonResponse(res, result, result.error ? 500 : 200);
            }
          } catch (e: any) {
            this.learnActive = null;
            jsonResponse(res, { error: e.message }, 500);
          } finally {
            this.emit('stateChange', this.getState());
          }
        },
      },
      {
        method: 'POST',
        path: '/api/broadlink/send',
        handler: async (req, res) => {
          const body = await parseBody(req);
          const id = body.codeId ?? (body.deviceId && body.name ? `${body.deviceId}-${body.name}` : null);
          if (!id) return jsonResponse(res, { error: 'codeId or (deviceId + name) required' }, 400);

          const code = this.store.codes.find((c: LearnedCode) => c.id === id);
          if (!code) return jsonResponse(res, { error: `code '${id}' not found` }, 404);

          const device = this.store.devices.find((d: BroadLinkDevice) => d.id === code.deviceId);
          if (!device) return jsonResponse(res, { error: `device '${code.deviceId}' not found` }, 404);

          if (this.isMock()) return jsonResponse(res, { ok: true, mock: true, sent: id });

          try {
            await this.sidecar$('/connect', { host: device.host });
            const result = await this.sidecar$('/send', { host: device.host, code: code.code });
            jsonResponse(res, result);
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
      {
        method: 'DELETE',
        path: '/api/broadlink/code/:id',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/broadlink\/code\/(.+)/);
          if (!match?.[1]) return jsonResponse(res, { error: 'id required' }, 400);
          const id = decodeURIComponent(match[1]);
          const before = this.store.codes.length;
          this.store.codes = this.store.codes.filter((c: LearnedCode) => c.id !== id);
          if (this.store.codes.length === before) return jsonResponse(res, { error: 'not found' }, 404);
          this.saveStore();
          jsonResponse(res, { ok: true, deleted: id });
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): BroadLinkPlugin {
  return new BroadLinkPlugin(manifest);
}

/*
CONFIG TEMPLATE — add to config.json under "plugins":
"broadlink": {
  "enabled": true,
  "devices": [
    { "id": "media-room", "name": "Media Room RM4 Pro", "host": "192.168.1.X" }
  ]
}

COMMON CODE IDs TO LEARN:
  media-room-tv-power         TV on/off toggle
  media-room-tv-input-hdmi1   TV HDMI 1
  media-room-cable-power      Xfinity X1 power
  media-room-cable-guide      Xfinity Guide button
  media-room-receiver-power   AV receiver power
  media-room-receiver-vol-up  Receiver volume up
  media-room-receiver-vol-dn  Receiver volume down
  media-room-fan-high         Ceiling fan high speed (RF)
  media-room-fan-off          Ceiling fan off (RF)
*/
