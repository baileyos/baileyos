// BaileyOS Plugin: ELK M1 Security Panel
// ASCII messages over TCP (default port 2101 on M1XEP module)
// Full production protocol embedded directly

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import { createConnection, type Socket } from 'net';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { ForgeTLSSocket } from './forge-tls';

// --- Embedded Production Types ---

export type ArmLevel =
  | 'disarmed' | 'away' | 'stay' | 'stay-instant'
  | 'night' | 'night-instant' | 'vacation';

export type AlarmStatus =
  | 'none' | 'entry-delay' | 'abort-delay'
  | 'fire' | 'medical' | 'police' | 'burglar';

export type ZoneStatus = 'normal' | 'violated' | 'bypassed' | 'trouble' | 'alarm';

export interface ElkZone {
  zone: number;
  name: string;
  status: ZoneStatus;
  partition: number;
}

export interface ElkArea {
  area: number;
  name: string;
  armed: ArmLevel;
  alarm: AlarmStatus;
  ready: boolean;
}

export interface ElkOutput {
  output: number;
  name: string;
  active: boolean;
}

export interface ElkEvent {
  ts: number;
  text: string;
  type: 'arm' | 'disarm' | 'zone' | 'alarm' | 'system';
}

export interface ElkConfig {
  host: string;
  port?: number;
  code?: string;
  secureUser?: string;
  securePass?: string;
  zoneNames?: Record<number, string>;
  areaNames?: Record<number, string>;
  outputNames?: Record<number, string>;
}

// --- Protocol Constants ---

const ARM_LEVELS: Record<string, ArmLevel> = {
  '0': 'disarmed', '1': 'away', '2': 'stay', '3': 'stay-instant',
  '4': 'night', '5': 'night-instant', '6': 'vacation',
};

const ARM_CODES: Record<ArmLevel, string> = {
  disarmed: '0', away: '1', stay: '2', 'stay-instant': '3',
  night: '4', 'night-instant': '5', vacation: '6',
};

const ALARM_STATUSES: Record<string, AlarmStatus> = {
  '0': 'none', '1': 'entry-delay', '2': 'abort-delay',
  '3': 'fire', '4': 'medical', '5': 'police', '6': 'burglar',
};

const ZONE_STATUSES: Record<string, ZoneStatus> = {
  '0': 'normal', '1': 'violated', '2': 'bypassed',
  '3': 'trouble', '4': 'alarm', '5': 'trouble',
};

const DEFAULT_ZONE_NAMES: Record<number, string> = {
  1: 'Front Door', 2: 'Back Door', 3: 'Garage Door',
  4: 'Master Bedroom Window', 5: 'Living Room Motion',
  6: 'Kitchen Motion', 7: 'Basement Motion', 8: 'Side Door',
  9: 'Smoke Detector', 10: 'CO Detector',
};

const DEFAULT_AREA_NAMES: Record<number, string> = {
  1: 'Home',
};

// --- Protocol Helpers ---

function elkChecksum(msg: string): string {
  let sum = 0;
  for (const c of msg) sum += c.charCodeAt(0);
  return ((~sum + 1) & 0xFF).toString(16).toUpperCase().padStart(2, '0');
}

function buildMsg(cmd: string, data = ''): string {
  const inner = cmd + data + '00';
  const ll = (2 + inner.length).toString(16).toUpperCase().padStart(2, '0');
  const body = ll + inner;
  return body + elkChecksum(body) + '\r\n';
}

// --- Embedded ElkM1 Production Class ---

class ElkM1 extends EventEmitter {
  private host: string;
  private port: number;
  private defaultCode: string;
  private secureUser: string;
  private securePass: string;
  private socket: Socket | null = null;
  private rxBuf = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  readonly mock: boolean;
  connected = false;

  private zones: Map<number, ElkZone> = new Map();
  private areas: Map<number, ElkArea> = new Map();
  private outputs: Map<number, ElkOutput> = new Map();
  private eventLog: ElkEvent[] = [];

  constructor(cfg: ElkConfig) {
    super();
    this.host = cfg.host ?? '';
    this.port = cfg.port ?? 2101;
    this.defaultCode = cfg.code ?? '000000';
    this.secureUser = cfg.secureUser ?? '';
    this.securePass = cfg.securePass ?? '';
    this.mock = !this.host;
    this._resetState(cfg);
  }

  private _resetState(cfg: ElkConfig) {
    const znames = Object.keys(cfg.zoneNames ?? {}).length ? cfg.zoneNames! : DEFAULT_ZONE_NAMES;
    const anames = Object.keys(cfg.areaNames ?? {}).length ? cfg.areaNames! : DEFAULT_AREA_NAMES;
    const onames = cfg.outputNames ?? {};

    for (const [k, v] of Object.entries(znames)) {
      const zone = Number(k);
      this.zones.set(zone, { zone, name: v, status: 'normal', partition: 1 });
    }
    for (const [k, v] of Object.entries(anames)) {
      const area = Number(k);
      this.areas.set(area, { area, name: v, armed: 'disarmed', alarm: 'none', ready: true });
    }
    for (const [k, v] of Object.entries(onames)) {
      const output = Number(k);
      this.outputs.set(output, { output, name: v, active: false });
    }
  }

  // -- Public API --

  connect() {
    if (this.mock) {
      this.connected = true;
      this.emit('connected', { mock: true });
      this._addEvent('system', 'ELK M1 running in simulation mode');
      return;
    }
    this._open();
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  isMock(): boolean { return this.mock; }
  isConnected(): boolean { return this.connected; }

  getZones(): ElkZone[] { return Array.from(this.zones.values()); }
  getZone(z: number): ElkZone | undefined { return this.zones.get(z); }
  getAreas(): ElkArea[] { return Array.from(this.areas.values()); }
  getArea(a: number): ElkArea | undefined { return this.areas.get(a); }
  getOutputs(): ElkOutput[] { return Array.from(this.outputs.values()); }
  getEvents(): ElkEvent[] { return this.eventLog.slice(-50); }

  getState() {
    return {
      connected: this.connected,
      mock: this.mock,
      areas: this.getAreas(),
      zones: this.getZones(),
      outputs: this.getOutputs(),
      events: this.getEvents(),
    };
  }

  arm(area: number, level: ArmLevel, code?: string) {
    const c = (code ?? this.defaultCode).padStart(6, '0').slice(-6);
    if (this.mock) {
      const a = this.areas.get(area);
      if (a) {
        const updated: ElkArea = { ...a, armed: level, alarm: 'none', ready: level !== 'disarmed' };
        this.areas.set(area, updated);
        const action = level === 'disarmed' ? 'disarmed' : 'armed ' + level;
        this._addEvent(level === 'disarmed' ? 'disarm' : 'arm', a.name + ' ' + action);
        this.emit('area', updated);
      }
      return;
    }
    this._send(buildMsg('a' + area, ARM_CODES[level] + c));
  }

  disarm(area: number, code?: string) {
    this.arm(area, 'disarmed', code);
  }

  controlOutput(output: number, active: boolean, seconds = 0) {
    if (this.mock) {
      const o = this.outputs.get(output);
      if (o) {
        const updated = { ...o, active };
        this.outputs.set(output, updated);
        this._addEvent('system', 'Output ' + output + ' (' + o.name + ') turned ' + (active ? 'on' : 'off'));
        this.emit('output', updated);
      }
      return;
    }
    const n = output.toString().padStart(3, '0');
    const t = seconds.toString().padStart(5, '0');
    this._send(buildMsg('cn', n + (active ? '1' : '0') + t));
  }

  activateTask(task: number) {
    if (this.mock) {
      this._addEvent('system', 'Task ' + task + ' activated');
      return;
    }
    this._send(buildMsg('tn', task.toString().padStart(3, '0')));
  }

  bypassZone(zone: number, area: number, code?: string) {
    const c = (code ?? this.defaultCode).padStart(6, '0').slice(-6);
    if (this.mock) {
      const z = this.zones.get(zone);
      if (z) {
        const newStatus: ZoneStatus = z.status === 'bypassed' ? 'normal' : 'bypassed';
        const updated = { ...z, status: newStatus };
        this.zones.set(zone, updated);
        this._addEvent('zone', z.name + ': ' + newStatus);
        this.emit('zone', updated);
      }
      return;
    }
    this._send(buildMsg('zb', zone.toString().padStart(3, '0') + area.toString() + c));
  }

  requestStatus() {
    if (this.mock) return;
    this._send(buildMsg('as')); // arming status
    this._send(buildMsg('zs')); // zone status
  }

  // -- Internals --

  private _addEvent(type: ElkEvent['type'], text: string, ts?: number) {
    const evt: ElkEvent = { ts: ts ?? Date.now(), text, type };
    this.eventLog.push(evt);
    if (this.eventLog.length > 100) this.eventLog.shift();
    this.emit('event', evt);
  }

  private _authState: 'none' | 'wait-user' | 'wait-pass' | 'done' = 'none';
  // true after first AS response per connection â€” suppresses false arm events on initial sync
  private _stateSynced = false;
  // timestamp from the most recent EE/LD message (panel's own clock)
  private _lastPanelEventTs: number | null = null;

  private _open() {
    // Cleanly retire any previous socket so a late ECONNRESET on it can't crash
    // the process or schedule a spurious extra reconnect (the flaky-M1XEP churn).
    if (this.socket) {
      const old = this.socket;
      this.socket = null;
      old.removeAllListeners();
      old.on('error', () => {}); // swallow any late error from the retired socket
      old.destroy();
    }
    // Port 2601 is the M1XEP's TLS/secure port â€” plain TCP to it gets RESET (the
    // ECONNRESET storm). Use TLS for 2601 regardless of creds; only run the
    // interactive Username/Password login when secureUser is actually configured
    // (the panel accepts ASCII right after the TLS handshake otherwise).
    const forceSecure = !!this.secureUser || this.port === 2601;
    const needsAuth = !!this.secureUser;
    this._authState = needsAuth ? 'wait-user' : 'done';

    const sock: Socket = forceSecure
      ? new ForgeTLSSocket(this.host, this.port) as any
      : createConnection({ host: this.host, port: this.port });
    this.socket = sock;

    sock.on(forceSecure ? 'secureConnect' : 'connect', () => {
      this.rxBuf = '';
      this._stateSynced = false;
      if (!needsAuth) {
        this.connected = true;
        this.emit('connected', { mock: false });
        this.requestStatus();
        // Send status request every 25s to keep connection alive (avoids 30s timeout churn)
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = setInterval(() => this.requestStatus(), 25_000);
      }
    });

    sock.on('data', (chunk: Buffer) => {
      const text = chunk.toString('ascii');

      // Handle M1XEP auth prompts
      if (this._authState === 'wait-user' && text.includes('Username:')) {
        this.socket?.write(this.secureUser + '\r\n', 'ascii');
        this._authState = 'wait-pass';
        return;
      }
      if (this._authState === 'wait-pass' && text.includes('Password:')) {
        this.socket?.write(this.securePass + '\r\n', 'ascii');
        return;
      }
      if (this._authState !== 'done' && text.includes('Login successful')) {
        this._authState = 'done';
        this.connected = true;
        this.emit('connected', { mock: false });
        this._addEvent('system', 'Connected to ELK M1 (authenticated)');
        setTimeout(() => this.requestStatus(), 300);
        return;
      }
      if (this._authState !== 'done' && text.includes('not found')) {
        this._addEvent('system', 'M1XEP authentication failed');
        this.socket?.destroy();
        return;
      }
      if (this._authState !== 'done') return;

      this.rxBuf += text;
      this._drain();
    });

    sock.on('error', (err: Error) => {
      console.warn('[elk] Connection error:', err.message);
      this._addEvent('system', 'Connection error: ' + err.message);
    });

    sock.on('close', () => {
      this.connected = false;
      if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    sock.setTimeout(120_000);
    sock.on('timeout', () => sock.destroy());
  }

  private _drain() {
    const lines = this.rxBuf.split('\r\n');
    this.rxBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length >= 8) this._parseMsg(line);
    }
  }

  private _parseMsg(msg: string) {
    const cmd = msg.slice(2, 4).toUpperCase();
    const data = msg.slice(4, msg.length - 4);

    switch (cmd) {
      case 'AS': this._parseArmingStatus(data); break;
      case 'ZS': this._parseZoneStatus(data); break;
      case 'ZC': this._parseZoneChange(data); break;
      case 'EE': this._parsePanelEvent(data); if (!this.mock) this.requestStatus(); break;
      case 'LD': this._parsePanelEvent(data); break;
      case 'IC': this._addEvent('system', 'Invalid code â€” check alarm code in config'); break;
    }
  }

  private _parseArmingStatus(data: string) {
    if (data.length < 8) return;
    for (let i = 0; i < 8; i++) {
      const armed = ARM_LEVELS[data[i]] ?? 'disarmed';
      const alarm = ALARM_STATUSES[data[i + 16] ?? '0'] ?? 'none';
      const a = this.areas.get(i + 1);
      if (a) {
        const updated: ElkArea = { ...a, armed, alarm };
        this.areas.set(i + 1, updated);
        this.emit('area', updated);
        // Only log arm/disarm transitions after initial sync to avoid false events on reconnect.
        // Use panel's timestamp from EE/LD if it arrived recently (within 5s), else wall clock.
        if (this._stateSynced && armed !== a.armed) {
          const action = armed === 'disarmed' ? 'disarmed' : 'armed ' + armed;
          const ts = this._lastPanelEventTs ?? undefined;
          this._lastPanelEventTs = null;
          this._addEvent(armed === 'disarmed' ? 'disarm' : 'arm', a.name + ' ' + action, ts);
        }
        if (alarm !== 'none' && alarm !== a.alarm) {
          this._addEvent('alarm', 'Area ' + (i + 1) + ' alarm: ' + alarm);
        }
      }
    }
    this._stateSynced = true;
  }

  private _parsePanelEvent(data: string) {
    // EE/LD format: qualifier(1) + zone_user(3) + area(1) + hour(2) + min(2) + month(2) + day(2) + year(2) + ...
    // OR without qualifier: zone_user(3) + area(1) + hour(2) + min(2) + month(2) + day(2) + year(2) + ...
    // Try to extract h/m/month/day/year and convert to a JS timestamp for the event log.
    // Two known positions depending on firmware (qualifier byte may or may not be present).
    const tryParseAt = (offset: number): number | null => {
      if (data.length < offset + 10) return null;
      const h = parseInt(data.slice(offset, offset + 2), 10);
      const m = parseInt(data.slice(offset + 2, offset + 4), 10);
      const mo = parseInt(data.slice(offset + 4, offset + 6), 10);
      const d = parseInt(data.slice(offset + 6, offset + 8), 10);
      const yr = 2000 + parseInt(data.slice(offset + 8, offset + 10), 10);
      if (h > 23 || m > 59 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      const panelDate = new Date(yr, mo - 1, d, h, m, 0, 0);
      return panelDate.getTime();
    };
    // event_code(3) + qualifier(1) + zone_user(3) + area(1) â†’ timestamp starts at offset 8
    // event_code(3) + zone_user(3) + area(1)                â†’ timestamp starts at offset 7
    const ts = tryParseAt(8) ?? tryParseAt(7);
    if (ts !== null) this._lastPanelEventTs = ts;
  }

  private _parseZoneStatus(data: string) {
    for (let i = 0; i < Math.min(data.length, 208); i++) {
      const z = this.zones.get(i + 1);
      if (z) {
        const status = ZONE_STATUSES[data[i]] ?? 'normal';
        if (status !== z.status) {
          const updated = { ...z, status };
          this.zones.set(i + 1, updated);
          this.emit('zone', updated);
        }
      }
    }
  }

  private _parseZoneChange(data: string) {
    if (data.length < 4) return;
    const zone = parseInt(data.slice(0, 3), 10);
    const status = ZONE_STATUSES[data[3]] ?? 'normal';
    const z = this.zones.get(zone);
    if (z && status !== z.status) {
      const updated = { ...z, status };
      this.zones.set(zone, updated);
      this._addEvent('zone', z.name + ': ' + status);
      this.emit('zone', updated);
    }
  }

  private _scheduleReconnect() {
    if (this.mock || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, 5_000);
  }

  private _send(msg: string) {
    if (!this.socket || !this.connected) return;
    this.socket.write(msg, 'ascii');
  }
}

// --- BaileyOS Plugin Wrapper ---

function parseBodyFromReq(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

class ElkM1Plugin extends BasePlugin {
  private elk!: ElkM1;

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);
    const cfg: ElkConfig = {
      host: mockMode ? '' : (config.host ?? ''),
      port: config.port ?? 2101,
      code: config.code ?? '000000',
      secureUser: config.secureUser,
      securePass: config.securePass,
      zoneNames: config.zoneNames,
      areaNames: config.areaNames,
      outputNames: config.outputNames,
    };
    this.elk = new ElkM1(cfg);

    this.elk.on('area', (state: ElkArea) => {
      this.emit('stateChange', { type: 'area', ...state });
    });
    this.elk.on('zone', (state: ElkZone) => {
      this.emit('stateChange', { type: 'zone', ...state });
    });
    this.elk.on('event', (evt: ElkEvent) => {
      this.emit('stateChange', { type: 'event', ...evt });
    });
    this.elk.on('connected', (info: any) => {
      this.connected = true;
      this.emit('connected', info);
    });
    this.elk.on('disconnected', () => {
      this.connected = false;
      this.emit('disconnected');
    });
    this.elk.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  async connect(): Promise<void> {
    this.elk.connect();
  }

  async disconnect(): Promise<void> {
    this.elk.disconnect();
    this.connected = false;
  }

  getState() {
    return this.elk.getState();
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/security/state',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.elk.getState());
        },
      },
      {
        method: 'POST',
        path: '/api/security/arm',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const area = Number(body.area) || 1;
          const level = (body.level as ArmLevel) || 'away';
          const validLevels: ArmLevel[] = ['away', 'stay', 'stay-instant', 'night', 'night-instant', 'vacation'];
          if (!validLevels.includes(level)) {
            jsonResponse(res, { error: 'Invalid arm level: ' + level }, 400);
            return;
          }
          this.elk.arm(area, level, body.code);
          jsonResponse(res, { ok: true, area, level });
        },
      },
      {
        method: 'POST',
        path: '/api/security/disarm',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const area = Number(body.area) || 1;
          this.elk.disarm(area, body.code);
          jsonResponse(res, { ok: true, area, action: 'disarm' });
        },
      },
      {
        method: 'POST',
        path: '/api/security/zone/:zone/bypass',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const url = req.url ?? '';
          const match = url.match(/\/api\/security\/zone\/(\d+)\/bypass/);
          if (!match) { jsonResponse(res, { error: 'Invalid zone' }, 400); return; }
          const zone = parseInt(match[1], 10);
          const area = Number(body.area) || 1;
          this.elk.bypassZone(zone, area, body.code);
          jsonResponse(res, { ok: true, zone, action: 'bypass' });
        },
      },
      {
        method: 'POST',
        path: '/api/security/output/:output',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const url = req.url ?? '';
          const match = url.match(/\/api\/security\/output\/(\d+)/);
          if (!match) { jsonResponse(res, { error: 'Invalid output' }, 400); return; }
          const output = parseInt(match[1], 10);
          const active = !!body.active;
          const seconds = Number(body.seconds) || 0;
          this.elk.controlOutput(output, active, seconds);
          jsonResponse(res, { ok: true, output, active, seconds });
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): ElkM1Plugin {
  return new ElkM1Plugin(manifest);
}
