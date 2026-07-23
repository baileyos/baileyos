// BaileyOS Plugin: XMeye DVR Cameras
// RTSP snapshot + MJPEG streaming via ffmpeg
// Serial snapshot loop: one camera at a time, 2s gap between channels

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// --- Types ---

interface CameraChannel {
  id: number;
  name: string;
  online: boolean;
  hasSnapshot: boolean;
  lastSnapshotTime: number | null;
}

// --- Helper ---

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// --- Plugin Class ---

class XMeyeCamerasPlugin extends BasePlugin {
  private channels: CameraChannel[] = [];
  private snapshotDir: string = '';
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private activeStreams: Map<string, ChildProcess> = new Map();
  private isRunning = false;

  // Config fields
  private host = '';
  private port = 554;
  private username = 'admin';
  private password = '';
  private snapshotInterval = 30000;

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);

    this.host = config.host || '';
    this.port = config.port || 554;
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.snapshotInterval = config.snapshotInterval || 30000;

    // If no host, force mock mode
    if (!this.host) this.mockMode = true;

    this.snapshotDir = config.snapshotDir ||
      path.join(process.cwd(), 'data', 'snapshots', 'xmeye');

    const numChannels = config.channels || 8;
    const channelNames: string[] = config.channelNames || [];
    this.channels = [];
    for (let i = 0; i < numChannels; i++) {
      this.channels.push({
        id: i + 1,
        name: channelNames[i] || `Camera ${i + 1}`,
        online: false,
        hasSnapshot: false,
        lastSnapshotTime: null,
      });
    }
  }

  // RTSP URL builder for XMeye DVR
  private rtspUrl(channel: number, stream: number = 0): string {
    const auth = this.password
      ? `${this.username}:${this.password}@`
      : `${this.username}@`;
    return `rtsp://${auth}${this.host}:${this.port}/user=${this.username}&password=${this.password}&channel=${channel}&stream=${stream}.sdp`;
  }

  // Grab a single JPEG frame from one camera via ffmpeg
  private grabSnapshot(channel: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.mockMode) {
        this.channels[channel - 1].online = true;
        this.channels[channel - 1].hasSnapshot = true;
        this.channels[channel - 1].lastSnapshotTime = Date.now();
        resolve(true);
        return;
      }

      const outPath = path.join(this.snapshotDir, `ch${channel}.jpg`);
      const url = this.rtspUrl(channel, 1); // sub-stream for faster snapshots

      const proc = spawn('ffmpeg', [
        '-y',
        '-rtsp_transport', 'tcp',
        '-i', url,
        '-frames:v', '1',
        '-q:v', '2',
        '-timeout', '5000000',
        outPath,
      ], { stdio: ['ignore', 'ignore', 'ignore'] });

      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(false);
      }, 8000);

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        const success = code === 0;
        this.channels[channel - 1].online = success;
        if (success) {
          this.channels[channel - 1].hasSnapshot = true;
          this.channels[channel - 1].lastSnapshotTime = Date.now();
        }
        resolve(success);
      });

      proc.on('error', () => {
        clearTimeout(killTimer);
        this.channels[channel - 1].online = false;
        resolve(false);
      });
    });
  }

  // Serial snapshot loop: one camera at a time, 2s gap between channels
  private async snapshotCycle(): Promise<void> {
    if (!this.isRunning) return;

    for (let i = 0; i < this.channels.length; i++) {
      if (!this.isRunning) return;
      await this.grabSnapshot(i + 1);
      // 2s gap between channels to avoid overwhelming DVR
      if (i < this.channels.length - 1 && this.isRunning) {
        await new Promise<void>((r) => setTimeout(r, 2000));
      }
    }

    // Schedule next cycle
    if (this.isRunning) {
      this.snapshotTimer = setTimeout(
        () => this.snapshotCycle(),
        this.snapshotInterval,
      );
    }
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.snapshotDir)) {
      fs.mkdirSync(this.snapshotDir, { recursive: true });
    }
    this.isRunning = true;
    this.connected = true;
    this.emit('connected', { mock: this.mockMode });
    console.log('[xmeye-cameras] Connected' + (this.mockMode ? ' (MOCK)' : '') + ' with ' + this.channels.length + ' channels');
    this.snapshotCycle();
  }

  async disconnect(): Promise<void> {
    this.isRunning = false;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    for (const [key, proc] of this.activeStreams) {
      proc.kill();
      this.activeStreams.delete(key);
    }
    this.connected = false;
    this.emit('disconnected');
    console.log('[xmeye-cameras] Disconnected');
  }

  getState(): any {
    return {
      connected: this.connected,
      mock: this.mockMode,
      channels: this.channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        online: ch.online,
        hasSnapshot: ch.hasSnapshot,
        lastSnapshotTime: ch.lastSnapshotTime,
        snapshotUrl: '/api/cameras/snapshot/' + ch.id,
        streamUrl: '/api/cameras/stream/' + ch.id,
      })),
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/cameras/state
      {
        method: 'GET',
        path: '/api/cameras/state',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.getState());
        },
      },

      // GET /api/cameras/snapshot/:channel - returns JPEG image
      {
        method: 'GET',
        path: '/api/cameras/snapshot/:channel',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/cameras\/snapshot\/(\d+)/);
          if (!match) { jsonResponse(res, { error: 'Invalid channel' }, 400); return; }

          const channel = parseInt(match[1], 10);
          if (channel < 1 || channel > this.channels.length) {
            jsonResponse(res, { error: 'Invalid channel' }, 400);
            return;
          }

          if (this.mockMode) {
            // Return a minimal 1x1 dark JPEG placeholder
            const pixel = Buffer.from(
              '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
              'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEB' +
              'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
              'AQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf' +
              '/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAA' +
              'AAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=',
              'base64',
            );
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(pixel);
            return;
          }

          const snapshotPath = path.join(this.snapshotDir, 'ch' + channel + '.jpg');
          if (!fs.existsSync(snapshotPath)) {
            jsonResponse(res, { error: 'No snapshot available' }, 404);
            return;
          }

          const data = fs.readFileSync(snapshotPath);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': data.length.toString(),
            'Cache-Control': 'no-cache',
          });
          res.end(data);
        },
      },

      // GET /api/cameras/stream/:channel - MJPEG live stream
      {
        method: 'GET',
        path: '/api/cameras/stream/:channel',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/cameras\/stream\/(\d+)/);
          if (!match) { jsonResponse(res, { error: 'Invalid channel' }, 400); return; }

          const channel = parseInt(match[1], 10);
          if (channel < 1 || channel > this.channels.length) {
            jsonResponse(res, { error: 'Invalid channel' }, 400);
            return;
          }

          if (this.mockMode) {
            jsonResponse(res, { error: 'No camera host configured (mock mode)' }, 503);
            return;
          }

          // Determine stream quality from query
          const parsedUrl = new URL(url, 'http://localhost');
          const streamQuality = parsedUrl.searchParams.get('stream') === '0' ? 0 : 1;
          const streamKey = channel + '-' + streamQuality;

          // Kill existing stream for this channel/quality
          const existing = this.activeStreams.get(streamKey);
          if (existing) {
            existing.kill();
            this.activeStreams.delete(streamKey);
          }

          const rtspUrl = this.rtspUrl(channel, streamQuality);

          const proc = spawn('ffmpeg', [
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-f', 'mjpeg',
            '-q:v', '5',
            '-r', '15',
            '-an',
            'pipe:1',
          ], { stdio: ['ignore', 'pipe', 'ignore'] });

          res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          proc.stdout!.on('data', (chunk: Buffer) => {
            try {
              res.write('--ffmpeg\r\nContent-Type: image/jpeg\r\nContent-Length: ' + chunk.length + '\r\n\r\n');
              res.write(chunk);
              res.write('\r\n');
            } catch {
              proc.kill();
            }
          });

          proc.on('close', () => {
            try { res.end(); } catch { /* already closed */ }
            this.activeStreams.delete(streamKey);
          });

          req.on('close', () => {
            proc.kill();
          });

          this.activeStreams.set(streamKey, proc);
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): XMeyeCamerasPlugin {
  return new XMeyeCamerasPlugin(manifest);
}
