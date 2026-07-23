// MalamaOS Plugin: ratgdo Garage Doors
// Subscribes to ratgdo MQTT topics for LiftMaster open/close status and control.
// Requires: mosquitto (or any MQTT broker) running on BAILEY-AI.
// Install:  choco install mosquitto   (or scoop install mosquitto)
// Start:    net start mosquitto

import * as fs   from 'fs';
import * as path from 'path';
import * as http from 'http';
import mqtt from 'mqtt';
import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';

// --- Types ---

interface RatgdoDoor {
  id:         string;   // matches shelly-gate device id, e.g. "garage-1"
  name:       string;   // display name, e.g. "Garage Door 1"
  deviceName: string;   // ratgdo MQTT device name set during ratgdo setup
  zoneId:     string;   // annke-cameras zone ID for garage-state.json
}

type RawDoorState = 'open' | 'closed' | 'opening' | 'closing' | 'stopped' | 'unknown';

interface DoorState {
  id:         string;
  name:       string;
  raw:        RawDoorState;
  isOpen:     boolean;
  available:  boolean;
  updatedAt:  number;
}

// --- Helpers ---

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
  });
}

function rawToIsOpen(raw: RawDoorState): boolean {
  return raw === 'open' || raw === 'opening';
}

// --- Plugin ---

const GARAGE_STATE_FILE = path.join(__dirname, '..', '..', '..', 'data', 'garage-state.json');
const ANNKE_GARAGE_STATE_URL = 'http://localhost:3333/api/cameras/garage-state';

class RatgdoPlugin extends BasePlugin {
  private mqttClient:  ReturnType<typeof mqtt.connect> | null = null;
  private doors:       Map<string, RatgdoDoor>  = new Map(); // keyed by deviceName
  private doorById:    Map<string, RatgdoDoor>  = new Map(); // keyed by id
  private states:      Map<string, DoorState>   = new Map(); // keyed by deviceName
  private sseClients:  Set<ServerResponse>       = new Set();

  constructor(manifest: PluginManifest) { super(manifest); }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    for (const d of (config.doors || []) as RatgdoDoor[]) {
      this.doors.set(d.deviceName, d);
      this.doorById.set(d.id, d);
      this.states.set(d.deviceName, {
        id: d.id, name: d.name, raw: 'unknown', isOpen: false,
        available: false, updatedAt: Date.now(),
      });
    }
  }

  async connect(): Promise<void> {
    const mqttCfg = this.config.mqtt || {};
    const host    = mqttCfg.host     || 'localhost';
    const port    = mqttCfg.port     || 1883;
    const user    = mqttCfg.username || undefined;
    const pass    = mqttCfg.password || undefined;

    this.mqttClient = mqtt.connect(`mqtt://${host}:${port}`, {
      username: user, password: pass, reconnectPeriod: 5000,
    });

    this.mqttClient.on('connect', () => {
      this.connected = true;
      console.log('[ratgdo] MQTT connected');
      for (const [deviceName] of this.doors) {
        this.mqttClient!.subscribe(`ratgdo/${deviceName}/status/door`);
        this.mqttClient!.subscribe(`ratgdo/${deviceName}/status/availability`);
      }
    });

    this.mqttClient.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload.toString().trim().toLowerCase());
    });

    this.mqttClient.on('error', (err: Error) => {
      console.error('[ratgdo] MQTT error:', err.message);
    });

    this.mqttClient.on('offline', () => {
      this.connected = false;
      console.warn('[ratgdo] MQTT offline');
    });

    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.mqttClient?.end();
    this.mqttClient = null;
    for (const c of this.sseClients) { try { c.end(); } catch {} }
    this.sseClients.clear();
    this.connected = false;
    this.emit('disconnected');
  }

  private handleMessage(topic: string, value: string): void {
    // ratgdo/{deviceName}/status/door
    const doorMatch = topic.match(/^ratgdo\/(.+)\/status\/door$/);
    if (doorMatch) {
      const deviceName = doorMatch[1];
      const door = this.doors.get(deviceName);
      if (!door) return;
      const raw    = value as RawDoorState;
      const isOpen = rawToIsOpen(raw);
      const prev   = this.states.get(deviceName);
      const changed = !prev || prev.isOpen !== isOpen || prev.raw !== raw;
      const state: DoorState = { id: door.id, name: door.name, raw, isOpen, available: true, updatedAt: Date.now() };
      this.states.set(deviceName, state);
      console.log(`[ratgdo] ${door.name}: ${raw} (isOpen=${isOpen})`);
      if (changed) {
        this.persistState();
        this.notifyAnnke(door.zoneId, isOpen);
        this.broadcastSSE({ type: 'garage-door-update', zoneId: door.zoneId, name: door.name, isOpen, raw });
      }
      return;
    }

    // ratgdo/{deviceName}/status/availability
    const availMatch = topic.match(/^ratgdo\/(.+)\/status\/availability$/);
    if (availMatch) {
      const deviceName = availMatch[1];
      const state = this.states.get(deviceName);
      if (state) {
        state.available = value === 'online';
        this.broadcastSSE({ type: 'ratgdo-availability', deviceName, available: state.available });
      }
    }
  }

  private persistState(): void {
    try {
      const obj: Record<string, { isOpen: boolean; updatedAt: number }> = {};
      for (const [, state] of this.states) {
        const door = this.doors.get(
          [...this.doors.entries()].find(([, d]) => d.id === state.id)?.[0] ?? ''
        );
        if (door?.zoneId) obj[door.zoneId] = { isOpen: state.isOpen, updatedAt: state.updatedAt };
      }
      const data = JSON.stringify(obj);
      // BOM-free UTF-8 write
      fs.writeFileSync(GARAGE_STATE_FILE, data, { encoding: 'utf8' });
    } catch (e) {
      console.error('[ratgdo] Failed to write garage-state.json:', e);
    }
  }

  private notifyAnnke(zoneId: string, isOpen: boolean): void {
    const body = JSON.stringify({ zoneId, isOpen });
    const req  = http.request(ANNKE_GARAGE_STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {}); // best-effort; annke-cameras may not be running
    req.write(body);
    req.end();
  }

  sendCommand(deviceName: string, command: 'open' | 'close' | 'stop' | 'toggle'): boolean {
    if (!this.mqttClient || !this.connected) return false;
    const topic = `ratgdo/${deviceName}/command/door`;
    this.mqttClient.publish(topic, command);
    console.log(`[ratgdo] Command → ${topic}: ${command}`);
    return true;
  }

  private broadcastSSE(event: any): void {
    const msg = 'data: ' + JSON.stringify({ ...event, time: Date.now() }) + '\n\n';
    for (const c of this.sseClients) {
      try { c.write(msg); } catch { this.sseClients.delete(c); }
    }
  }

  getState(): any {
    return {
      connected: this.connected,
      doors: [...this.states.values()],
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/ratgdo/state — current door states
      {
        method: 'GET',
        path: '/api/ratgdo/state',
        handler: (_req, res) => jsonResponse(res, this.getState()),
      },

      // GET /api/ratgdo/events — SSE stream
      {
        method: 'GET',
        path: '/api/ratgdo/events',
        handler: (_req, res) => {
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
          });
          res.write('data: ' + JSON.stringify({ type: 'connected', state: this.getState() }) + '\n\n');
          this.sseClients.add(res);
          res.on('close', () => this.sseClients.delete(res));
        },
      },

      // POST /api/ratgdo/:deviceName/toggle — send toggle command (for Cycle button)
      {
        method: 'POST',
        path: '/api/ratgdo/:deviceName/toggle',
        handler: async (req, res) => {
          const deviceName = (req as any).params?.deviceName
            ?? req.url?.split('/')[3] ?? '';
          if (!this.doors.has(deviceName))
            return jsonResponse(res, { ok: false, error: 'unknown device' }, 404);
          const ok = this.sendCommand(deviceName, 'toggle');
          jsonResponse(res, { ok });
        },
      },

      // POST /api/ratgdo/:deviceName/door — explicit command { command: open|close|stop|toggle }
      {
        method: 'POST',
        path: '/api/ratgdo/:deviceName/door',
        handler: async (req, res) => {
          const deviceName = (req as any).params?.deviceName
            ?? req.url?.split('/')[3] ?? '';
          if (!this.doors.has(deviceName))
            return jsonResponse(res, { ok: false, error: 'unknown device' }, 404);
          try {
            const body = JSON.parse(await readBody(req));
            const cmd  = body.command as 'open' | 'close' | 'stop' | 'toggle';
            if (!['open', 'close', 'stop', 'toggle'].includes(cmd))
              return jsonResponse(res, { ok: false, error: 'invalid command' }, 400);
            const ok = this.sendCommand(deviceName, cmd);
            jsonResponse(res, { ok });
          } catch { jsonResponse(res, { ok: false, error: 'bad request' }, 400); }
        },
      },

      // POST /api/ratgdo/calibrate — force-set a door state (manual override)
      {
        method: 'POST',
        path: '/api/ratgdo/calibrate',
        handler: async (req, res) => {
          try {
            const { doorId, isOpen } = JSON.parse(await readBody(req));
            const door = this.doorById.get(doorId);
            if (!door) return jsonResponse(res, { ok: false, error: 'unknown doorId' }, 404);
            const state = this.states.get(door.deviceName)!;
            state.isOpen    = !!isOpen;
            state.raw       = isOpen ? 'open' : 'closed';
            state.updatedAt = Date.now();
            this.persistState();
            this.notifyAnnke(door.zoneId, state.isOpen);
            this.broadcastSSE({ type: 'garage-door-update', zoneId: door.zoneId, name: door.name, isOpen: state.isOpen });
            jsonResponse(res, { ok: true });
          } catch { jsonResponse(res, { ok: false, error: 'bad request' }, 400); }
        },
      },
    ];
  }
}

// --- Export ---

import manifest from './manifest.json';
export default new RatgdoPlugin(manifest as PluginManifest);
