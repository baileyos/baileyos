// BaileyOS Plugin: HTD Lync 12
// 12-zone whole-home audio controller
// Protocol: 6-byte binary commands over TCP via GW-SL1 gateway (default port 10006)
// Full production protocol embedded directly
// FIXED 2026-05-29: Corrected parseFrame byte offsets, volume/source/bass/treble commands

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import { createConnection, type Socket } from 'net';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';

// --- Embedded Production Types ---

export interface ZoneState {
  zone: number;
  name: string;
  power: boolean;
  mute: boolean;
  source: number;   // display index (1=In1, 2=In2); maps to HTD source via sourceMap
  volume: number;   // 0-196 (raw GW-SL1 value, each UP/DOWN step = 1)
  bass: number;     // -14 to +14 (0x80 = center)
  treble: number;   // -14 to +14 (0x80 = center)
}

export interface HtdConfig {
  host: string;
  port?: number;
  zones?: number;
  zoneNames?: string[];
  // sourceMap[i] = actual HTD source number for display index i+1.
  // e.g. [14, 15] means "In 1" -> HTD src 14, "In 2" -> HTD src 15.
  sourceMap?: number[];
}

export const DEFAULT_ZONE_NAMES = [
  'Zone 1', 'Zone 2', 'Zone 3', 'Zone 4',
  'Zone 5', 'Zone 6', 'Zone 7', 'Zone 8',
  'Zone 9', 'Zone 10', 'Zone 11', 'Zone 12',
];

export const SOURCE_NAMES = [
  'Source 1', 'Source 2', 'Source 3',
  'Source 4', 'Source 5', 'Source 6',
];

// --- Protocol Constants ---

const CMD_QUERY    = 0x05;
const CMD_CONTROL  = 0x04;
const CMD_VOLUME   = 0x15;  // absolute "Volume Setting Value Control"; reserved byte 0x00; data = 0x44 + vol(0-60)
const CMD_TREBLE   = 0x17;  // absolute Treble Setting Control (Lync protocol); reserved 0x00; data = 0x80 + level (-10..+10)
const CMD_BASS     = 0x18;  // absolute Bass Setting Control (Lync protocol);   reserved 0x00; data = 0x80 + level (-10..+10)

// GW-SL1 control data bytes (used with CMD_CONTROL)
const CTRL_POWER_ON  = 0x57;
const CTRL_POWER_OFF = 0x58;
const CTRL_MUTE_ON   = 0x1E;
const CTRL_MUTE_OFF  = 0x1F;
const CTRL_VOL_UP    = 0x04;
const CTRL_VOL_DOWN  = 0x05;
const CTRL_BASS_UP   = 0x26;
const CTRL_BASS_DOWN = 0x27;
const CTRL_TREBLE_UP = 0x28;
const CTRL_TREBLE_DOWN = 0x29;
const CTRL_DND_ON    = 0x59;
const CTRL_DND_OFF   = 0x5A;

const RESPONSE_LEN = 14;

// --- Protocol Helpers ---

function buildCmd(zone: number, cmd: number, d1: number): Buffer {
  // GW-SL1 protocol: 6-byte frames
  const b = Buffer.alloc(6);
  b[0] = 0x02; b[1] = 0x00; b[2] = zone;
  b[3] = cmd;  b[4] = d1;
  b[5] = (b[0] + b[1] + b[2] + b[3] + b[4]) & 0xFF;
  return b;
}

function parseFrame(data: Buffer, names: string[]): ZoneState | null {
  // GW-SL1 Response Frame (14 bytes):
  // 02 00 ZZ 05 FLAGS 00 00 XX SRC VOL BASS TREBLE BAL CHKSUM
  //  0  1  2  3   4    5  6  7   8   9   10    11   12    13
  if (data.length < RESPONSE_LEN) return null;
  if (data[0] !== 0x02 || data[1] !== 0x00) return null;
  const zone = data[2];
  if (zone < 1 || zone > 12) return null;
  const flags = data[4];
  const power = !!(flags & 0x01);
  const mute = !!(flags & 0x02);
  const source = data[8];
  const volume = data[9];  // raw volume byte (GW-SL1 range observed: 0-196)
  // Reply: Data7 (data[10]) = TREBLE, Data8 (data[11]) = BASS — BOTH signed bytes (0x00=0, 0x0A=+10, 0xF6=-10).
  // (Previously these were swapped and offset by 0x80, which produced the bogus -14 readback.)
  const treble = data[10] < 0x80 ? data[10] : data[10] - 256;
  const bass = data[11] < 0x80 ? data[11] : data[11] - 256;
  return {
    zone,
    name: names[zone - 1] ?? ('Zone ' + zone),
    power,
    mute,
    source: source >= 1 ? source : 1,  // raw HTD source; remapped to display index in _drain
    volume: Math.max(0, volume),
    bass: Math.min(10, Math.max(-10, bass)),
    treble: Math.min(10, Math.max(-10, treble)),
  };
}

function _delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// The GW-SL1 reports volume as a raw byte = 196 (0xC4) + actualVolume, where actualVolume
// is the 0-60 scale the HTD app shows. Max (60) wraps the byte to 0x00, so use mod-256.
// DISPLAY-ONLY: applied at output boundaries; internal state stays raw so the write path
// (setVolume) is untouched. A converted value >60 is out-of-range garbage -> show 0.
function toDisplayVolume(raw: number): number {
  const v = (raw - 196) & 0xFF;
  return v <= 60 ? v : 0;
}

// --- Embedded HtdLync12 Production Class ---

class HtdLync12 extends EventEmitter {
  private host: string;
  private port: number;
  private zoneCount: number;
  private zoneNames: string[];
  private sourceMap: number[];  // display index i+1 -> HTD source sourceMap[i]
  private socket: Socket | null = null;
  private rxBuf: Buffer = Buffer.alloc(0);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mock: boolean;
  private state: Map<number, ZoneState> = new Map();
  connected = false;

  constructor(config: HtdConfig) {
    super();
    this.host      = config.host ?? '';
    this.port      = config.port ?? 10006;
    this.zoneCount = config.zones ?? 12;
    this.zoneNames = config.zoneNames?.length
      ? config.zoneNames
      : DEFAULT_ZONE_NAMES;
    this.sourceMap = config.sourceMap ?? [];
    this.mock = !this.host;
    this._resetState();
  }

  // Translate HTD hardware source number -> display index (1, 2, ...).
  // If no sourceMap configured, or source not in map, returns raw HTD number.
  private _htdToDisplay(htdSrc: number): number {
    if (!this.sourceMap.length) return htdSrc;
    const idx = this.sourceMap.indexOf(htdSrc);
    return idx >= 0 ? idx + 1 : htdSrc;
  }

  // Translate display index (1, 2, ...) -> HTD hardware source number.
  private _displayToHtd(displayIdx: number): number {
    if (!this.sourceMap.length) return displayIdx;
    return this.sourceMap[displayIdx - 1] ?? displayIdx;
  }

  private _resetState() {
    for (let z = 1; z <= this.zoneCount; z++) {
      this.state.set(z, {
        zone:   z,
        name:   this.zoneNames[z - 1] ?? ('Zone ' + z),
        power:  false,
        mute:   false,
        source: 1,
        volume: 30,
        bass:   0,
        treble: 0,
      });
    }
  }

  // -- Public API --

  connect() {
    if (this.mock) {
      this.connected = true;
      this.emit('connected', { mock: true });
      return;
    }
    this._open();
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  getState(): ZoneState[] {
    return Array.from(this.state.values());
  }

  getFullState() {
    return {
      connected: this.connected,
      mock: this.mock,
      // Convert volume to the 0-60 display scale at the output boundary (raw kept internally).
      zones: this.getState().map(z => ({ ...z, volume: toDisplayVolume(z.volume) })),
    };
  }

  getZone(zone: number): ZoneState | undefined {
    return this.state.get(zone);
  }

  isMock(): boolean { return this.mock; }
  isConnected(): boolean { return this.connected; }

  async queryZone(zone: number) {
    await this._send(buildCmd(zone, CMD_QUERY, 0x00));
  }

  async queryAll() {
    // GW-SL1: ANY zone query returns ALL zones in one 182-byte response.
    // Only send ONE query to avoid flooding the gateway.
    if (this.mock) {
      for (let z = 1; z <= this.zoneCount; z++) await this.queryZone(z);
      return;
    }
    await this.queryZone(1); // single query returns all 12 zones
    await _delay(500); // wait for full response to arrive and drain
  }

  setZoneName(zone: number, name: string) {
    const s = this.state.get(zone);
    if (s) {
      const updated = { ...s, name };
      this.state.set(zone, updated);
      this.emit('zone', updated);
    }
  }

  async setPower(zone: number, on: boolean): Promise<ZoneState | void> {
    if (this.mock) return this._mockUpdate(zone, { power: on });
    return this._sendAndWait(buildCmd(zone, CMD_CONTROL, on ? CTRL_POWER_ON : CTRL_POWER_OFF), zone);
  }

  async setMute(zone: number, mute: boolean): Promise<ZoneState | void> {
    if (this.mock) return this._mockUpdate(zone, { mute });
    return this._sendAndWait(buildCmd(zone, CMD_CONTROL, mute ? CTRL_MUTE_ON : CTRL_MUTE_OFF), zone);
  }

  async setVolume(zone: number, targetVol: number): Promise<ZoneState | void> {
    const v = Math.min(60, Math.max(0, Math.round(targetVol)));
    const data = (196 + v) & 0xFF;
    if (this.mock) return this._mockUpdate(zone, { volume: data });
    // CORRECT Lync volume frame — from the official "Lync RS232 Codes Full":
    //   byte[1] = 0x01 for VOLUME (every other command uses 0x00 — power/input/mute).
    //   cmd 0x15, data = 0xC4 + attenuation (0xC4 = loudest ... 0x00 = quietest).
    // Readback uses the SAME encoding (raw = 0xC4 + att), so data = 196 + v, and a zone that
    // reads back as raw X is set by sending data X.  e.g. Zone1 -20 = 02 01 01 15 D8 F1.
    // ⚠️ HISTORY: we previously sent byte[1]=0x00 on a 0x15 frame (a MALFORMED volume command).
    // That scrambled the gateway's volume registers for ALL clients (recovery = power-cycle the
    // controller). The HTD app sends 02 01 ... and never corrupts. Do NOT revert byte[1] to 0x00.
    const f = Buffer.from([0x02, 0x01, zone & 0xFF, 0x15, data, 0]);
    f[5] = (f[0] + f[1] + f[2] + f[3] + f[4]) & 0xFF;
    console.log(`[htd] setVolume zone=${zone} v=${v} -> ${f.toString('hex')}`);
    await this._send(f);
    // gateway doesn't reliably echo volume status — update local UI state optimistically
    const cur = this.state.get(zone);
    if (cur) { const u = { ...cur, volume: data }; this.state.set(zone, u); this.emit('zone', u); }
    return this.state.get(zone);
  }

  async setSource(zone: number, source: number): Promise<ZoneState | void> {
    // source is a display index (1=In1, 2=In2); translate to actual HTD input number.
    const htdSrc = Math.min(18, Math.max(1, this._displayToHtd(source)));
    if (this.mock) return this._mockUpdate(zone, { source: this._htdToDisplay(htdSrc) });
    // GW-SL1 source select bytes per RS232 spec:
    //   Inputs 1-12:  0x10 + (n-1)  →  0x10..0x1B
    //   Inputs 13-18: 0x63 + (n-13) →  0x63..0x68  (non-contiguous jump)
    const cmdByte = htdSrc <= 12 ? 0x10 + (htdSrc - 1) : 0x63 + (htdSrc - 13);
    return this._sendAndWait(buildCmd(zone, CMD_CONTROL, cmdByte), zone);
  }

  // Bass/Treble are ABSOLUTE sets per the Lync protocol (NOT up/down increments — those don't exist).
  // Bass = cmd 0x18, Treble = cmd 0x17, single data byte = 0x80 + level (0x80=flat, 0x8A=+10, 0x76=-10),
  // reserved byte 0x00 (buildCmd default). Range clamped to the protocol's -10..+10.
  async setBass(zone: number, targetBass: number): Promise<ZoneState | void> {
    const target = Math.min(10, Math.max(-10, Math.round(targetBass)));
    if (this.mock) return this._mockUpdate(zone, { bass: target });
    const data = (0x80 + target) & 0xFF;
    await this._send(buildCmd(zone, CMD_BASS, data));
    const cur = this.state.get(zone);  // optimistic — the gateway's EQ readback is unreliable
    if (cur) { const u = { ...cur, bass: target }; this.state.set(zone, u); this.emit('zone', u); }
    return this.state.get(zone);
  }

  async setTreble(zone: number, targetTreble: number): Promise<ZoneState | void> {
    const target = Math.min(10, Math.max(-10, Math.round(targetTreble)));
    if (this.mock) return this._mockUpdate(zone, { treble: target });
    const data = (0x80 + target) & 0xFF;
    await this._send(buildCmd(zone, CMD_TREBLE, data));
    const cur = this.state.get(zone);
    if (cur) { const u = { ...cur, treble: target }; this.state.set(zone, u); this.emit('zone', u); }
    return this.state.get(zone);
  }

  async allOn()  { for (let z = 1; z <= this.zoneCount; z++) await this.setPower(z, true); }
  async allOff() { for (let z = 1; z <= this.zoneCount; z++) await this.setPower(z, false); }

  // -- Internals --

  private _mockUpdate(zone: number, patch: Partial<ZoneState>) {
    const s = this.state.get(zone);
    if (!s) return;
    const updated = { ...s, ...patch };
    this.state.set(zone, updated);
    this.emit('zone', updated);
  }

  private _open() {
    this.socket?.destroy();
    const sock = createConnection({ host: this.host, port: this.port });
    this.socket = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.emit('connected', { mock: false });
      this.queryAll().catch(() => {});
    });

    sock.on('data', (chunk: Buffer) => {
      this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
      this._drain();
    });

    sock.on('error', err => this.emit('error', err));

    sock.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    sock.setKeepAlive(true, 30_000);
  }

  private _drain() {
    while (this.rxBuf.length >= RESPONSE_LEN) {
      const start = this.rxBuf.indexOf(0x02);
      if (start === -1) { this.rxBuf = Buffer.alloc(0); return; }
      if (start > 0)    { this.rxBuf = this.rxBuf.subarray(start); continue; }
      if (this.rxBuf.length < RESPONSE_LEN) break;

      const frame  = this.rxBuf.subarray(0, RESPONSE_LEN);
      // Validate checksum before trusting the frame. A stray 0x02 inside a payload can
      // otherwise misalign the parser and yield garbage (e.g. vol=196/src=114). On a bad
      // checksum, skip one byte and resync instead of consuming a corrupt frame.
      const cksum = frame.subarray(0, 13).reduce((a, b) => a + b, 0) & 0xFF;
      if (cksum !== frame[13]) {
        this.rxBuf = this.rxBuf.subarray(1);
        continue;
      }
      this.rxBuf   = this.rxBuf.subarray(RESPONSE_LEN);
      const parsed = parseFrame(frame, this.zoneNames);
      if (parsed) {
        // Remap raw HTD source number to display index before storing.
        const remapped = { ...parsed, source: this._htdToDisplay(parsed.source) };
        this.state.set(remapped.zone, remapped);
        this.emit('zone', remapped);
      }
    }
  }

  private _scheduleReconnect() {
    if (this.mock || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, 5_000);
  }

  private _waitForZone(zone: number, timeoutMs = 3000): Promise<ZoneState> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('zone', handler);
        resolve(this.state.get(zone)!);
      }, timeoutMs);
      const handler = (s: ZoneState) => {
        if (s.zone === zone) {
          clearTimeout(timer);
          this.removeListener('zone', handler);
          resolve(s);
        }
      };
      this.on('zone', handler);
    });
  }

  private async _sendAndWait(buf: Buffer, zone: number): Promise<ZoneState> {
    const wait = this._waitForZone(zone);
    await this._send(buf);
    return wait;
  }

  private _send(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.mock) { resolve(); return; }
      if (!this.socket || !this.connected) {
        console.error('[htd] NOT CONNECTED - cannot send:', buf.toString('hex'));
        reject(new Error('HTD not connected'));
        return;
      }
      console.log('[htd] TX:', buf.toString('hex'), 'connected:', this.connected);
      this.socket.write(buf, err => err ? reject(err) : resolve());
    });
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

class HtdLync12Plugin extends BasePlugin {
  private htd!: HtdLync12;

  // "Now playing" routes set by the guided audio flow: zone -> which WiiM input + service.
  // Used to auto-assign Input 1 (default) vs Input 2 (when Input 1 is already in use).
  // Source readback is unreliable, so input assignment is tracked here in software.
  private activeRoutes: Map<number, { input: number; service: string }> = new Map();

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  // Decide which WiiM input a new play request should use.
  // Rule (per user): Input 1 is the default; if Input 1 is already in use by another
  // powered-on zone, use Input 2 so a second listener can play something different.
  private pickInput(targetZone: number): number {
    // Drop stale routes whose zone is no longer powered on (self-heals app-side changes).
    const powered = new Set(
      this.htd.getFullState().zones.filter((z: any) => z.power).map((z: any) => z.zone),
    );
    for (const z of [...this.activeRoutes.keys()]) {
      if (!powered.has(z)) this.activeRoutes.delete(z);
    }
    // Reuse this zone's current input if it already has one.
    const existing = this.activeRoutes.get(targetZone);
    if (existing) return existing.input;
    const used = new Set([...this.activeRoutes.values()].map((r) => r.input));
    if (!used.has(1)) return 1;
    if (!used.has(2)) return 2;
    return 1; // both inputs busy -> fall back to Input 1 (joins that stream)
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);
    const cfg: HtdConfig = {
      host: mockMode ? '' : (config.host ?? ''),
      port: config.port ?? 10006,
      zones: config.zones ?? 12,
      zoneNames: config.zoneNames,
      sourceMap: config.sourceMap,
    };
    this.htd = new HtdLync12(cfg);

    this.htd.on('zone', (state: ZoneState) => {
      // Convert volume to 0-60 display scale for the SSE stream too (matches getFullState).
      this.emit('stateChange', { type: 'zone', ...state, volume: toDisplayVolume(state.volume) });
    });
    this.htd.on('connected', (info: any) => {
      this.connected = true;
      this.emit('connected', info);
    });
    this.htd.on('disconnected', () => {
      this.connected = false;
      this.emit('disconnected');
    });
    this.htd.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  async connect(): Promise<void> {
    this.htd.connect();
  }

  async disconnect(): Promise<void> {
    this.htd.disconnect();
    this.connected = false;
  }

  getState() {
    return this.htd.getFullState();
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/audio/state',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.htd.getFullState());
        },
      },

      // Guided audio flow: route a service to a zone. Picks Input 1 (default) or Input 2
      // (if Input 1 is in use), powers the zone on, and sets its source. SAFE commands only
      // (source + power, 0x04 family) — never touches volume (the corruption-prone write).
      {
        method: 'POST',
        path: '/api/audio/play',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const zone = parseInt(body.zone, 10);
          const service = String(body.service ?? '');
          if (!(zone >= 1 && zone <= 12)) {
            jsonResponse(res, { error: 'zone must be 1-12' }, 400);
            return;
          }
          try {
            const input = this.pickInput(zone);
            await this.htd.setPower(zone, true);
            await this.htd.setSource(zone, input);
            this.activeRoutes.set(zone, { input, service });
            const zoneName = this.htd.getZone(zone)?.name ?? ('Zone ' + zone);
            jsonResponse(res, { ok: true, zone, zoneName, input, service });
          } catch (err: any) {
            jsonResponse(res, { error: err.message }, 500);
          }
        },
      },

      // Stop a guided-audio zone: power off and release its input assignment.
      {
        method: 'POST',
        path: '/api/audio/stop',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const zone = parseInt(body.zone, 10);
          if (!(zone >= 1 && zone <= 12)) {
            jsonResponse(res, { error: 'zone must be 1-12' }, 400);
            return;
          }
          try {
            await this.htd.setPower(zone, false);
            this.activeRoutes.delete(zone);
            jsonResponse(res, { ok: true, zone });
          } catch (err: any) {
            jsonResponse(res, { error: err.message }, 500);
          }
        },
      },

      // What the guided flow currently has playing where (zone -> input + service).
      {
        method: 'GET',
        path: '/api/audio/now-playing',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          const powered = new Set(
            this.htd.getFullState().zones.filter((z: any) => z.power).map((z: any) => z.zone),
          );
          for (const z of [...this.activeRoutes.keys()]) {
            if (!powered.has(z)) this.activeRoutes.delete(z);
          }
          const routes = [...this.activeRoutes.entries()].map(([zone, r]) => ({
            zone, zoneName: this.htd.getZone(zone)?.name ?? ('Zone ' + zone), input: r.input, service: r.service,
          }));
          jsonResponse(res, { routes });
        },
      },
      {
        method: 'POST',
        path: '/api/audio/zone/:zone/:action',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await parseBodyFromReq(req);
          const url = req.url ?? '';
          const match = url.match(/\/api\/audio\/zone\/(\d+)\/(\w+)/);
          if (!match) {
            jsonResponse(res, { error: 'Invalid zone/action' }, 400);
            return;
          }
          const zone = parseInt(match[1], 10);
          const action = match[2];

          if (zone < 1 || zone > 12) {
            jsonResponse(res, { error: 'Zone must be 1-12' }, 400);
            return;
          }

          try {
            let result: ZoneState | void;
            switch (action) {
              case 'power':
                result = await this.htd.setPower(zone, !!body.on);
                break;
              case 'volume':
                result = await this.htd.setVolume(zone, Number(body.level ?? body.value) || 0);
                break;
              case 'mute':
                result = await this.htd.setMute(zone, !!body.mute);
                break;
              case 'source':
                result = await this.htd.setSource(zone, Number(body.source ?? body.value) || 1);
                break;
              case 'bass':
                result = await this.htd.setBass(zone, Number(body.bass) || 0);
                break;
              case 'treble':
                result = await this.htd.setTreble(zone, Number(body.treble) || 0);
                break;
              default:
                jsonResponse(res, { error: 'Unknown action: ' + action }, 400);
                return;
            }
            jsonResponse(res, { ok: true, zone, action, state: result || this.htd.getZone(zone) });
          } catch (err: any) {
            jsonResponse(res, { error: err.message }, 500);
          }
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): HtdLync12Plugin {
  return new HtdLync12Plugin(manifest);
}
