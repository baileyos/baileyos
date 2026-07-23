// MalamaOS Plugin: AV Devices (Marantz/Denon)
// Production Denon/Marantz IP control via TCP telnet on port 23
// ASCII command protocol for power, volume, mute, input control

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import * as net from 'net';

// --- Types ---

interface ReceiverConfig {
  id: string;
  name: string;
  ip: string;
  port?: number;
  room?: string;
  type?: string;
}

interface ReceiverState {
  id: string;
  name: string;
  ip: string;
  connected: boolean;
  power: boolean;
  volume: number;
  volumeDb: number;
  muted: boolean;
  input: string;
}

// Known Marantz/Denon inputs
const KNOWN_INPUTS: Record<string, string> = {
  'CD': 'CD',
  'DVD': 'DVD',
  'BD': 'Blu-ray',
  'TV': 'TV Audio',
  'SAT/CBL': 'SAT/Cable',
  'MPLAY': 'Media Player',
  'GAME': 'Game',
  'TUNER': 'Tuner',
  'AUX1': 'AUX 1',
  'AUX2': 'AUX 2',
  'NET': 'Network',
  'BT': 'Bluetooth',
  'USB/IPOD': 'USB',
  'PHONO': 'Phono',
};

// --- Helper ---

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

// --- Receiver Connection Class ---

class MarantzReceiver {
  id: string;
  name: string;
  ip: string;
  port: number;
  connected = false;
  power = false;
  volume = 0;
  volumeDb = -80;
  muted = false;
  input = '';

  private socket: net.Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseBuffer = '';
  private pendingQuery: { resolve: Function; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(config: ReceiverConfig) {
    this.id = config.id;
    this.name = config.name;
    this.ip = config.ip;
    this.port = config.port || 23;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket = new net.Socket();
        this.socket.setEncoding('ascii');

        const connectTimeout = setTimeout(() => {
          if (this.socket) this.socket.destroy();
          this.connected = false;
          resolve();
        }, 5000);

        this.socket.connect(this.port, this.ip, () => {
          clearTimeout(connectTimeout);
          this.connected = true;
          console.log('[av-devices] Connected to ' + this.name + ' at ' + this.ip);
          this.queryState();
          resolve();
        });

        this.socket.on('data', (data: string) => {
          this.handleData(data);
        });

        this.socket.on('close', () => {
          this.connected = false;
          this.scheduleReconnect();
        });

        this.socket.on('error', () => {
          clearTimeout(connectTimeout);
          this.connected = false;
          resolve();
        });
      } catch {
        this.connected = false;
        resolve();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 15000);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pendingQuery) {
      clearTimeout(this.pendingQuery.timer);
      this.pendingQuery = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private send(cmd: string): void {
    if (this.socket && this.connected) {
      this.socket.write(cmd + '\r');
    }
  }

  private handleData(data: string): void {
    this.responseBuffer += data;

    let idx: number;
    while ((idx = this.responseBuffer.indexOf('\r')) !== -1) {
      const line = this.responseBuffer.substring(0, idx).trim();
      this.responseBuffer = this.responseBuffer.substring(idx + 1);
      if (line.length > 0) {
        this.parseResponse(line);
      }
    }
  }

  private parseResponse(line: string): void {
    // Power status
    if (line.startsWith('PW')) {
      const val = line.substring(2);
      this.power = val === 'ON';
    }

    // Master volume (MV50 = 50, MV505 = 50.5)
    if (line.startsWith('MV') && !line.startsWith('MVMAX')) {
      const val = line.substring(2);
      if (val.length === 2) {
        this.volume = parseInt(val, 10);
      } else if (val.length === 3) {
        this.volume = parseInt(val, 10) / 10;
      }
      // Marantz: 00 = -80dB, 80 = 0dB, 98 = +18dB
      this.volumeDb = this.volume - 80;
    }

    // Mute status
    if (line.startsWith('MU')) {
      const val = line.substring(2);
      this.muted = val === 'ON';
    }

    // Input source
    if (line.startsWith('SI')) {
      this.input = line.substring(2);
    }

    // Resolve pending query
    if (this.pendingQuery) {
      clearTimeout(this.pendingQuery.timer);
      this.pendingQuery.resolve();
      this.pendingQuery = null;
    }
  }

  queryState(): Promise<void> {
    return new Promise((resolve) => {
      this.send('PW?');
      setTimeout(() => this.send('MV?'), 100);
      setTimeout(() => this.send('MU?'), 200);
      setTimeout(() => this.send('SI?'), 300);

      const timer = setTimeout(() => { resolve(); }, 1500);
      this.pendingQuery = { resolve, timer };
    });
  }

  setPower(on: boolean): void {
    this.send(on ? 'PWON' : 'PWSTANDBY');
    this.power = on;
  }

  setVolume(level: number): void {
    level = Math.max(0, Math.min(98, level));
    if (level % 1 === 0) {
      const cmd = 'MV' + (level < 10 ? '0' : '') + Math.floor(level);
      this.send(cmd);
    } else {
      const whole = Math.floor(level);
      const cmd = 'MV' + (whole < 10 ? '0' : '') + whole + '5';
      this.send(cmd);
    }
    this.volume = level;
    this.volumeDb = level - 80;
  }

  volumeUp(): void { this.send('MVUP'); }
  volumeDown(): void { this.send('MVDOWN'); }

  setMute(muted: boolean): void {
    this.send(muted ? 'MUON' : 'MUOFF');
    this.muted = muted;
  }

  setInput(input: string): void {
    this.send('SI' + input);
    this.input = input;
  }

  toState(): ReceiverState {
    return {
      id: this.id,
      name: this.name,
      ip: this.ip,
      connected: this.connected,
      power: this.power,
      volume: this.volume,
      volumeDb: this.volumeDb,
      muted: this.muted,
      input: this.input,
    };
  }
}

// --- Plugin Class ---

class AvDevicesPlugin extends BasePlugin {
  private receivers: Map<string, MarantzReceiver> = new Map();

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);

    const devices: ReceiverConfig[] = config.devices || config.receivers || [];
    if (!devices.length) this.mockMode = true;
  }

  private getReceiver(id?: string): MarantzReceiver | null {
    if (id) return this.receivers.get(id) || null;
    const first = this.receivers.values().next();
    return first.done ? null : first.value;
  }

  async connect(): Promise<void> {
    if (this.mockMode) {
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[av-devices] Connected in MOCK MODE');
      return;
    }

    const devices: ReceiverConfig[] = this.config.devices || this.config.receivers || [];
    console.log('[av-devices] Connecting to ' + devices.length + ' receivers');

    for (const rc of devices) {
      const receiver = new MarantzReceiver(rc);
      this.receivers.set(rc.id, receiver);
      receiver.connect().catch(() => {});
    }

    this.connected = true;
    this.emit('connected', { mock: false });
  }

  async disconnect(): Promise<void> {
    for (const [, receiver] of this.receivers) {
      receiver.disconnect();
    }
    this.receivers.clear();
    this.connected = false;
    this.emit('disconnected');
    console.log('[av-devices] Disconnected');
  }

  getState(): any {
    const receiverStates: ReceiverState[] = [];
    for (const [, r] of this.receivers) {
      receiverStates.push(r.toState());
    }
    return {
      connected: this.connected,
      mock: this.mockMode,
      receivers: receiverStates,
      knownInputs: KNOWN_INPUTS,
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/av/state
      {
        method: 'GET',
        path: '/api/av/state',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.getState());
        },
      },

      // POST /api/av/power
      {
        method: 'POST',
        path: '/api/av/power',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          const data = body || await parseBody(req);
          const receiver = this.getReceiver(data.id);
          if (!receiver) { jsonResponse(res, { error: 'Receiver not found' }, 404); return; }

          receiver.setPower(data.on);
          jsonResponse(res, { ok: true, power: data.on });
        },
      },

      // POST /api/av/volume
      {
        method: 'POST',
        path: '/api/av/volume',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          const data = body || await parseBody(req);
          const receiver = this.getReceiver(data.id);
          if (!receiver) { jsonResponse(res, { error: 'Receiver not found' }, 404); return; }

          if (data.action === 'up') {
            receiver.volumeUp();
          } else if (data.action === 'down') {
            receiver.volumeDown();
          } else if (data.level !== undefined) {
            receiver.setVolume(data.level);
          } else if (data.volume !== undefined) {
            receiver.setVolume(data.volume);
          }
          jsonResponse(res, { ok: true, volume: receiver.volume, volumeDb: receiver.volumeDb });
        },
      },

      // POST /api/av/mute
      {
        method: 'POST',
        path: '/api/av/mute',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          const data = body || await parseBody(req);
          const receiver = this.getReceiver(data.id);
          if (!receiver) { jsonResponse(res, { error: 'Receiver not found' }, 404); return; }

          receiver.setMute(data.muted);
          jsonResponse(res, { ok: true, muted: data.muted });
        },
      },

      // POST /api/av/input
      {
        method: 'POST',
        path: '/api/av/input',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          const data = body || await parseBody(req);
          const receiver = this.getReceiver(data.id);
          if (!receiver) { jsonResponse(res, { error: 'Receiver not found' }, 404); return; }

          receiver.setInput(data.input);
          jsonResponse(res, { ok: true, input: data.input });
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): AvDevicesPlugin {
  return new AvDevicesPlugin(manifest);
}
