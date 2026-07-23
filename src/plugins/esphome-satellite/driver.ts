// BaileyOS Plugin: ESPHome Voice Satellite
// Connects to a Third Reality Voice Dev device as an ESPHome native API client,
// replacing Home Assistant as the voice pipeline host.

import * as path from 'path';
import * as cp from 'child_process';
import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { ServerResponse } from 'http';

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

class EspHomeSatellitePlugin extends BasePlugin {
  private sidecar: cp.ChildProcess | null = null;
  private startedAt: string | null = null;
  private deviceHost: string = '192.168.1.x';  // configure in config.json
  private devicePort: number = 6053;

  constructor(manifest: PluginManifest) { super(manifest); }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    if (config?.deviceHost) this.deviceHost = config.deviceHost;
    if (config?.devicePort) this.devicePort = Number(config.devicePort);
  }

  async connect(): Promise<void> {
    if (this.isMock()) {
      this.connected = true;
      this.startedAt = new Date().toISOString();
      this.emit('connected', { mock: true });
      return;
    }

    const script = path.join(
      process.cwd(), 'src', 'plugins', 'esphome-satellite', 'python', 'esphome_client.py'
    );

    this.sidecar = cp.spawn('python', [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVICE_HOST: this.deviceHost,
        DEVICE_PORT: String(this.devicePort),
        BAILEY_PORT: '3333',
        WHISPER_PORT: '8790',
        BAILEY_LAN_IP: '192.168.1.x',  // configure to your server's LAN IP,
      },
    });

    this.sidecar.stdout?.on('data', (d: Buffer) =>
      process.stdout.write(`[esphome-py] ${d}`));
    this.sidecar.stderr?.on('data', (d: Buffer) =>
      process.stderr.write(`[esphome-py] ${d}`));
    this.sidecar.on('exit', code => {
      console.log(`[esphome-satellite] sidecar exited: ${code}`);
      this.startedAt = null;
      if (this.connected) {
        this.connected = false;
        this.emit('disconnected');
      }
    });

    await new Promise(r => setTimeout(r, 1500));
    if (this.sidecar && !this.sidecar.killed) {
      this.connected = true;
      this.startedAt = new Date().toISOString();
      this.emit('connected', { mock: false, deviceHost: this.deviceHost, devicePort: this.devicePort });
      console.log(`[esphome-satellite] started â€” device ${this.deviceHost}:${this.devicePort}`);
    }
  }

  async disconnect(): Promise<void> {
    this.sidecar?.kill();
    this.sidecar = null;
    this.startedAt = null;
    this.connected = false;
    this.emit('disconnected');
  }

  getState() {
    return {
      connected: this.connected,
      mock: this.isMock(),
      deviceHost: this.deviceHost,
      devicePort: this.devicePort,
      startedAt: this.startedAt,
      protocol: 'ESPHome native API v42.7',
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/esphome-satellite/state',
        handler: (_req, res) => json(res, this.getState()),
      },
      {
        method: 'POST',
        path: '/api/esphome-satellite/restart',
        handler: async (_req, res) => {
          await this.disconnect();
          await this.connect();
          json(res, { ok: true, state: this.getState() });
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): EspHomeSatellitePlugin {
  return new EspHomeSatellitePlugin(manifest);
}
