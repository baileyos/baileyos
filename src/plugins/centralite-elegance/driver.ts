// BaileyOS Plugin: Centralite Elegance / LiteJet
// RS-232 serial lighting controller (19200 baud, 8N1)
// Full production protocol embedded directly

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';

// --- Embedded Production Types ---

export interface RelayState {
  relay: number;
  name: string;
  on: boolean;
  level: number;
  dimmable: boolean;
}

export interface SceneState {
  scene: number;
  name: string;
  active: boolean;
}

export interface CentraliteConfig {
  port: string;
  baud?: number;
  relayNames?: Record<number, string>;
  dimmableRelays?: number[];
  sceneNames?: Record<number, string>;
}

// --- Default Relay Names (93 active relays) ---

const DEFAULT_RELAY_NAMES: Record<number, string> = {
  1: "Fan - Bath Mother-in-law",
  2: "Fan - Water Heater",
  3: "Fireplace Accent",
  4: "Flood North",
  5: "Flood South",
  6: "Entry Chandelier",
  7: "Ext East Lights",
  8: "Garage Interior Lights",
  9: "Overhead - Water Heater",
  10: "Kitchn Nook",
  11: "Kitchn Counter",
  12: "Kitchn Undr Cabinet",
  13: "Kitchn Ovr Cabinet",
  14: "Gr8Rm Hallway",
  15: "Serv Hallway",
  16: "Kitchn Wet Bar",
  17: "Mastr Vanity",
  18: "DineRm Overhead",
  19: "Kitchn Cabinet",
  20: "Exterior Accent - Front Porch",
  21: "Breezeway",
  22: "Kitchn Island",
  23: "DineRm Chandelier",
  24: "Kitchn Overhead",
  25: "Ext Garage Lights",
  26: "Mastr Table Lamps",
  27: "Mastr Closet Overhead",
  28: "Mother-in-law Overhead",
  29: "Mastr Loft",
  30: "Mastr Sitting Area",
  31: "Mastr Overhead",
  32: "Mother-in-law Hallway Overhead",
  33: "Mother-in-law Overhead North",
  34: "Mother-in-law Overhead South",
  35: "MastrBath Heated Floor",
  36: "Mother-in-law Hallways",
  37: "SewRm Benches",
  38: "SewRm Overhead",
  39: "Mother-in-law Overhead Bathroom",
  40: "SewRm Fans",
  41: "Coaches",
  42: "Mastr Fans",
  43: "MastrBath",
  44: "MastrBath Towel Bar",
  45: "MastrBath Overhead",
  46: "LivingRm Porch Overhead",
  47: "Ext Street Light",
  49: "Cable Accent - South",
  50: "Mail Overhead",
  51: "Laundry Overhead",
  52: "Cable Accent - North",
  53: "Art",
  54: "Front/Service Door Light",
  55: "LivingRm Overhead",
  56: "Stairway Sconces",
  57: "MediaRm Overhead",
  58: "Concessions Chandelier",
  59: "Office Overhead",
  60: "DownstairsBath Overhead",
  61: "MovieRm Sconce",
  62: "MovieRm Sconce",
  63: "SkyBridge Hallway",
  64: "Entry Overhead",
  65: "Gazebo Power",
  66: "Downstairs - Heated Floor",
  67: "Stairway Treads",
  68: "E-W BRm Hallway",
  69: "East BedRm Overhead",
  70: "West BedRm Table Lamps",
  71: "West BedRm Overhead",
  72: "West BathRm Overhead",
  73: "Concessions Fan",
  74: "Wine Cellar",
  75: "Sconce",
  76: "DownstairsBathRm Fan",
  77: "MovieRm Overhead",
  78: "MovieRm Overhead",
  79: "MovieRm Overhead",
  81: "Concessions Signs",
  82: "MovieRm Soffit",
  84: "MovieRm Starfield",
  85: "GuestBathRm Heated Floor",
  86: "Wet Bar Under Counter",
  87: "Coach South",
  88: "LaundryRm Fan",
  89: "WBathRm Fan",
  90: "Flood East",
  91: "MovieRm Floor",
  92: "Fountain",
  93: "Shade Power",
  94: "Gazebo",
  95: "Concessions Overhead",
  96: "All Exteriors - Garage???",
};

const DEFAULT_DIMMABLE: number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 38, 39,
  41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  59, 60, 61, 62, 63, 64, 65, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76,
  77, 78, 79, 81, 82, 84, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96,
];

const DEFAULT_SCENE_NAMES: Record<number, string> = {
  4: "Overhead Movie Room",
  5: "Garage & Breezeway Light",
  6: "Street Light",
  7: "Stairway Treads",
  8: "Movie Room - Sconces",
  9: "Dining Room Ext Coaches (East)",
  10: "Open",
  11: "Fan - Mother-in-Law Bath",
  12: "Fan - Water Heater",
  13: "Fans - Gym",
  14: "Fans - Master Bathroom",
  15: "Fans - Concessions",
  16: "Fan - Downstairs Bathroom",
  17: "Fans - Laundry Room",
  18: "Fans - West Bathroom",
  19: "Wine Celler - Off",
  20: "Coach and Breezeway",
  21: "Open",
  22: "Hallway & Wet Bar",
  23: "Open",
  24: "Open",
  25: "All Floods",
};

// --- Embedded CentraliteElegance Production Class ---

class CentraliteElegance extends EventEmitter {
  private portPath: string;
  private baud: number;
  private serial: any = null;
  readonly mock: boolean;
  connected = false;

  private relays: Map<number, RelayState> = new Map();
  private scenes: Map<number, SceneState> = new Map();
  private _lastOnLevel: Map<number, number> = new Map();  // remember a dimmer's brightness so "on" restores it
  private _confirmTimer: ReturnType<typeof setTimeout> | null = null;

  // --- ^F state-readback poller. The ^F reply is a bare `ll` level with NO load number,
  // so attribution depends on strict lockstep: one outstanding query at a time. ---
  private _pending: { relay: number; resolve: () => void } | null = null;
  private _sweeping = false;
  private _firstSweep = true;
  private _pollTimer: any = null;

  constructor(cfg: CentraliteConfig) {
    super();
    this.portPath = cfg.port ?? '';
    this.baud = cfg.baud ?? 19200;
    this.mock = !this.portPath;
    this._resetState(cfg);
  }

  private _resetState(cfg: CentraliteConfig) {
    const rnames = Object.keys(cfg.relayNames ?? {}).length ? cfg.relayNames! : DEFAULT_RELAY_NAMES;
    const snames = Object.keys(cfg.sceneNames ?? {}).length ? cfg.sceneNames! : DEFAULT_SCENE_NAMES;
    const dimmable = cfg.dimmableRelays ?? DEFAULT_DIMMABLE;

    for (const [k, v] of Object.entries(rnames)) {
      const relay = Number(k);
      this.relays.set(relay, {
        relay, name: v, on: false, level: 100,
        dimmable: dimmable.includes(relay),
      });
    }
    for (const [k, v] of Object.entries(snames)) {
      const scene = Number(k);
      this.scenes.set(scene, { scene, name: v, active: false });
    }
  }

  connect() {
    if (this.mock) {
      this.connected = true;
      this.emit('connected', { mock: true });
      return;
    }
    this._open();
  }

  disconnect() {
    if (this.serial) {
      try { this.serial.close(); } catch {}
      this.serial = null;
    }
    this.connected = false;
  }

  isMock(): boolean { return this.mock; }
  isConnected(): boolean { return this.connected; }

  getRelays(): RelayState[] { return Array.from(this.relays.values()); }
  getRelay(r: number): RelayState | undefined { return this.relays.get(r); }
  getScenes(): SceneState[] { return Array.from(this.scenes.values()); }
  getScene(s: number): SceneState | undefined { return this.scenes.get(s); }

  getState() {
    return {
      connected: this.connected,
      mock: this.mock,
      relays: this.getRelays(),
      scenes: this.getScenes(),
    };
  }

  setRelay(relay: number, on: boolean) {
    const r = this.relays.get(relay);
    // Dimmable loads (dimmers) DO NOT respond to the relay on/off commands (^A/^B) — only to the dim
    // command (^E). So route them through dim(): off = dim to 0, on = restore last brightness (or full).
    if (r && r.dimmable) {
      if (on) {
        this.dim(relay, this._lastOnLevel.get(relay) || 99);
      } else {
        if (r.level && r.level > 0) this._lastOnLevel.set(relay, r.level);  // remember for next "on"
        this.dim(relay, 0);
      }
      return;
    }
    const n = relay.toString().padStart(3, '0');
    this._send(on ? '^A' + n : '^B' + n);
    this._relayUpdate(relay, { on });
    this._scheduleConfirm();
  }

  dim(relay: number, level: number) {
    const lv = Math.min(99, Math.max(0, Math.round(level)));   // 2-digit level: clamp to 99 (100 would malform ^E)
    const n = relay.toString().padStart(3, '0');
    const d = lv.toString().padStart(2, '0');
    this._send('^E' + n + d + '00');
    this._relayUpdate(relay, { level: lv, on: lv > 0 });
    this._scheduleConfirm();
  }

  // After any control command, re-read real state within a few seconds (vs waiting up to 60s for the
  // sweep) so Bailey reports the TRUE on/off result, not the optimistic guess. Reuses the safe ^F poll.
  private _scheduleConfirm(): void {
    if (this.mock || !this.connected) return;
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    const run = () => {
      this._confirmTimer = null;
      if (this._sweeping) { this._confirmTimer = setTimeout(run, 1000); return; }  // don't collide with the sweep
      this.pollAllLoads().catch(() => {});
    };
    this._confirmTimer = setTimeout(run, 3000);
  }

  setScene(scene: number, active: boolean) {
    const n = scene.toString().padStart(3, '0');
    this._send(active ? '^C' + n : '^D' + n);
    this._sceneUpdate(scene, active);
  }

  queryLoad(relay: number) {
    const n = relay.toString().padStart(3, '0');
    this._send('^F' + n);
  }

  // Query one load and await its `ll` reply (or time out). One outstanding query at a
  // time so the load-number-less reply maps to the correct relay.
  private _queryOne(relay: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._pending && this._pending.relay === relay) this._pending = null;
        resolve();
      };
      // No reply -> keep the relay's prior state (never assume off), clear pending, move on.
      const timer = setTimeout(finish, 300);
      this._pending = { relay, resolve: finish };
      this.queryLoad(relay);
    });
  }

  // Sequentially read every load's real on/level state via ^F.
  async pollAllLoads(): Promise<void> {
    if (this.mock || this._sweeping || !this.connected) return;
    this._sweeping = true;
    try {
      for (const relay of this.relays.keys()) {
        if (!this.connected) break;
        await this._queryOne(relay);
      }
    } finally {
      this._sweeping = false;
      if (this._firstSweep) {
        this._firstSweep = false;
        const on = Array.from(this.relays.values()).filter((r) => r.on).length;
        console.log(`[centralite] first ^F sweep done: ${on}/${this.relays.size} loads report ON`);
      }
    }
  }

  allOff() {
    this.relays.forEach((r, relay) => {
      if (r.dimmable) {                       // dimmers need the dim command, not ^B
        if (r.level && r.level > 0) this._lastOnLevel.set(relay, r.level);
        this.dim(relay, 0);
      } else {
        const n = relay.toString().padStart(3, '0');
        this._send('^B' + n);
        this._relayUpdate(relay, { on: false });
      }
    });
    this.scenes.forEach((_, scene) => {
      this._sceneUpdate(scene, false);
    });
  }

  private _relayUpdate(relay: number, patch: Partial<RelayState>) {
    const r = this.relays.get(relay);
    if (!r) return;
    const updated = { ...r, ...patch };
    this.relays.set(relay, updated);
    // Only emit when on/level actually changed. The 60s ^F poll re-reads all 93
    // loads and would otherwise fire ~93 no-op events/minute (UI flicker + churn).
    if (updated.on !== r.on || updated.level !== r.level) {
      this.emit('relay', updated);
    }
  }

  private _sceneUpdate(scene: number, active: boolean) {
    const s = this.scenes.get(scene);
    if (!s) return;
    const updated = { ...s, active };
    this.scenes.set(scene, updated);
    this.emit('scene', updated);
  }

  private async _open() {
    try {
      const { SerialPort } = await import('serialport') as any;
      const port = new SerialPort({
        path: this.portPath,
        baudRate: this.baud,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false,
      });
      this.serial = port;

      port.open((err: Error | null) => {
        if (err) {
          this.emit('error', err);
          this.serial = null;
          setTimeout(() => this._open(), 5_000);
          return;
        }
        this.connected = true;
        this.emit('connected', { mock: false });
        // Read real panel state now that the port is open (relays Map is already populated).
        setTimeout(() => { this.pollAllLoads().catch(() => {}); }, 500);
        if (!this._pollTimer) {
          this._pollTimer = setInterval(() => { this.pollAllLoads().catch(() => {}); }, 60_000);
        }
      });

      let rxBuf = '';
      port.on('data', (chunk: Buffer) => {
        rxBuf += chunk.toString('ascii');
        let idx: number;
        while ((idx = rxBuf.indexOf('\r')) !== -1) {
          const line = rxBuf.slice(0, idx).trim();
          rxBuf = rxBuf.slice(idx + 1);
          if (line) this._handleRx(line);
        }
      });

      port.on('error', (err: Error) => this.emit('error', err));

      port.on('close', () => {
        this.connected = false;
        this.serial = null;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        this.emit('disconnected');
        setTimeout(() => this._open(), 5_000);
      });
    } catch (err) {
      this.emit('error', new Error('serialport unavailable: ' + err));
    }
  }

  private _handleRx(line: string) {
    // ^F query reply: a bare 2-digit level (00=off, 01-99=on) for the load we just queried.
    // It carries no load number, so it's only meaningful while a query is pending.
    if (this._pending && /^[0-9]{2}$/.test(line)) {
      const relay = this._pending.relay;
      const level = parseInt(line, 10);
      if (this._firstSweep) {
        console.log(`[centralite] ^F${relay.toString().padStart(3, '0')} -> "${line}" (load ${relay} ${level > 0 ? 'ON@' + level : 'off'})`);
      }
      this._relayUpdate(relay, { on: level > 0, level: level > 0 ? level : 0 });
      // A partial brightness (not 0, not full) PROVES this load is a dimmer — self-correct the
      // classification if it was ever flagged straight-relay, so it gets the dim command next time.
      if (level > 0 && level < 99) { const rr = this.relays.get(relay); if (rr && !rr.dimmable) rr.dimmable = true; }
      this._pending.resolve();
      return;
    }

    const c = line.charCodeAt(0);

    // N{load} = load activated (78 = 'N')
    if (c === 78 && line.length === 4) {
      const relay = parseInt(line.slice(1), 10);
      if (relay > 0) this._relayUpdate(relay, { on: true });
      return;
    }

    // F{load} = load deactivated (70 = 'F')
    if (c === 70 && line.length === 4) {
      const relay = parseInt(line.slice(1), 10);
      if (relay > 0) this._relayUpdate(relay, { on: false });
      return;
    }

    // K{load}{level} = dimming event (75 = 'K')
    if (c === 75 && line.length >= 5) {
      const relay = parseInt(line.slice(1, 4), 10);
      const level = parseInt(line.slice(4, 6), 10);
      if (relay > 0) this._relayUpdate(relay, { on: level > 0, level: level || 100 });
      return;
    }
  }

  private _send(data: string) {
    if (this.mock || !this.serial || !this.connected) return;
    this.serial.write(data + '\r', 'ascii');
  }
}

// --- BaileyOS Plugin Wrapper ---

function parseBody(req: IncomingMessage): Promise<any> {
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

class CentraliteElegancePlugin extends BasePlugin {
  private centralite!: CentraliteElegance;

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);
    const cfg: CentraliteConfig = {
      port: mockMode ? '' : (config.port ?? ''),
      baud: config.baud ?? 19200,
      relayNames: config.relayNames,
      dimmableRelays: config.dimmableRelays,
      sceneNames: config.sceneNames,
    };
    this.centralite = new CentraliteElegance(cfg);

    this.centralite.on('relay', (state: RelayState) => {
      this.emit('stateChange', { type: 'relay', ...state });
    });
    this.centralite.on('scene', (state: SceneState) => {
      this.emit('stateChange', { type: 'scene', ...state });
    });
    this.centralite.on('connected', (info: any) => {
      this.connected = true;
      this.emit('connected', info);
    });
    this.centralite.on('disconnected', () => {
      this.connected = false;
      this.emit('disconnected');
    });
    this.centralite.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  async connect(): Promise<void> {
    this.centralite.connect();
  }

  async disconnect(): Promise<void> {
    this.centralite.disconnect();
    this.connected = false;
  }

  getState() {
    return this.centralite.getState();
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/lighting/state',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.centralite.getState());
        },
      },
      {
        method: 'POST',
        path: '/api/lighting/relay/:id',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBody(req);
          const url = req.url ?? '';
          const match = url.match(/\/api\/lighting\/relay\/(\d+)/);
          if (!match) { jsonResponse(res, { error: 'Invalid relay ID' }, 400); return; }
          const relayId = parseInt(match[1], 10);
          const relay = this.centralite.getRelay(relayId);
          if (!relay) { jsonResponse(res, { error: 'Relay ' + relayId + ' not found' }, 404); return; }
          this.centralite.setRelay(relayId, !!body.on);
          jsonResponse(res, { ok: true, relay: relayId, on: !!body.on });
        },
      },
      {
        method: 'POST',
        path: '/api/lighting/dim/:id',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBody(req);
          const url = req.url ?? '';
          const match = url.match(/\/api\/lighting\/dim\/(\d+)/);
          if (!match) { jsonResponse(res, { error: 'Invalid relay ID' }, 400); return; }
          const relayId = parseInt(match[1], 10);
          const relay = this.centralite.getRelay(relayId);
          if (!relay) { jsonResponse(res, { error: 'Relay ' + relayId + ' not found' }, 404); return; }
          if (!relay.dimmable) { jsonResponse(res, { error: 'Relay ' + relayId + ' is not dimmable' }, 400); return; }
          const level = Math.min(100, Math.max(0, Number(body.level) || 0));
          this.centralite.dim(relayId, level);
          jsonResponse(res, { ok: true, relay: relayId, level });
        },
      },
      {
        method: 'POST',
        path: '/api/lighting/all-off',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          this.centralite.allOff();
          jsonResponse(res, { ok: true, action: 'all-off' });
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): CentraliteElegancePlugin {
  return new CentraliteElegancePlugin(manifest);
}
