// MalamaOS Plugin: Mitsubishi Projector
// PJLink protocol (TCP port 4352) — stateless per-command connection
// Supports power, input selection, AV mute, and status polling

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import * as net from 'net';

interface ProjectorConfig {
  id: string;
  name: string;
  ip: string;
  port?: number;
  password?: string;
  room?: string;
}

interface ProjectorState {
  id: string;
  name: string;
  ip: string;
  connected: boolean;
  power: 'on' | 'off' | 'cooling' | 'warming' | 'unknown';
  input: string;
  avMuted: boolean;
  lastSeen: string | null;
  error: string | null;
}

// PJLink input codes for common connectors
const PJLINK_INPUTS: Record<string, string> = {
  'HDMI1': '32',  // Digital input 1 (HDMI) — class 1: input type 3 = digital, number 2
  'HDMI2': '33',
  'RGB1':  '11',
  'VIDEO': '21',
  'SVIDEO':'22',
};

const INPUT_NAMES: Record<string, string> = {
  '11': 'RGB 1', '12': 'RGB 2',
  '21': 'Video 1', '22': 'S-Video',
  '31': 'Digital 1', '32': 'HDMI 1', '33': 'HDMI 2',
  '41': 'Storage 1',
  '51': 'Network 1',
};

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// Send one PJLink command and return the response line
function pjlinkCommand(ip: string, port: number, cmd: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = '';
    let resolved = false;

    const done = (val: string | Error) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      if (val instanceof Error) reject(val); else resolve(val);
    };

    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);

    sock.connect(port, ip, () => {});

    sock.on('data', (d: Buffer) => {
      buf += d.toString('ascii');
      // Hub sends greeting first: "PJLINK 0\r" or "PJLINK 1 <nonce>\r"
      if (buf.includes('\r') && !buf.includes('%')) {
        // greeting received — send command
        const greeting = buf.split('\r')[0];
        buf = '';
        if (greeting.startsWith('PJLINK 1')) {
          // auth required — not supported without password for now
          clearTimeout(timer);
          done(new Error('auth_required'));
          return;
        }
        // PJLINK 0 = no auth, send command
        sock.write('%1' + cmd + '\r');
        return;
      }
      // Look for response line
      const idx = buf.indexOf('\r');
      if (idx !== -1) {
        clearTimeout(timer);
        done(buf.substring(0, idx).trim());
      }
    });

    sock.on('error', (e) => { clearTimeout(timer); done(e); });
    sock.on('close', () => { clearTimeout(timer); done(new Error('connection closed')); });
  });
}

class ProjectorDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
  power: ProjectorState['power'] = 'unknown';
  input = '';
  avMuted = false;
  lastSeen: string | null = null;
  error: string | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: ProjectorConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.ip = cfg.ip;
    this.port = cfg.port || 4352;
  }

  async queryPower(): Promise<void> {
    try {
      const r = await pjlinkCommand(this.ip, this.port, 'POWR ?');
      // Response: %1POWR=0 (off) | =1 (on) | =2 (cooling) | =3 (warming) | =ERR*
      const val = r.split('=')[1];
      if (val === '0') this.power = 'off';
      else if (val === '1') this.power = 'on';
      else if (val === '2') this.power = 'cooling';
      else if (val === '3') this.power = 'warming';
      this.lastSeen = new Date().toISOString();
      this.error = null;
    } catch (e: any) {
      this.error = e.message;
    }
  }

  async queryInput(): Promise<void> {
    try {
      const r = await pjlinkCommand(this.ip, this.port, 'INPT ?');
      const val = r.split('=')[1];
      if (val && !val.startsWith('ERR')) {
        this.input = val;
      }
    } catch {}
  }

  async setPower(on: boolean): Promise<string> {
    const r = await pjlinkCommand(this.ip, this.port, on ? 'POWR 1' : 'POWR 0');
    if (r.includes('OK')) {
      this.power = on ? 'warming' : 'cooling';
      this.lastSeen = new Date().toISOString();
      this.error = null;
    }
    return r;
  }

  async setInput(inputCode: string): Promise<string> {
    const code = PJLINK_INPUTS[inputCode] || inputCode;
    const r = await pjlinkCommand(this.ip, this.port, 'INPT ' + code);
    if (r.includes('OK')) {
      this.input = code;
    }
    return r;
  }

  async setAvMute(mute: boolean): Promise<string> {
    // 31 = video+audio mute on, 30 = mute off
    const r = await pjlinkCommand(this.ip, this.port, mute ? 'AVMT 31' : 'AVMT 30');
    if (r.includes('OK')) this.avMuted = mute;
    return r;
  }

  startPolling(): void {
    this.queryPower().catch(() => {});
    this.pollTimer = setInterval(() => {
      this.queryPower().catch(() => {});
      if (this.power === 'on') this.queryInput().catch(() => {});
    }, 30000);
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  toState(): ProjectorState & { connected: boolean } {
    return {
      id: this.id,
      name: this.name,
      ip: this.ip,
      connected: this.error === null && this.lastSeen !== null,
      power: this.power,
      input: INPUT_NAMES[this.input] || this.input || 'Unknown',
      avMuted: this.avMuted,
      lastSeen: this.lastSeen,
      error: this.error,
    };
  }
}

class MitsubishiProjectorPlugin extends BasePlugin {
  private projectors: Map<string, ProjectorDevice> = new Map();

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    const cfgs: ProjectorConfig[] = config.projectors || config.devices || [];
    if (!cfgs.length) this.mockMode = true;
  }

  async connect(): Promise<void> {
    if (this.mockMode) {
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[mitsubishi-projector] Connected in MOCK MODE');
      return;
    }
    const cfgs: ProjectorConfig[] = this.config.projectors || this.config.devices || [];
    for (const cfg of cfgs) {
      const p = new ProjectorDevice(cfg);
      this.projectors.set(cfg.id, p);
      p.startPolling();
    }
    this.connected = true;
    this.emit('connected', { mock: false });
    console.log('[mitsubishi-projector] Started ' + this.projectors.size + ' projector(s)');
  }

  async disconnect(): Promise<void> {
    for (const [, p] of this.projectors) p.stopPolling();
    this.projectors.clear();
    this.connected = false;
    this.emit('disconnected');
  }

  private getProjector(id?: string): ProjectorDevice | null {
    if (id) return this.projectors.get(id) || null;
    const first = this.projectors.values().next();
    return first.done ? null : first.value;
  }

  getState(): any {
    return {
      connected: this.connected,
      mock: this.mockMode,
      projectors: Array.from(this.projectors.values()).map(p => p.toState()),
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET', path: '/api/projector/state',
        handler: (_req, res) => jsonResponse(res, this.getState()),
      },
      {
        method: 'POST', path: '/api/projector/power',
        handler: async (req, res, body?) => {
          const data = body || await parseBody(req);
          const p = this.getProjector(data.id);
          if (!p) { jsonResponse(res, { error: 'not found' }, 404); return; }
          try {
            const result = await p.setPower(!!data.on);
            jsonResponse(res, { ok: true, result, power: p.power });
          } catch (e: any) {
            jsonResponse(res, { ok: false, error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST', path: '/api/projector/input',
        handler: async (req, res, body?) => {
          const data = body || await parseBody(req);
          const p = this.getProjector(data.id);
          if (!p) { jsonResponse(res, { error: 'not found' }, 404); return; }
          try {
            const result = await p.setInput(data.input || 'HDMI1');
            jsonResponse(res, { ok: true, result, input: p.input });
          } catch (e: any) {
            jsonResponse(res, { ok: false, error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST', path: '/api/projector/mute',
        handler: async (req, res, body?) => {
          const data = body || await parseBody(req);
          const p = this.getProjector(data.id);
          if (!p) { jsonResponse(res, { error: 'not found' }, 404); return; }
          try {
            const result = await p.setAvMute(!!data.mute);
            jsonResponse(res, { ok: true, result });
          } catch (e: any) {
            jsonResponse(res, { ok: false, error: e.message }, 500);
          }
        },
      },
      {
        method: 'POST', path: '/api/projector/query',
        handler: async (_req, res) => {
          const p = this.getProjector();
          if (!p) { jsonResponse(res, { error: 'not found' }, 404); return; }
          await p.queryPower();
          await p.queryInput();
          jsonResponse(res, p.toState());
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): MitsubishiProjectorPlugin {
  return new MitsubishiProjectorPlugin(manifest);
}
