// BaileyOS Plugin: Reolink IP Cameras
// RTSP snapshot loop + HLS live streaming via ffmpeg
// RTSP URL format: rtsp://user:pass@host:554/h264Preview_01_main (main)
//                  rtsp://user:pass@host:554/h264Preview_01_sub  (sub)

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface ReolinkCamera {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  online: boolean;
  hasSnapshot: boolean;
  lastSnapshotTime: number | null;
}

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

class ReolinkCamerasPlugin extends BasePlugin {
  private cameras: ReolinkCamera[] = [];
  private snapshotDir = '';
  private hlsDir = '';
  private isRunning = false;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotInterval = 15000; // 15s between full cycles
  private hlsProcs = new Map<string, ChildProcess>();
  private hlsLastAccess = new Map<string, number>();
  private streamProcs = new Map<string, ChildProcess>();
  private hlsReaper: ReturnType<typeof setInterval> | null = null;
  private readonly HLS_IDLE_MS = 60000;

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    const cams: any[] = Array.isArray(config.cameras) ? config.cameras : [];
    this.cameras = cams.map((c: any) => ({
      id: c.id || c.name?.toLowerCase().replace(/\s+/g, '-') || 'cam',
      name: c.name || c.id || 'Camera',
      host: c.host || '',
      port: Number(c.port) || 554,
      username: c.username || 'admin',
      password: c.password || '',
      online: false,
      hasSnapshot: false,
      lastSnapshotTime: null,
    }));
    this.snapshotDir = config.snapshotDir || path.join(process.cwd(), 'data', 'snapshots', 'reolink');
    this.hlsDir = config.hlsDir || path.join(process.cwd(), 'data', 'hls', 'reolink');
  }

  private rtspUrl(cam: ReolinkCamera, sub = false): string {
    const pw = encodeURIComponent(cam.password);
    const auth = cam.password ? `${cam.username}:${pw}@` : `${cam.username}@`;
    const stream = sub ? 'h264Preview_01_sub' : 'h264Preview_01_main';
    return `rtsp://${auth}${cam.host}:${cam.port}/${stream}`;
  }

  private grabSnapshot(cam: ReolinkCamera): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.mockMode) {
        cam.online = true; cam.hasSnapshot = true; cam.lastSnapshotTime = Date.now();
        resolve(true); return;
      }
      const outPath = path.join(this.snapshotDir, `${cam.id}.jpg`);
      const url = this.rtspUrl(cam, true); // sub-stream for snapshots
      const proc = spawn('ffmpeg', [
        '-y', '-rtsp_transport', 'tcp', '-i', url,
        '-frames:v', '1', '-q:v', '3', '-timeout', '5000000', outPath,
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      const killTimer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 8000);
      proc.on('close', (code) => {
        clearTimeout(killTimer);
        const ok = code === 0 && fs.existsSync(outPath);
        cam.online = ok;
        if (ok) { cam.hasSnapshot = true; cam.lastSnapshotTime = Date.now(); }
        resolve(ok);
      });
      proc.on('error', () => { clearTimeout(killTimer); cam.online = false; resolve(false); });
    });
  }

  private async snapshotCycle(): Promise<void> {
    if (!this.isRunning) return;
    for (const cam of this.cameras) {
      if (!this.isRunning) return;
      const streaming = this.hlsProcs.has(cam.id);
      if (!streaming) await this.grabSnapshot(cam);
      if (this.cameras.indexOf(cam) < this.cameras.length - 1 && this.isRunning)
        await new Promise<void>((r) => setTimeout(r, 2000));
    }
    if (this.isRunning)
      this.snapshotTimer = setTimeout(() => this.snapshotCycle(), this.snapshotInterval);
  }

  private ensureHls(cam: ReolinkCamera): string {
    const dir = path.join(this.hlsDir, cam.id);
    this.hlsLastAccess.set(cam.id, Date.now());
    if (this.mockMode || this.hlsProcs.has(cam.id)) return dir;
    fs.mkdirSync(dir, { recursive: true });
    const url = this.rtspUrl(cam, true);
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-use_wallclock_as_timestamps', '1',
      '-rtsp_transport', 'tcp', '-i', url,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28',
      '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
      '-f', 'hls',
      '-hls_time', '1', '-hls_list_size', '3',
      '-hls_flags', 'delete_segments+omit_endlist',
      'index.m3u8',
    ], { stdio: ['ignore', 'ignore', 'ignore'], cwd: dir });
    this.hlsProcs.set(cam.id, proc);
    const onExit = () => {
      if (this.hlsProcs.get(cam.id) === proc) this.hlsProcs.delete(cam.id);
      if (!this.mockMode && (Date.now() - (this.hlsLastAccess.get(cam.id) || 0)) < this.HLS_IDLE_MS) {
        setTimeout(() => {
          if (!this.hlsProcs.has(cam.id)) this.ensureHls(cam);
        }, 1000);
      }
    };
    proc.on('close', onExit);
    proc.on('error', onExit);
    console.log(`[reolink-cameras] HLS started for ${cam.id}`);
    return dir;
  }

  private stopHls(id: string): void {
    const p = this.hlsProcs.get(id);
    if (p) { try { p.kill('SIGKILL'); } catch {} this.hlsProcs.delete(id); }
    this.hlsLastAccess.delete(id);
    const dir = path.join(this.hlsDir, id);
    try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); } catch {}
  }

  private reapHls(): void {
    const now = Date.now();
    for (const [id] of this.hlsProcs) {
      if ((now - (this.hlsLastAccess.get(id) || 0)) > this.HLS_IDLE_MS) {
        console.log(`[reolink-cameras] HLS idle-stop ${id}`);
        this.stopHls(id);
      }
    }
  }

  async connect(): Promise<void> {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    fs.mkdirSync(this.hlsDir, { recursive: true });
    this.isRunning = true;
    this.connected = true;
    this.emit('connected', { mock: this.mockMode });
    console.log(`[reolink-cameras] Connected with ${this.cameras.length} camera(s)`);
    this.snapshotCycle();
    this.hlsReaper = setInterval(() => this.reapHls(), 10000);
  }

  async disconnect(): Promise<void> {
    this.isRunning = false;
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    for (const id of Array.from(this.hlsProcs.keys())) this.stopHls(id);
    if (this.hlsReaper) { clearInterval(this.hlsReaper); this.hlsReaper = null; }
    for (const p of this.streamProcs.values()) { try { p.kill(); } catch {} }
    this.streamProcs.clear();
    this.connected = false;
    this.emit('disconnected');
    console.log('[reolink-cameras] Disconnected');
  }

  getState(): any {
    return {
      connected: this.connected,
      cameras: this.cameras.map((c) => ({
        id: c.id, name: c.name, host: c.host,
        online: c.online, hasSnapshot: c.hasSnapshot, lastSnapshotTime: c.lastSnapshotTime,
      })),
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET', path: '/api/reolink-cameras/state',
        handler: (_req, res) => jsonResponse(res, this.getState()),
      },
      {
        method: 'GET', path: '/api/reolink-cameras/snapshot/:id',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const m = (req.url || '').match(/\/snapshot\/([^/?]+)/);
          const id = m ? m[1] : '';
          const cam = this.cameras.find((c) => c.id === id);
          if (!cam) { jsonResponse(res, { error: 'not found' }, 404); return; }
          const p = path.join(this.snapshotDir, `${cam.id}.jpg`);
          if (!fs.existsSync(p)) { jsonResponse(res, { error: 'no snapshot yet' }, 404); return; }
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          fs.createReadStream(p).pipe(res);
        },
      },
      {
        method: 'GET', path: '/api/reolink-cameras/hls/:id/index.m3u8',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const m = (req.url || '').match(/\/hls\/([^/]+)\//);
          const id = m ? m[1] : '';
          const cam = this.cameras.find((c) => c.id === id);
          if (!cam) { jsonResponse(res, { error: 'not found' }, 404); return; }
          const dir = this.ensureHls(cam);
          const p = path.join(dir, 'index.m3u8');
          let attempts = 0;
          const tryServe = () => {
            if (fs.existsSync(p)) {
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
              fs.createReadStream(p).pipe(res);
            } else if (attempts++ < 60) {
              setTimeout(tryServe, 500);
            } else {
              jsonResponse(res, { error: 'stream not ready' }, 503);
            }
          };
          tryServe();
        },
      },
      {
        method: 'GET', path: '/api/reolink-cameras/hls/:id/:file',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const m = (req.url || '').match(/\/hls\/([^/]+)\/(.+)/);
          if (!m) { res.writeHead(404); res.end(); return; }
          const [, id, file] = m;
          const cam = this.cameras.find((c) => c.id === id);
          if (!cam) { res.writeHead(404); res.end(); return; }
          this.hlsLastAccess.set(id, Date.now());
          const p = path.join(this.hlsDir, id, file);
          if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
          const ct = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
            : file.endsWith('.ts') ? 'video/mp2t'
            : file.endsWith('.mp4') || file.endsWith('.m4s') ? 'video/mp4'
            : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
          fs.createReadStream(p).pipe(res);
        },
      },
      {
        method: 'GET', path: '/api/reolink-cameras/stream/:id',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const m = (req.url || '').match(/\/stream\/([^/?]+)/);
          const id = m ? m[1] : '';
          const cam = this.cameras.find((c) => c.id === id);
          if (!cam) { res.writeHead(404); res.end(); return; }
          if (this.mockMode) { res.writeHead(503); res.end(); return; }

          const existing = this.streamProcs.get(id);
          if (existing) { try { existing.kill(); } catch {} this.streamProcs.delete(id); }

          const url = this.rtspUrl(cam, true);
          const proc = spawn('ffmpeg', [
            '-use_wallclock_as_timestamps', '1',
            '-rtsp_transport', 'tcp', '-i', url,
            '-an', '-f', 'mjpeg', '-q:v', '5', '-r', '15',
            'pipe:1',
          ], { stdio: ['ignore', 'pipe', 'ignore'] });

          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          proc.stdout!.pipe(res, { end: false });
          proc.on('close', () => { try { res.end(); } catch {} this.streamProcs.delete(id); });
          req.on('close', () => { try { proc.kill(); } catch {} this.streamProcs.delete(id); });
          this.streamProcs.set(id, proc);
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): ReolinkCamerasPlugin {
  return new ReolinkCamerasPlugin(manifest);
}
