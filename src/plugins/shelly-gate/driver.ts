// MalamaOS Plugin: Shelly Gate Controller
// Shelly Gen 3 HTTP RPC API for relay-based gate/garage control.

import * as fs from 'fs';
import * as path from 'path';
import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';

// --- Types ---

type GateEventSource = 'dashboard' | 'auto-close' | 'external';

interface GateEvent {
  ts: string;
  deviceId: string;
  deviceName: string;
  action: 'opened' | 'closed' | 'triggered';
  source: GateEventSource;
  clientIp?: string;
}

interface ShellyDevice {
  id: string;
  name: string;
  host: string;
  type: 'gate' | 'garage' | 'relay' | 'switch';
  autoCloseSeconds?: number;
  pulseDuration?: number;
}

interface ShellyState {
  id: string;
  name: string;
  type: string;
  host: string;
  online: boolean;
  output: boolean;
  temperature?: number;
  uptime?: number;
  wifi_rssi?: number;
  wifi_ssid?: string;
  firmware?: string;
  mac?: string;
  lastSeen: string;
}

interface GateDeviceSettings {
  autoClose: {
    enabled: boolean;
    seconds: number;
  };
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
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// --- Constants ---

const DATA_DIR          = path.join(__dirname, '..', '..', '..', 'data');
const DATA_FILE         = path.join(DATA_DIR, 'gate-events.json');
const SETTINGS_FILE     = path.join(DATA_DIR, 'gate-settings.json');
const ZONES_FILE        = path.join(DATA_DIR, 'zones.json');
const GARAGE_STATE_FILE = path.join(DATA_DIR, 'garage-state.json');
const MAX_EVENTS        = 500;

// --- Plugin Class ---

class ShellyGatePlugin extends BasePlugin {
  private devices: Map<string, ShellyDevice> = new Map();
  private states: Map<string, ShellyState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private autoCloseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private autoCloseCountdowns: Map<string, number> = new Map();
  private countdownIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private sseClients: Set<ServerResponse> = new Set();
  private eventLog: GateEvent[] = [];
  private settingsMap: Map<string, GateDeviceSettings> = new Map();
  private autoCloseScheduled: Set<string> = new Set();
  private garageOpenCache: { ts: number; data: Map<string, boolean> } | null = null;

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);
    const configDevices: ShellyDevice[] = config.devices || [];
    if (configDevices.length === 0) this.mockMode = true;
    for (const d of configDevices) this.devices.set(d.id, d);
  }

  // --- Settings ---

  private loadSettings(): void {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        for (const [id, s] of Object.entries(raw)) {
          this.settingsMap.set(id, s as GateDeviceSettings);
        }
      }
    } catch { }
    // Seed defaults from config for any device not yet persisted
    for (const device of this.devices.values()) {
      if (!this.settingsMap.has(device.id)) {
        this.settingsMap.set(device.id, {
          autoClose: {
            enabled: device.type === 'gate' && !!device.autoCloseSeconds,
            seconds: device.autoCloseSeconds || 30,
          },
        });
      }
    }
  }

  private saveSettings(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj: Record<string, GateDeviceSettings> = {};
      for (const [id, s] of this.settingsMap.entries()) obj[id] = s;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj), 'utf-8');
    } catch (e) {
      console.error('[shelly-gate] Failed to save settings:', e);
    }
  }

  private getDeviceSettings(deviceId: string): GateDeviceSettings {
    return this.settingsMap.get(deviceId) || { autoClose: { enabled: false, seconds: 30 } };
  }

  // --- Event Log ---

  private loadEvents(): void {
    try {
      if (fs.existsSync(DATA_FILE)) {
        this.eventLog = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      }
    } catch { this.eventLog = []; }
  }

  private saveEvents(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.eventLog), 'utf-8');
    } catch (e) {
      console.error('[shelly-gate] Failed to save event log:', e);
    }
  }

  // Write an internal action to actions.jsonl so vision-ai can attribute gate events correctly.
  private writeActionLog(deviceId: string, source: GateEventSource): void {
    try {
      const logDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        method: 'INTERNAL',
        path: `/api/gate/${deviceId}/action`,
        plugin: 'shelly-gate',
        ip: '127.0.0.1',
        device: source,  // 'auto-close' | 'dashboard' | 'external' â€” read by vision-ai attribution
        body: { source },
        status: 200,
      };
      fs.appendFileSync(path.join(logDir, 'actions.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }

  private logEvent(deviceId: string, action: GateEvent['action'], source: GateEventSource, clientIp?: string): void {
    const device = this.devices.get(deviceId);
    const event: GateEvent = {
      ts: new Date().toISOString(),
      deviceId,
      deviceName: device?.name ?? deviceId,
      action,
      source,
      ...(clientIp ? { clientIp } : {}),
    };
    this.eventLog.unshift(event);
    if (this.eventLog.length > MAX_EVENTS) this.eventLog.length = MAX_EVENTS;
    this.saveEvents();
    this.broadcastSSE({ type: 'gateEvent', event });
    console.log('[shelly-gate] Event: ' + event.deviceName + ' ' + action + ' by ' + source);
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    this.loadEvents();
    this.loadSettings();

    if (this.mockMode) {
      this.initMockDevices();
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[shelly-gate] Connected in MOCK MODE');
    } else {
      // Pre-seed all devices as offline so they always appear in state
      for (const device of this.devices.values()) {
        this.states.set(device.id, {
          id: device.id, name: device.name, type: device.type, host: device.host,
          online: false, output: false, lastSeen: new Date().toISOString(),
        });
      }
      await this.pollAllDevices();
      // Configure hardware auto-off on gate relays so the relay can never stay ON
      // indefinitely even if the dashboard restarts during an open/close cycle.
      for (const device of this.devices.values()) {
        if (device.type === 'gate') {
          const settings = this.getDeviceSettings(device.id);
          const delay = settings.autoClose.seconds || 30;
          try {
            // Safety fallback: relay auto-offs in 2s if toggle_after wasn't honored.
          // Do NOT use the auto-close delay here â€” that caused the gate to stay ON
          // for 30s+ after each pulse, making back-to-back commands send {on:false}
          // (falling edge) instead of a new rising-edge pulse.
          await this.shellyRpc(device.host, 'Switch.SetConfig', {
              id: 0, config: { auto_off: true, auto_off_delay: 2 },
            });
            console.log('[shelly-gate] Hardware auto-off set to ' + delay + 's for ' + device.id);
          } catch (e) { console.error('[shelly-gate] Could not set auto-off for ' + device.id + ':', e); }
        }
      }
      this.connected = true;
      this.emit('connected', { mock: false });
      console.log('[shelly-gate] Connected in LIVE mode, ' + this.devices.size + ' devices');
    }

    this.pollTimer = setInterval(() => this.pollAllDevices(), 10000);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const timer of this.autoCloseTimers.values()) clearTimeout(timer);
    this.autoCloseTimers.clear();
    for (const interval of this.countdownIntervals.values()) clearInterval(interval);
    this.countdownIntervals.clear();
    this.autoCloseCountdowns.clear();
    for (const client of this.sseClients) { try { client.end(); } catch {} }
    this.sseClients.clear();
    this.connected = false;
    this.emit('disconnected');
    console.log('[shelly-gate] Disconnected');
  }

  // --- Mock Data ---

  private initMockDevices(): void {
    const mockDevice: ShellyDevice = {
      id: 'gate-1', name: 'Driveway Gate', host: '192.168.1.x',
      type: 'gate', autoCloseSeconds: 30,
    };
    this.devices.set(mockDevice.id, mockDevice);
    this.states.set(mockDevice.id, {
      id: 'gate-1', name: 'Driveway Gate', type: 'gate', host: '192.168.1.x',
      online: true, output: false, temperature: 42.5, uptime: 86400,
      wifi_rssi: -55, wifi_ssid: 'MalamaOS-Net', firmware: '1.4.2-mock',
      mac: 'AA:BB:CC:DD:EE:FF', lastSeen: new Date().toISOString(),
    });
  }

  // --- Shelly HTTP RPC ---

  private async shellyRpc(host: string, method: string, params?: any): Promise<any> {
    const http = await import('http');
    const body = JSON.stringify({ id: 1, method, params: params || {} });

    return new Promise<any>((resolve, reject) => {
      const req = http.request({
        hostname: host,
        port: 80,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Connection': 'close',
        },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error('Shelly RPC error: ' + (parsed.error.message || JSON.stringify(parsed.error))));
            } else {
              resolve(parsed.result);
            }
          } catch { reject(new Error('Bad response: ' + data.slice(0, 200))); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Shelly RPC timeout')); });
      req.write(body);
      req.end();
    });
  }

  // --- Poll ---

  private async pollAllDevices(): Promise<void> {
    for (const device of this.devices.values()) {
      try {
        await this.pollDevice(device);
      } catch (err) {
        const existing = this.states.get(device.id);
        if (existing && existing.online) {
          existing.online = false;
          existing.lastSeen = new Date().toISOString();
          this.emit('stateChange', { type: 'offline', deviceId: device.id });
          this.broadcastSSE({ type: 'stateChange', data: this.getState() });
        }
        if (!this.mockMode) console.error('[shelly-gate] Poll failed for ' + device.id + ':', err);
      }
    }
  }

  private async pollDevice(device: ShellyDevice): Promise<void> {
    if (this.mockMode) {
      const state = this.states.get(device.id);
      if (state) { state.lastSeen = new Date().toISOString(); state.uptime = (state.uptime || 0) + 10; }
      return;
    }

    const status = await this.shellyRpc(device.host, 'Shelly.GetStatus');
    const switchStatus = status['switch:0'] || {};
    const wifiStatus   = status.wifi || {};
    const sysStatus    = status.sys || {};
    const prevState    = this.states.get(device.id);
    const prevOutput   = prevState?.output;

    const newState: ShellyState = {
      id: device.id, name: device.name, type: device.type, host: device.host,
      online: true,
      output: switchStatus.output ?? false,
      temperature: switchStatus.temperature?.tC,
      uptime: sysStatus.uptime,
      wifi_rssi: wifiStatus.rssi,
      wifi_ssid: wifiStatus.ssid,
      firmware: sysStatus.available_updates?.stable?.version || prevState?.firmware,
      mac: sysStatus.mac || prevState?.mac,
      lastSeen: new Date().toISOString(),
    };

    this.states.set(device.id, newState);

    if (prevOutput !== undefined && prevOutput !== newState.output) {
      this.emit('stateChange', { type: 'output', deviceId: device.id, output: newState.output });
      this.broadcastSSE({ type: 'stateChange', data: this.getState() });
      // Garage momentary relays reset in 0.5s â€” don't log the self-reset as an external event.
      // For gate going OFF: Shelly reports source="timer" when its own auto-off hardware timer
      // fired. That's our auto-close, not a physical button. Also catch the race where the
      // 30s Node.js timer fires first (sets relay OFF via setOutput) so source is "HTTP_in"
      // but autoCloseScheduled still has the device.
      if (device.type === 'garage') {
        // skip
      } else if (device.type === 'gate' && !newState.output &&
                 (switchStatus.source === 'timer' || this.autoCloseScheduled.has(device.id))) {
        this.cancelAutoClose(device.id);
        this.writeActionLog(device.id, 'auto-close');
        this.logEvent(device.id, 'closed', 'auto-close');
      } else {
        this.logEvent(device.id, newState.output ? 'opened' : 'closed', 'external');
      }
    }
  }

  // --- Control ---

  private async setOutput(
    deviceId: string,
    on: boolean,
    source: GateEventSource = 'dashboard',
    clientIp?: string,
  ): Promise<{ success: boolean; message: string }> {
    const device = this.devices.get(deviceId);
    if (!device) return { success: false, message: 'Device not found' };
    const state  = this.states.get(deviceId);
    if (!state)  return { success: false, message: 'Device state not available' };

    if (this.mockMode) {
      state.output = on;
      state.lastSeen = new Date().toISOString();
    } else {
      // Gate/garage type: use toggle_after so each ON is a brief momentary pulse.
      // pulseDuration in config lets each garage door be tuned independently â€”
      // some remotes need a longer hold to reliably transmit RF to the opener.
      const shellyParams: any = { id: 0, on };
      if (on && (device.type === 'gate' || device.type === 'garage')) {
        shellyParams.toggle_after = device.type === 'garage'
          ? (device.pulseDuration ?? 0.3)
          : 0.5;
      }
      await this.shellyRpc(device.host, 'Switch.Set', shellyParams);
      state.output = on;
      state.lastSeen = new Date().toISOString();
      // Pre-reset driver state after pulse so next toggle correctly sends ON again
      if (on && device.type === 'gate') {
        setTimeout(() => { const s = this.states.get(deviceId); if (s) s.output = false; }, 600);
      }
    }

    this.emit('stateChange', { type: 'output', deviceId, output: on });
    this.broadcastSSE({ type: 'stateChange', data: this.getState() });

    if (device.type === 'garage') {
      // Hardware handles the pulse; just log a single "triggered" event
      if (on) this.logEvent(deviceId, 'triggered', source, clientIp);
    } else {
      this.logEvent(deviceId, on ? 'opened' : 'closed', source, clientIp);
      // Auto-close (gate only, controlled by user settings)
      if (on) {
        const settings = this.getDeviceSettings(deviceId);
        if (settings.autoClose.enabled) {
          this.scheduleAutoClose(deviceId, settings.autoClose.seconds);
        }
      } else {
        this.cancelAutoClose(deviceId);
      }
    }

    return { success: true, message: device.name + (device.type === 'garage' ? ' triggered' : (on ? ' opened' : ' closed')) };
  }

  private async toggleOutput(
    deviceId: string,
    source: GateEventSource = 'dashboard',
    clientIp?: string,
  ): Promise<{ success: boolean; message: string }> {
    const device = this.devices.get(deviceId);
    if (!device) return { success: false, message: 'Device not found' };

    if (device.type === 'garage' || device.type === 'gate') {
      // Momentary pulse â€” always send ON; toggle_after:0.5 in setOutput resets relay.
      // For gate type this replaces the old !state.output logic which caused back-to-back
      // commands to fail (close followed immediately by open sent {on:false} = falling edge,
      // which the gate hardware ignores â€” it only responds to rising-edge contact closure).
      return this.setOutput(deviceId, true, source, clientIp);
    }

    const state = this.states.get(deviceId);
    if (!state) return { success: false, message: 'Device not found' };
    return this.setOutput(deviceId, !state.output, source, clientIp);
  }

  // --- Auto-Close ---

  private scheduleAutoClose(deviceId: string, seconds: number): void {
    this.cancelAutoClose(deviceId);
    this.autoCloseScheduled.add(deviceId);
    this.autoCloseCountdowns.set(deviceId, seconds);

    const interval = setInterval(() => {
      const remaining = (this.autoCloseCountdowns.get(deviceId) || 0) - 1;
      if (remaining <= 0) {
        this.autoCloseCountdowns.delete(deviceId);
        clearInterval(interval);
        this.countdownIntervals.delete(deviceId);
      } else {
        this.autoCloseCountdowns.set(deviceId, remaining);
      }
      this.broadcastSSE({ type: 'countdown', deviceId, remaining: Math.max(0, remaining) });
    }, 1000);
    this.countdownIntervals.set(deviceId, interval);

    const timer = setTimeout(async () => {
      this.autoCloseTimers.delete(deviceId);
      this.autoCloseScheduled.delete(deviceId);
      const dev = this.devices.get(deviceId);
      console.log('[shelly-gate] Auto-closing ' + deviceId);
      this.writeActionLog(deviceId, 'auto-close');
      if (dev?.type === 'gate') {
        // Gate needs a momentary pulse to close â€” setOutput(false) only drops the relay
        // which the hardware ignores. Send a fresh rising-edge pulse with toggle_after:0.5.
        if (!this.mockMode) {
          try { await this.shellyRpc(dev.host, 'Switch.Set', { id: 0, on: true, toggle_after: 0.5 }); } catch {}
        }
        this.logEvent(deviceId, 'closed', 'auto-close');
        this.broadcastSSE({ type: 'stateChange', data: this.getState() });
      } else {
        await this.setOutput(deviceId, false, 'auto-close');
      }
    }, seconds * 1000);
    this.autoCloseTimers.set(deviceId, timer);

    console.log('[shelly-gate] Auto-close scheduled for ' + deviceId + ' in ' + seconds + 's');
  }

  private cancelAutoClose(deviceId: string): void {
    const timer = this.autoCloseTimers.get(deviceId);
    if (timer) { clearTimeout(timer); this.autoCloseTimers.delete(deviceId); }
    const interval = this.countdownIntervals.get(deviceId);
    if (interval) { clearInterval(interval); this.countdownIntervals.delete(deviceId); }
    this.autoCloseCountdowns.delete(deviceId);
    this.autoCloseScheduled.delete(deviceId);
  }

  // --- SSE ---

  private broadcastSSE(event: any): void {
    const data = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const client of this.sseClients) {
      try { client.write(data); } catch { this.sseClients.delete(client); }
    }
  }

  // --- Garage Vision State ---

  private readGarageOpenState(): Map<string, boolean> {
    const now = Date.now();
    if (this.garageOpenCache && now - this.garageOpenCache.ts < 500) return this.garageOpenCache.data;
    const result = new Map<string, boolean>();
    try {
      if (!fs.existsSync(ZONES_FILE) || !fs.existsSync(GARAGE_STATE_FILE)) return result;
      const zones: Record<string, any[]> = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf-8'));
      const gstate: Record<string, { isOpen: boolean }> = JSON.parse(fs.readFileSync(GARAGE_STATE_FILE, 'utf-8'));
      const nameByZoneId = new Map<string, string>();
      for (const zoneList of Object.values(zones)) {
        for (const z of zoneList) {
          if (z.type === 'garage-door') nameByZoneId.set(z.id, z.name);
        }
      }
      // Default all known garage-door zones to closed
      for (const name of nameByZoneId.values()) result.set(name, false);
      // Override with actual recorded state
      for (const [zoneId, s] of Object.entries(gstate)) {
        const name = nameByZoneId.get(zoneId);
        if (!name) continue;
        if (!result.has(name) || s.isOpen) result.set(name, s.isOpen);
      }
    } catch {}
    this.garageOpenCache = { ts: now, data: result };
    return result;
  }

  // --- State ---

  getState(): any {
    const garageOpen = this.readGarageOpenState();
    const devices = Array.from(this.states.values()).map((s) => {
      const settings = this.getDeviceSettings(s.id);
      const device   = this.devices.get(s.id);
      const garageOpenVal = device?.type === 'garage'
        ? (garageOpen.get(device.name) ?? false)
        : null;
      return {
        ...s,
        garageOpen:         garageOpenVal,
        autoCloseRemaining: this.autoCloseCountdowns.get(s.id) || null,
        autoCloseEnabled:   settings.autoClose.enabled,
        autoCloseSeconds:   settings.autoClose.seconds,
      };
    });
    return { connected: this.connected, mock: this.mockMode, devices };
  }

  // --- Routes ---

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/gate/state
      {
        method: 'GET',
        path: '/api/gate/state',
        handler: (_req, res) => { jsonResponse(res, this.getState()); },
      },

      // POST /api/gate/:id/set
      {
        method: 'POST',
        path: '/api/gate/:id/set',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/set/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const body = await parseBody(req);
          const on   = body.on === true || body.on === 'true';
          const rawIp1 = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '';
          const clientIp1 = rawIp1.replace(/^::ffff:/, '').split(',')[0].trim() || undefined;
          jsonResponse(res, await this.setOutput(match[1], on, 'dashboard', clientIp1));
        },
      },

      // POST /api/gate/:id/toggle
      {
        method: 'POST',
        path: '/api/gate/:id/toggle',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/toggle/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const rawIp2 = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '';
          const clientIp2 = rawIp2.replace(/^::ffff:/, '').split(',')[0].trim() || undefined;
          jsonResponse(res, await this.toggleOutput(match[1], 'dashboard', clientIp2));
        },
      },

      // POST /api/gate/:id/press â€” hold relay ON (garage hold-to-trigger)
      {
        method: 'POST',
        path: '/api/gate/:id/press',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/press/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const device = this.devices.get(match[1]);
          if (!device) { jsonResponse(res, { error: 'Device not found' }, 404); return; }
          if (!this.mockMode) {
            try {
              await this.shellyRpc(device.host, 'Switch.Set', { id: 0, on: true });
            } catch (e: any) {
              jsonResponse(res, { error: e.message }, 500); return;
            }
          }
          jsonResponse(res, { success: true });
        },
      },

      // POST /api/gate/:id/release â€” release relay OFF (garage hold-to-trigger)
      {
        method: 'POST',
        path: '/api/gate/:id/release',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/release/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const device = this.devices.get(match[1]);
          if (!device) { jsonResponse(res, { error: 'Device not found' }, 404); return; }
          if (!this.mockMode) {
            try {
              await this.shellyRpc(device.host, 'Switch.Set', { id: 0, on: false });
            } catch (e: any) {
              jsonResponse(res, { error: e.message }, 500); return;
            }
          }
          jsonResponse(res, { success: true });
        },
      },

      // POST /api/gate/:id/open â€” intentional open (schedules auto-close if enabled)
      {
        method: 'POST',
        path: '/api/gate/:id/open',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/open/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const rawIp = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '';
          const clientIp = rawIp.replace(/^::ffff:/, '').split(',')[0].trim() || undefined;
          // setOutput(true) sends a 0.5s pulse and logs 'opened'; auto-close schedules if enabled
          jsonResponse(res, await this.setOutput(match[1], true, 'voice', clientIp));
        },
      },

      // POST /api/gate/:id/close â€” intentional close (cancels auto-close)
      {
        method: 'POST',
        path: '/api/gate/:id/close',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/close/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const rawIp = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '';
          const clientIp = rawIp.replace(/^::ffff:/, '').split(',')[0].trim() || undefined;
          // Gate only responds to rising-edge contact closure; falling edge does nothing.
          // Pulse (on:true) closes the gate, then immediately cancel the auto-close that
          // setOutput would otherwise schedule (user explicitly said close, not open).
          const dev = this.devices.get(match[1]);
          if (dev?.type === 'gate') {
            // Pulse to close; suppress auto-close re-schedule by cancelling after pulse
            const r = await this.setOutput(match[1], true, 'voice', clientIp);
            this.cancelAutoClose(match[1]);
            this.logEvent(match[1], 'closed', 'voice', clientIp);
            jsonResponse(res, r);
          } else {
            jsonResponse(res, await this.setOutput(match[1], false, 'voice', clientIp));
          }
        },
      },

      // PATCH /api/gate/:id/autoclose  â€” update auto-close settings
      {
        method: 'PATCH',
        path: '/api/gate/:id/autoclose',
        handler: async (req, res) => {
          const match = (req.url ?? '').match(/\/api\/gate\/([^/]+)\/autoclose/);
          if (!match) { jsonResponse(res, { error: 'Invalid device ID' }, 400); return; }
          const id   = match[1];
          const body = await parseBody(req);
          const current = this.getDeviceSettings(id);
          const updated: GateDeviceSettings = {
            autoClose: {
              enabled: body.enabled !== undefined ? !!body.enabled : current.autoClose.enabled,
              seconds: body.seconds !== undefined ? Number(body.seconds) : current.autoClose.seconds,
            },
          };
          this.settingsMap.set(id, updated);
          this.saveSettings();
          if (!updated.autoClose.enabled) this.cancelAutoClose(id);
          jsonResponse(res, { success: true, settings: updated });
        },
      },

      // GET /api/gate/history
      {
        method: 'GET',
        path: '/api/gate/history',
        handler: (_req, res) => { jsonResponse(res, { events: this.eventLog }); },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): ShellyGatePlugin {
  return new ShellyGatePlugin(manifest);
}
