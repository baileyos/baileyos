// ── BaileyOS Plugin Driver Template ────────────────────────────────
// This file implements the BasePlugin interface that every BaileyOS
// plugin driver must satisfy. Copy this template and fill in the
// methods with your device-specific logic.
//
// The plugin-registry calls these methods in this order:
//   1. constructor()  -- instantiate (manifest is passed in)
//   2. init()         -- one-time setup (read config, allocate resources)
//   3. connect()      -- establish connection to the device
//   ... plugin is now live ...
//   4. disconnect()   -- called on shutdown or plugin disable

import { BasePlugin, PluginManifest, DeviceState, RouteDefinition } from '../../core/types';
import { Logger } from '../../core/logger';

// ── Device State Interface ─────────────────────────────────────────
// Define the shape of your device's state. This is what getState()
// returns and what gets broadcast to the dashboard via SSE.
interface MyDeviceState extends DeviceState {
  power: boolean;
  brightness: number;
  status: 'online' | 'offline' | 'error';
  lastSeen: string;
}

export default class MyDeviceDriver implements BasePlugin {
  // ── Properties ───────────────────────────────────────────────────
  public readonly id: string;
  public readonly name: string;
  private manifest: PluginManifest;
  private log: Logger;
  private connected: boolean = false;
  private state: MyDeviceState;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // ── Constructor ──────────────────────────────────────────────────
  // Called once when the plugin-registry instantiates this driver.
  // Store the manifest and set up initial (disconnected) state.
  // Do NOT make network calls here -- save that for init() / connect().
  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.name = manifest.name;
    this.log = new Logger(`plugin:${this.id}`);

    // Set default state before the device is connected.
    this.state = {
      power: false,
      brightness: 0,
      status: 'offline',
      lastSeen: new Date().toISOString(),
    };
  }

  // ── init() ───────────────────────────────────────────────────────
  // Called once after construction. Use this for one-time setup:
  //   - Read persistent config from disk
  //   - Validate connection settings from the manifest
  //   - Allocate buffers, caches, or lookup tables
  //
  // Return true if initialization succeeded, false to disable plugin.
  async init(): Promise<boolean> {
    this.log.info('Initializing...');

    // Validate that we have the connection info we need.
    const conn = this.manifest.connection;
    if (!conn?.host || !conn?.port) {
      this.log.error('Missing host or port in manifest.connection');
      return false;
    }

    this.log.info(`Configured for ${conn.host}:${conn.port}`);
    return true;
  }

  // ── connect() ────────────────────────────────────────────────────
  // Called after init() succeeds. Establish a live connection to the
  // device. This might be a TCP socket, HTTP session, serial port, etc.
  //
  // Return true if the connection is alive, false to mark as failed.
  // The plugin-registry will retry based on its backoff policy.
  async connect(): Promise<boolean> {
    const { host, port } = this.manifest.connection;
    this.log.info(`Connecting to ${host}:${port}...`);

    try {
      // ── REPLACE THIS with your real connection logic ──────────
      // Examples:
      //   TCP:    net.createConnection({ host, port })
      //   HTTP:   fetch(`http://${host}:${port}/api/status`)
      //   Serial: new SerialPort({ path: '/dev/ttyUSB0', baudRate: 9600 })
      //   MQTT:   mqtt.connect(`mqtt://${host}:${port}`)

      const response = await fetch(`http://${host}:${port}/api/status`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Update our state with whatever the device reports.
      this.state = {
        power: data.power ?? false,
        brightness: data.brightness ?? 0,
        status: 'online',
        lastSeen: new Date().toISOString(),
      };

      this.connected = true;
      this.log.info('Connected successfully');

      // Start polling the device for state changes.
      // Alternatively, use a persistent socket or SSE stream.
      this.pollInterval = setInterval(() => this.poll(), 5000);

      return true;
    } catch (err: any) {
      this.log.error(`Connection failed: ${err.message}`);
      this.state.status = 'error';
      return false;
    }
  }

  // ── disconnect() ─────────────────────────────────────────────────
  // Called when the plugin is disabled, the server shuts down, or
  // the admin removes the plugin. Clean up all resources here:
  //   - Close sockets / serial ports
  //   - Clear intervals / timeouts
  //   - Flush any pending writes
  async disconnect(): Promise<void> {
    this.log.info('Disconnecting...');

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.connected = false;
    this.state.status = 'offline';
    this.log.info('Disconnected');
  }

  // ── getState() ───────────────────────────────────────────────────
  // Returns the current device state. The dashboard widget, SSE
  // broadcasts, and API routes all call this to get live data.
  //
  // Keep this method fast -- it should return cached state, NOT make
  // a network call. Use poll() or event listeners to update state
  // in the background.
  getState(): MyDeviceState {
    return { ...this.state };
  }

  // ── getRoutes() ──────────────────────────────────────────────────
  // Returns an array of HTTP route definitions that the api-router
  // will mount under /api/plugins/<plugin-id>/. This is how the
  // dashboard widget (and external tools) control the device.
  //
  // Each route needs: method, path, and handler.
  getRoutes(): RouteDefinition[] {
    return [
      // GET /api/plugins/my-device/status
      // Returns the current device state as JSON.
      {
        method: 'GET',
        path: '/status',
        handler: async (req, res) => {
          res.json(this.getState());
        },
      },

      // POST /api/plugins/my-device/power
      // Toggle power on/off. Body: { "power": true }
      {
        method: 'POST',
        path: '/power',
        handler: async (req, res) => {
          const { power } = req.body;
          if (typeof power !== 'boolean') {
            return res.status(400).json({ error: 'power must be a boolean' });
          }

          try {
            const { host, port } = this.manifest.connection;
            await fetch(`http://${host}:${port}/api/power`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ power }),
            });

            this.state.power = power;
            this.state.lastSeen = new Date().toISOString();
            this.log.info(`Power set to ${power}`);

            // Broadcast state change to all connected dashboards via SSE.
            this.broadcastState();

            res.json({ success: true, power });
          } catch (err: any) {
            res.status(500).json({ error: err.message });
          }
        },
      },

      // POST /api/plugins/my-device/brightness
      // Set brightness level. Body: { "level": 75 }
      {
        method: 'POST',
        path: '/brightness',
        handler: async (req, res) => {
          const { level } = req.body;
          if (typeof level !== 'number' || level < 0 || level > 100) {
            return res.status(400).json({ error: 'level must be 0-100' });
          }

          try {
            const { host, port } = this.manifest.connection;
            await fetch(`http://${host}:${port}/api/brightness`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ brightness: level }),
            });

            this.state.brightness = level;
            this.state.lastSeen = new Date().toISOString();
            this.log.info(`Brightness set to ${level}%`);

            this.broadcastState();

            res.json({ success: true, brightness: level });
          } catch (err: any) {
            res.status(500).json({ error: err.message });
          }
        },
      },
    ];
  }

  // ── Private Helpers ──────────────────────────────────────────────

  // Poll the device for state updates. Called on an interval set in
  // connect(). Replace with event-driven updates if your protocol
  // supports push notifications (WebSocket, MQTT, SSE, etc.).
  private async poll(): Promise<void> {
    if (!this.connected) return;

    try {
      const { host, port } = this.manifest.connection;
      const response = await fetch(`http://${host}:${port}/api/status`);
      const data = await response.json();

      this.state.power = data.power ?? this.state.power;
      this.state.brightness = data.brightness ?? this.state.brightness;
      this.state.status = 'online';
      this.state.lastSeen = new Date().toISOString();

      // Broadcast updated state to the dashboard.
      this.broadcastState();
    } catch {
      this.state.status = 'error';
    }
  }

  // Send state to all connected dashboard clients via SSE.
  // The sse-manager is a global singleton available at runtime.
  private broadcastState(): void {
    // The global SSE manager is injected by the plugin-registry at load time.
    // Access it via: globalThis.baileyOS.sse.broadcast(pluginId, state)
    if (globalThis.baileyOS?.sse) {
      globalThis.baileyOS.sse.broadcast(this.id, this.getState());
    }
  }
}
