// MalamaOS Plugin: LG webOS TV
// SSAP protocol over WebSocket for full TV control
// Wake-on-LAN for power on, client-key pairing persistence

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';

// --- SSAP Registration Manifest ---

const SSAP_MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.0.0',
  signed: {
    created: '20240101',
    appId: 'com.malamaos.lg-tv',
    vendorId: 'com.malamaos',
    localizedAppNames: { '': 'MalamaOS LG TV' },
    localizedVendorNames: { '': 'MalamaOS' },
    permissions: [
      'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP',
      'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
      'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
      'CONTROL_INPUT_TV', 'CONTROL_POWER', 'CONTROL_INPUT_TEXT',
      'CONTROL_MOUSE_AND_KEYBOARD', 'READ_APP_STATUS',
      'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
      'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST',
      'WRITE_NOTIFICATION',
    ],
    serial: 'malamaos-001',
  },
  permissions: [
    'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP',
    'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
    'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
    'CONTROL_INPUT_TV', 'CONTROL_POWER', 'CONTROL_INPUT_TEXT',
    'CONTROL_MOUSE_AND_KEYBOARD', 'READ_APP_STATUS',
    'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
    'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST',
    'WRITE_NOTIFICATION',
  ],
};

// --- Types ---

interface TvConfig {
  id: string;
  name: string;
  ip: string;
  mac?: string;
  clientKey?: string;
}

interface TvState {
  id: string;
  name: string;
  ip: string;
  connected: boolean;
  power: boolean;
  volume: number;
  muted: boolean;
  currentInput: string;
  currentApp: string;
}

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

// --- TV Connection Class ---

class TvConnection {
  id: string;
  name: string;
  ip: string;
  mac: string;
  ws: any = null;
  clientKey: string | null = null;
  connected = false;
  registered = false;
  power = false;
  volume = 0;
  muted = false;
  currentInput = '';
  currentApp = '';
  private msgId = 0;
  private pendingRequests: Map<string, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }> = new Map();
  private keyStorePath: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TvConfig, keyStorePath: string) {
    this.id = config.id;
    this.name = config.name;
    this.ip = config.ip;
    this.mac = config.mac || '';
    this.clientKey = config.clientKey || null;
    this.keyStorePath = keyStorePath;
    this.loadClientKey();
  }

  private loadClientKey(): void {
    try {
      const keyFile = path.join(this.keyStorePath, this.id + '.key');
      if (fs.existsSync(keyFile)) {
        this.clientKey = fs.readFileSync(keyFile, 'utf-8').trim();
      }
    } catch { /* no stored key */ }
  }

  private saveClientKey(key: string): void {
    try {
      if (!fs.existsSync(this.keyStorePath)) {
        fs.mkdirSync(this.keyStorePath, { recursive: true });
      }
      fs.writeFileSync(path.join(this.keyStorePath, this.id + '.key'), key);
    } catch (e) {
      console.error('[lg-tv] Failed to save client key:', e);
    }
  }

  async connect(): Promise<void> {
    return new Promise(async (resolve) => {
      try {
        let WebSocket: any;
        try {
          WebSocket = (await import('ws')).default || (await import('ws'));
        } catch {
          console.error('[lg-tv] ws module not available');
          resolve();
          return;
        }

        const url = 'ws://' + this.ip + ':3001';
        this.ws = new WebSocket(url);

        const connectTimeout = setTimeout(() => {
          if (this.ws) {
            try { this.ws.close(); } catch {}
          }
          this.connected = false;
          resolve();
        }, 5000);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.connected = true;
          this.register();
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.registered = false;
          this.scheduleReconnect();
        });

        this.ws.on('error', () => {
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
    }, 10000);
  }

  private register(): void {
    const payload: any = {
      type: 'register',
      id: 'register_0',
      payload: {
        pairingType: 'PROMPT',
        manifest: SSAP_MANIFEST,
      },
    };
    if (this.clientKey) {
      payload.payload['client-key'] = this.clientKey;
    }
    this.wsSend(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Registration response
      if (msg.id === 'register_0') {
        if (msg.type === 'registered' && msg.payload && msg.payload['client-key']) {
          this.clientKey = msg.payload['client-key'];
          this.saveClientKey(this.clientKey!);
          this.registered = true;
          this.power = true;
          this.subscribeVolume();
          this.subscribeCurrentApp();
          console.log('[lg-tv] Registered with ' + this.name);
        }
        return;
      }

      // Handle pending request responses
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg.payload || {});
      }

      // Handle subscription updates
      if (msg.payload) {
        if (msg.payload.volume !== undefined) {
          this.volume = msg.payload.volume;
        }
        if (msg.payload.muted !== undefined) {
          this.muted = msg.payload.muted;
        }
        if (msg.payload.appId !== undefined) {
          this.currentApp = msg.payload.appId;
        }
      }
    } catch { /* malformed message */ }
  }

  private wsSend(data: string): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(data);
    }
  }

  sendCommand(uri: string, payload: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.registered) {
        reject(new Error('TV not connected'));
        return;
      }

      const id = 'msg_' + (++this.msgId);
      const msg = {
        type: 'request',
        id,
        uri,
        payload,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Command timeout'));
      }, 5000);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.wsSend(JSON.stringify(msg));
    });
  }

  private subscribeVolume(): void {
    this.wsSend(JSON.stringify({
      type: 'subscribe',
      id: 'sub_volume',
      uri: 'ssap://audio/getVolume',
    }));
  }

  private subscribeCurrentApp(): void {
    this.wsSend(JSON.stringify({
      type: 'subscribe',
      id: 'sub_app',
      uri: 'ssap://com.webos.applicationManager/getForegroundAppInfo',
    }));
  }

  // Wake-on-LAN: send magic packet to power on TV
  sendWOL(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.mac) {
        reject(new Error('No MAC address configured'));
        return;
      }

      const macBytes = Buffer.from(this.mac.replace(/[:-]/g, ''), 'hex');
      const magicPacket = Buffer.alloc(102);
      for (let i = 0; i < 6; i++) magicPacket[i] = 0xff;
      for (let i = 0; i < 16; i++) macBytes.copy(magicPacket, 6 + i * 6);

      const socket = dgram.createSocket('udp4');
      socket.once('error', (err) => { socket.close(); reject(err); });
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
          socket.close();
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnecting'));
    }
    this.pendingRequests.clear();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.registered = false;
  }

  toState(): TvState {
    return {
      id: this.id,
      name: this.name,
      ip: this.ip,
      connected: this.connected && this.registered,
      power: this.power,
      volume: this.volume,
      muted: this.muted,
      currentInput: this.currentInput,
      currentApp: this.currentApp,
    };
  }
}

// --- Plugin Class ---

class LgTvPlugin extends BasePlugin {
  private tvs: Map<string, TvConnection> = new Map();
  private keyStorePath: string = '';

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);

    const tvConfigs: TvConfig[] = config.tvs || [];
    if (!tvConfigs.length) this.mockMode = true;

    this.keyStorePath = config.keyStorePath ||
      path.join(process.cwd(), 'data', 'lg-tv-keys');
  }

  private getTv(id?: string): TvConnection | null {
    if (id) return this.tvs.get(id) || null;
    const first = this.tvs.values().next();
    return first.done ? null : first.value;
  }

  async connect(): Promise<void> {
    if (this.mockMode) {
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[lg-tv] Connected in MOCK MODE');
      return;
    }

    const tvConfigs: TvConfig[] = this.config.tvs || [];
    console.log('[lg-tv] Connecting to ' + tvConfigs.length + ' TVs');

    for (const tvConf of tvConfigs) {
      const conn = new TvConnection(tvConf, this.keyStorePath);
      this.tvs.set(tvConf.id, conn);
      conn.connect().catch(() => {});
    }

    this.connected = true;
    this.emit('connected', { mock: false });
  }

  async disconnect(): Promise<void> {
    for (const [, tv] of this.tvs) {
      tv.disconnect();
    }
    this.tvs.clear();
    this.connected = false;
    this.emit('disconnected');
    console.log('[lg-tv] Disconnected');
  }

  getState(): any {
    const tvStates: TvState[] = [];
    for (const [, tv] of this.tvs) {
      tvStates.push(tv.toState());
    }
    return {
      connected: this.connected,
      mock: this.mockMode,
      tvs: tvStates,
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/tv/state
      {
        method: 'GET',
        path: '/api/tv/state',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.getState());
        },
      },

      // POST /api/tv/power
      {
        method: 'POST',
        path: '/api/tv/power',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          try {
            const data = body || await parseBody(req);
            const tv = this.getTv(data.id);
            if (!tv) { jsonResponse(res, { error: 'TV not found' }, 404); return; }

            if (data.on) {
              await tv.sendWOL();
              setTimeout(() => tv.connect(), 5000);
              jsonResponse(res, { ok: true, action: 'wol_sent' });
            } else {
              await tv.sendCommand('ssap://system/turnOff');
              tv.power = false;
              jsonResponse(res, { ok: true, action: 'power_off' });
            }
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },

      // POST /api/tv/volume
      {
        method: 'POST',
        path: '/api/tv/volume',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          try {
            const data = body || await parseBody(req);
            const tv = this.getTv(data.id);
            if (!tv) { jsonResponse(res, { error: 'TV not found' }, 404); return; }

            if (data.action === 'up') {
              await tv.sendCommand('ssap://audio/volumeUp');
            } else if (data.action === 'down') {
              await tv.sendCommand('ssap://audio/volumeDown');
            } else if (data.level !== undefined) {
              await tv.sendCommand('ssap://audio/setVolume', { volume: data.level });
              tv.volume = data.level;
            }
            jsonResponse(res, { ok: true, volume: tv.volume });
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },

      // POST /api/tv/mute
      {
        method: 'POST',
        path: '/api/tv/mute',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          try {
            const data = body || await parseBody(req);
            const tv = this.getTv(data.id);
            if (!tv) { jsonResponse(res, { error: 'TV not found' }, 404); return; }

            await tv.sendCommand('ssap://audio/setMute', { mute: data.muted });
            tv.muted = data.muted;
            jsonResponse(res, { ok: true, muted: tv.muted });
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },

      // POST /api/tv/input
      {
        method: 'POST',
        path: '/api/tv/input',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          try {
            const data = body || await parseBody(req);
            const tv = this.getTv(data.id);
            if (!tv) { jsonResponse(res, { error: 'TV not found' }, 404); return; }

            await tv.sendCommand('ssap://tv/switchInput', { inputId: data.inputId });
            tv.currentInput = data.inputId;
            jsonResponse(res, { ok: true, input: data.inputId });
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },

      // POST /api/tv/app
      {
        method: 'POST',
        path: '/api/tv/app',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          try {
            const data = body || await parseBody(req);
            const tv = this.getTv(data.id);
            if (!tv) { jsonResponse(res, { error: 'TV not found' }, 404); return; }

            await tv.sendCommand('ssap://system.launcher/launch', { id: data.appId });
            jsonResponse(res, { ok: true, app: data.appId });
          } catch (e: any) {
            jsonResponse(res, { error: e.message }, 500);
          }
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): LgTvPlugin {
  return new LgTvPlugin(manifest);
}
