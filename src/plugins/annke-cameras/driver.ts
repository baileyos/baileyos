// BaileyOS Plugin: Annke DVR Cameras (Hikvision-OEM)
// RTSP snapshot + MJPEG streaming via ffmpeg
// Serial snapshot loop: one camera at a time, 2s gap between channels
// Identical contract to xmeye-cameras; only the RTSP dialect differs
// (Hikvision /Streaming/Channels/<ch>0<streamType> vs Xiongmai .sdp path).

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

// ─── Zone Detection Engine ──────────────────────────────────────────────────

type GarageState = Record<string, { isOpen: boolean; updatedAt: number }>;
type CropRegion = { x: number; y: number; w: number; h: number };

const DIGITAL_ZOOM_FILE = path.join(process.cwd(), 'data', 'digital-zoom.json');

function polyContains(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: any) => { data += c.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

class ZoneDetector {
  static readonly DW = 640;
  static readonly DH = 360;
  static readonly MOTION_THRESH = 18;   // mean per-channel diff (0–255)
  private static readonly ZONE_COOLDOWN = 8000; // ms between same-zone triggers
  private static readonly PHASE_TIMEOUT = 180_000; // 3 min to complete a vehicle pass
  private static readonly PERSON_SUPPRESS_MS = 10_000; // suppress garage toggle if person seen within 10s

  private cropCache: { ts: number; data: Record<string, CropRegion> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private prevFrames  = new Map<string, Buffer>();     // camId → raw RGB
  private masks       = new Map<string, Uint8Array>(); // zoneId → pixel bitmask
  private cooldowns          = new Map<string, number>(); // zoneId → last trigger ms
  private checkpointFiredAt  = new Map<number, number>(); // cam → last checkpoint fire ms
  lastDebug: { ts: number; cam: number; zoneId: string; name: string; score: number; thresh: number; fired: boolean }[] = [];
  private phase: 'idle' | 'gate' | 'deep' = 'idle';
  private phaseStart  = 0;
  private garageState: GarageState = {};
  private sseClients: ServerResponse[] = [];

  constructor(
    private readonly makeUrl:       (ch: number, st: number) => string,
    private readonly zonesPath:     string,
    private readonly gStatePath:    string,
    private readonly activeStreams: Map<string, ChildProcess>,
  ) {
    this.loadGarageState();
  }

  start(): void {
    this.timer = setInterval(() =>
      this.tick().catch(e => console.error('[annke-cameras] detect:', e)), 2000);
    // Initial state scan after 10s (let ffmpeg/RTSP settle), then every 5 min
    setTimeout(() => this.scanGarageState().catch(e => console.error('[annke-cameras] scan:', e)), 10000);
    this.scanTimer = setInterval(() =>
      this.scanGarageState().catch(e => console.error('[annke-cameras] scan:', e)), 300000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    this.sseClients.forEach(r => { try { r.end(); } catch {} });
    this.sseClients = [];
    this.prevFrames.clear();
    this.masks.clear();
    this.cooldowns.clear();
    this.phase = 'idle';
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'connected', garageState: this.garageState }) + '\n\n');
    this.sseClients.push(res);
    res.on('close', () => { this.sseClients = this.sseClients.filter(c => c !== res); });
  }

  setDoorState(zoneId: string, isOpen: boolean): void {
    const prev = this.garageState[zoneId];
    const changed = !prev || prev.isOpen !== isOpen;
    this.garageState[zoneId] = { isOpen, updatedAt: Date.now() };
    this.saveGarageState();
    if (changed) this.broadcast({ type: 'garage-door-update', zoneId, isOpen });
  }

  getDoorStates(): GarageState { return { ...this.garageState }; }

  private loadGarageState(): void {
    try {
      if (fs.existsSync(this.gStatePath))
        this.garageState = JSON.parse(fs.readFileSync(this.gStatePath, 'utf8'));
    } catch {}
  }

  private saveGarageState(): void {
    try {
      const d = path.dirname(this.gStatePath);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(this.gStatePath, JSON.stringify(this.garageState, null, 2), 'utf8');
    } catch {}
  }

  private loadZones(): Record<string, any[]> {
    try {
      if (fs.existsSync(this.zonesPath)) return JSON.parse(fs.readFileSync(this.zonesPath, 'utf8'));
    } catch {}
    return {};
  }

  private getMask(id: string, pts: [number, number][], crop?: CropRegion): Uint8Array {
    if (this.masks.has(id)) return this.masks.get(id)!;
    const DW = ZoneDetector.DW, DH = ZoneDetector.DH;
    const m = new Uint8Array(DW * DH);
    // If zone coords are crop-relative, transform back to full-frame before masking
    const fullPts: [number, number][] = crop
      ? pts.map(([x, y]) => [crop.x + x * crop.w, crop.y + y * crop.h])
      : pts;
    for (let y = 0; y < DH; y++) {
      const fy = y / DH;
      for (let x = 0; x < DW; x++)
        if (polyContains(x / DW, fy, fullPts)) m[y * DW + x] = 1;
    }
    this.masks.set(id, m);
    return m;
  }

  private motionScore(prev: Buffer, curr: Buffer, mask: Uint8Array): number {
    let sum = 0, n = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = i * 3;
      sum += (Math.abs(curr[p] - prev[p]) + Math.abs(curr[p+1] - prev[p+1]) + Math.abs(curr[p+2] - prev[p+2])) / 3;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }

  private grabFrame(ch: number): Promise<Buffer | null> {
    return new Promise(resolve => {
      const DW = ZoneDetector.DW, DH = ZoneDetector.DH;
      const proc = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp', '-i', this.makeUrl(ch, 1),
        '-frames:v', '1', '-vf', `scale=${DW}:${DH}`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      proc.stdout!.on('data', (c: Buffer) => chunks.push(c));
      const t = setTimeout(() => { proc.kill(); resolve(null); }, 6000);
      proc.on('close', code => { clearTimeout(t); resolve(code === 0 ? Buffer.concat(chunks) : null); });
      proc.on('error', () => { clearTimeout(t); resolve(null); });
    });
  }

  private loadCropConfig(): Record<string, CropRegion> {
    const now = Date.now();
    if (this.cropCache && now - this.cropCache.ts < 5000) return this.cropCache.data;
    let data: Record<string, CropRegion> = {};
    try {
      if (fs.existsSync(DIGITAL_ZOOM_FILE))
        data = JSON.parse(fs.readFileSync(DIGITAL_ZOOM_FILE, 'utf8'));
    } catch {}
    this.cropCache = { ts: now, data };
    return data;
  }

  private grabFrameCropped(ch: number, crop?: CropRegion): Promise<Buffer | null> {
    return new Promise(resolve => {
      const DW = ZoneDetector.DW, DH = ZoneDetector.DH;
      const filters: string[] = [];
      if (crop) {
        filters.push(`crop=iw*${crop.w.toFixed(5)}:ih*${crop.h.toFixed(5)}:iw*${crop.x.toFixed(5)}:ih*${crop.y.toFixed(5)}`);
      }
      filters.push(`scale=${DW}:${DH}`);
      const proc = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp', '-i', this.makeUrl(ch, 1),
        '-frames:v', '1', '-vf', filters.join(','),
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      proc.stdout!.on('data', (c: Buffer) => chunks.push(c));
      const t = setTimeout(() => { proc.kill(); resolve(null); }, 6000);
      proc.on('close', code => { clearTimeout(t); resolve(code === 0 ? Buffer.concat(chunks) : null); });
      proc.on('error', () => { clearTimeout(t); resolve(null); });
    });
  }

  clearCropCache(): void { this.cropCache = null; }

  private async tick(): Promise<void> {
    const zones = this.loadZones();
    const now = Date.now();

    if (this.phase !== 'idle' && now - this.phaseStart > ZoneDetector.PHASE_TIMEOUT) {
      console.log('[annke-cameras] Vehicle phase timeout — resetting');
      this.phase = 'idle';
    }

    const cameras = new Set<number>();
    for (const [camId, zlist] of Object.entries(zones)) {
      const ch = parseInt(camId, 10);
      if (!isNaN(ch) && Array.isArray(zlist) && zlist.length > 0) cameras.add(ch);
    }
    if (cameras.size === 0) return;

    // Grab frames for all relevant cameras in parallel.
    // Skip any channel that has an active MJPEG stream — a second RTSP connection
    // to the same sub-stream URL can cause the DVR to drop the live viewer.
    const cropConfig = this.loadCropConfig();
    const results = await Promise.all(
      [...cameras].map(async ch => ({
        ch,
        frame: (this.activeStreams.has(`${ch}-0`) || this.activeStreams.has(`${ch}-1`))
          ? null : await this.grabFrame(ch),
      }))
    );

    for (const { ch, frame } of results) {
      if (!frame) continue;
      const key = String(ch);
      const prev = this.prevFrames.get(key);
      this.prevFrames.set(key, frame);
      if (!prev || prev.length !== frame.length) continue;

      for (const zone of ((zones[key] || []) as any[])) {
        if (now - (this.cooldowns.get(zone.id) || 0) < ZoneDetector.ZONE_COOLDOWN) continue;
        const mask = this.getMask(zone.id, zone.points as [number, number][], cropConfig[key]);
        const score = this.motionScore(prev, frame, mask);
        const fired = score >= ZoneDetector.MOTION_THRESH;
        if (zone.type === 'garage-door' || zone.type === 'garage-monitor') {
          this.lastDebug.push({ ts: now, cam: ch, zoneId: zone.id, name: zone.name, score: Math.round(score), thresh: ZoneDetector.MOTION_THRESH, fired });
          if (this.lastDebug.length > 50) this.lastDebug.shift();
        }
        if (fired) {
          this.cooldowns.set(zone.id, now);
          if (zone.type === 'checkpoint')
            this.onCheckpoint(zone.order as number, zone.name as string, ch, now);
          // garage-door state is now managed exclusively by the Python vision service (port 3340)
        }
      }
    }
  }

  private onCheckpoint(order: number, name: string, cam: number, now: number): void {
    this.checkpointFiredAt.set(cam, now);
    console.log(`[annke-cameras] CP${order} "${name}" cam${cam} phase=${this.phase}`);
    this.broadcast({ type: 'motion', checkpoint: order, name, camera: cam });
    const isGate = order <= 2, isDeep = order >= 3;
    if (this.phase === 'idle') {
      this.phase = isGate ? 'gate' : 'deep'; this.phaseStart = now; return;
    }
    if (this.phase === 'gate' && isDeep) {
      console.log('[annke-cameras] VEHICLE ENTRY');
      this.broadcast({ type: 'vehicle-entry', message: 'Vehicle entered the property' });
      this.phase = 'idle';
    } else if (this.phase === 'deep' && isGate) {
      console.log('[annke-cameras] VEHICLE EXIT');
      this.broadcast({ type: 'vehicle-exit', message: 'Vehicle exited the property' });
      this.phase = 'idle';
    } else {
      this.phaseStart = now; // same-class checkpoint — refresh timeout
    }
  }

  private onGarageDoor(zoneId: string, name: string, cam: number, now: number): void {
    const lastCP = this.checkpointFiredAt.get(cam) ?? 0;
    if (now - lastCP < ZoneDetector.PERSON_SUPPRESS_MS) {
      console.log(`[annke-cameras] ${name}: toggle suppressed (person on cam${cam} ${Math.round((now - lastCP) / 1000)}s ago)`);
      return;
    }
    const wasOpen = this.garageState[zoneId]?.isOpen ?? false;
    const isOpen = !wasOpen;
    this.garageState[zoneId] = { isOpen, updatedAt: now };
    this.saveGarageState();
    console.log(`[annke-cameras] ${name}: ${wasOpen ? 'OPEN→CLOSED' : 'CLOSED→OPEN'}`);
    this.broadcast({
      type: 'garage-door', zoneId, name, camera: cam, isOpen,
      message: `${name}: ${isOpen ? 'Opened' : 'Closed'}`,
    });
  }

  // Absolute brightness scan — grabs a live frame and classifies each garage-door zone
  // as open (dark interior) or closed (bright door face).
  // Zone config can override threshold with a `brightnessThreshold` field (0–255, default 80).
  async scanGarageState(): Promise<Record<string, { isOpen: boolean; brightness: number }>> {
    const zones = this.loadZones();
    const results: Record<string, { isOpen: boolean; brightness: number }> = {};

    // Collect channels that have at least one garage-door zone
    const camChannels = new Set<number>();
    for (const [camId, zlist] of Object.entries(zones)) {
      const ch = parseInt(camId, 10);
      if (!isNaN(ch) && Array.isArray(zlist) && (zlist as any[]).some((z: any) => z.type === 'garage-door'))
        camChannels.add(ch);
    }
    if (camChannels.size === 0) return results;

    console.log('[annke-cameras] Garage scan: channels', [...camChannels].join(','));

    for (const ch of camChannels) {
      // Skip channels with an active live stream to avoid DVR stream conflicts
      if (this.activeStreams.has(`${ch}-0`) || this.activeStreams.has(`${ch}-1`)) continue;
      const frame = await this.grabFrame(ch);
      if (!frame) { console.log(`[annke-cameras] Garage scan: no frame from ch${ch}`); continue; }

      for (const zone of ((zones[String(ch)] || []) as any[])) {
        if (zone.type !== 'garage-door') continue;
        if (zone.brightnessThreshold == null) continue; // skip uncalibrated zones
        const mask = this.getMask(zone.id, zone.points as [number, number][]);
        const brightness = this.meanBrightness(frame, mask);
        const threshold: number = zone.brightnessThreshold;
        const isOpen = brightness < threshold;
        results[zone.id] = { isOpen, brightness: Math.round(brightness) };
        const prev = this.garageState[zone.id];
        if (!prev || prev.isOpen !== isOpen) {
          console.log(`[annke-cameras] Scan: "${zone.name}" brightness=${Math.round(brightness)} threshold=${threshold} → ${isOpen ? 'OPEN' : 'CLOSED'}`);
          this.setDoorState(zone.id, isOpen);
        }
      }
    }

    return results;
  }

  private meanBrightness(frame: Buffer, mask: Uint8Array): number {
    let sum = 0, n = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = i * 3;
      sum += (frame[p] + frame[p + 1] + frame[p + 2]) / 3;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }

  private broadcast(data: object): void {
    const msg = 'data: ' + JSON.stringify({ ...data, time: Date.now() }) + '\n\n';
    for (let i = this.sseClients.length - 1; i >= 0; i--) {
      try { this.sseClients[i].write(msg); } catch { this.sseClients.splice(i, 1); }
    }
  }
}

// --- Plugin Class ---

class AnnkeCamerasPlugin extends BasePlugin {
  private channels: CameraChannel[] = [];
  private snapshotDir: string = '';
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private activeStreams: Map<string, ChildProcess> = new Map();
  private isRunning = false;
  // Channels currently being snapshot-captured (background cycle or on-demand)
  private pendingCaptures = new Set<number>();

  // Config fields
  private host = '';
  private port = 554;
  private username = 'admin';
  private password = '';
  private snapshotInterval = 30000;
  private channelMap: number[] = [];

  // Zone detection (vehicle entry/exit + garage door state)
  private detector: ZoneDetector | null = null;

  // HLS live streaming (HEVC copy → fMP4, Safari-native <video>)
  private hlsDir = '';
  private hlsProcs: Map<number, ChildProcess> = new Map();
  private hlsLastAccess: Map<number, number> = new Map();
  private hlsReaper: ReturnType<typeof setInterval> | null = null;
  private readonly HLS_IDLE_MS = 120000;

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);

    this.host = config.host || '';
    this.port = config.port || 554;
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.snapshotInterval = config.snapshotInterval || 10000;

    // If no host, force mock mode
    if (!this.host) this.mockMode = true;

    this.snapshotDir = config.snapshotDir ||
      path.join(process.cwd(), 'data', 'snapshots', 'annke');
    this.hlsDir = config.hlsDir ||
      path.join(process.cwd(), 'data', 'hls', 'annke');

    this.channelMap = config.channelMap || [];

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

    const zonesPath = path.join(process.cwd(), 'data', 'zones.json');
    const gStatePath = path.join(process.cwd(), 'data', 'garage-state.json');
    this.detector = new ZoneDetector(this.rtspUrl.bind(this), zonesPath, gStatePath, this.activeStreams);
  }

  // RTSP URL builder for Annke / Hikvision DVR.
  // Path: /Streaming/Channels/<channel>0<streamType>  (streamType 1 = main/HD, 2 = sub/SD).
  // Driver `stream` arg follows xmeye convention: 0 = HD (main), 1 = SD (sub).
  // channelMap remaps logical channel IDs to actual DVR channel numbers (e.g. logical 8 → DVR 10).
  private rtspUrl(channel: number, stream: number = 0): string {
    const dvrChannel = (this.channelMap[channel - 1]) || channel;
    const streamType = stream === 0 ? 1 : 2;
    const pw = encodeURIComponent(this.password);
    const auth = this.password ? `${this.username}:${pw}@` : `${this.username}@`;
    return `rtsp://${auth}${this.host}:${this.port}/Streaming/Channels/${dvrChannel}0${streamType}`;
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
      const ch = i + 1;
      // Skip snapshot while this channel has an active MJPEG stream — grabbing a second
      // RTSP connection to the same sub-stream URL can cause the DVR to drop the live
      // stream, producing a visible flicker in the enlarged camera view.
      const isStreaming = this.activeStreams.has(`${ch}-0`) || this.activeStreams.has(`${ch}-1`);
      if (!isStreaming && !this.pendingCaptures.has(ch)) {
        this.pendingCaptures.add(ch);
        try { await this.grabSnapshot(ch); } finally { this.pendingCaptures.delete(ch); }
      }
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
    console.log('[annke-cameras] Connected' + (this.mockMode ? ' (MOCK)' : '') + ' with ' + this.channels.length + ' channels');
    this.snapshotCycle();
    // Reap idle HLS streams (stop ffmpeg when no client has fetched for HLS_IDLE_MS)
    this.hlsReaper = setInterval(() => this.reapHls(), 10000);
    // Start zone detection (vehicle & garage door) — real cameras only
    if (!this.mockMode) this.detector?.start();
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
    if (this.hlsReaper) { clearInterval(this.hlsReaper); this.hlsReaper = null; }
    for (const ch of Array.from(this.hlsProcs.keys())) this.stopHls(ch);
    this.detector?.stop();
    this.connected = false;
    this.emit('disconnected');
    console.log('[annke-cameras] Disconnected');
  }

  // ---- HLS live streaming (HEVC copy → fMP4, played natively by Safari <video>) ----
  // Uses the sub-stream (~1s GOP) so `-c:v copy` yields ~1s segments — no transcode.
  // ffmpeg per channel is spawned on first HLS request and idle-reaped when unwatched.

  private ensureHls(ch: number): string {
    const dir = path.join(this.hlsDir, 'ch' + ch);
    this.hlsLastAccess.set(ch, Date.now());
    if (this.mockMode || this.hlsProcs.has(ch)) return dir;

    fs.mkdirSync(dir, { recursive: true });
    // Do NOT wipe the dir here. On a respawn (e.g. RTSP hiccup) wiping would yank the
    // segments the player is mid-playback on and stall it. `append_list` continues the
    // existing playlist + media sequence; delete_segments prunes old ones. The dir is
    // cleaned only on a real idle-stop (stopHls), so a cold start is already clean.

    const url = this.rtspUrl(ch, 1); // sub-stream (HEVC, short GOP)
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-i', url,
      '-an', '-c:v', 'copy', '-tag:v', 'hvc1',
      '-f', 'hls',
      // 2s segments, keep 10 (~20s live window). The DVR sub-stream has a jittery ~1s GOP;
      // a tight window (was 1s x6) let Safari drift off the live edge and stall when the
      // next segment had already been rotated out. A wider window absorbs that drift.
      '-hls_time', '2',
      '-hls_list_size', '10',
      '-hls_flags', 'append_list+delete_segments+independent_segments+omit_endlist',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      'index.m3u8',
    ], { stdio: ['ignore', 'ignore', 'ignore'], cwd: dir });

    this.hlsProcs.set(ch, proc);
    const onExit = () => {
      if (this.hlsProcs.get(ch) === proc) this.hlsProcs.delete(ch);
      // If the channel is still being watched, auto-respawn so an RTSP drop doesn't
      // permanently freeze the live view (without wiping segments → smooth recovery).
      if (!this.mockMode && (Date.now() - (this.hlsLastAccess.get(ch) || 0)) < this.HLS_IDLE_MS) {
        setTimeout(() => {
          const stillWatched = (Date.now() - (this.hlsLastAccess.get(ch) || 0)) < this.HLS_IDLE_MS;
          if (stillWatched && !this.hlsProcs.has(ch)) this.ensureHls(ch);
        }, 1000);
      }
    };
    proc.on('close', onExit);
    proc.on('error', onExit);
    console.log('[annke-cameras] HLS started for ch' + ch);
    return dir;
  }

  private stopHls(ch: number): void {
    const p = this.hlsProcs.get(ch);
    if (p) { try { p.kill('SIGKILL'); } catch {} this.hlsProcs.delete(ch); }
    this.hlsLastAccess.delete(ch);
    const dir = path.join(this.hlsDir, 'ch' + ch);
    try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); } catch {}
  }

  private reapHls(): void {
    const now = Date.now();
    for (const [ch, last] of Array.from(this.hlsLastAccess.entries())) {
      if (now - last > this.HLS_IDLE_MS) {
        this.stopHls(ch);
        console.log('[annke-cameras] HLS idle-stopped ch' + ch);
      }
    }
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
              'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEB' +
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

          // On-demand refresh: if the stored file is stale (>10s old) and no capture
          // is already running for this channel, kick off a background grab so the NEXT
          // poll (dashboard polls every 6s) returns a fresh frame.
          if (!this.mockMode && !this.pendingCaptures.has(channel)) {
            let stale = true;
            try { stale = (Date.now() - fs.statSync(snapshotPath).mtimeMs) > 10000; } catch {}
            if (stale) {
              this.pendingCaptures.add(channel);
              this.grabSnapshot(channel).finally(() => this.pendingCaptures.delete(channel));
            }
          }

          if (!fs.existsSync(snapshotPath)) {
            jsonResponse(res, { error: 'No snapshot available' }, 404);
            return;
          }

          const data = fs.readFileSync(snapshotPath);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': data.length.toString(),
            'Cache-Control': 'no-cache, no-store',
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
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          // Pipe raw MJPEG bytes — no multipart boundary headers. The client uses
          // SOI/EOI marker scanning to extract frames; injecting headers between chunks
          // of the same JPEG corrupted frames and caused createImageBitmap to fail on
          // most frames, producing the visible flicker.
          proc.stdout!.pipe(res, { end: false });

          proc.on('close', () => {
            try { res.end(); } catch {}
            this.activeStreams.delete(streamKey);
          });

          req.on('close', () => {
            proc.kill();
            this.activeStreams.delete(streamKey);
          });

          this.activeStreams.set(streamKey, proc);
        },
      },

      // GET /api/cameras/hls/:channel/:file - HLS manifest + fMP4 segments (Safari-native <video>)
      {
        method: 'GET',
        path: '/api/cameras/hls/:channel/:file',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const params = (req as any).params || {};
          const channel = parseInt(params.channel, 10);
          const file = path.basename(String(params.file || ''));
          if (!channel || channel < 1 || channel > this.channels.length) {
            jsonResponse(res, { error: 'Invalid channel' }, 400); return;
          }
          if (this.mockMode) { jsonResponse(res, { error: 'mock mode' }, 503); return; }

          const dir = this.ensureHls(channel);
          this.hlsLastAccess.set(channel, Date.now());
          const fp = path.join(dir, file);
          const isManifest = file.endsWith('.m3u8');
          // On cold start, wait briefly for ffmpeg to produce the file
          let tries = isManifest ? 60 : 8;
          while (!fs.existsSync(fp) && tries-- > 0) {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!fs.existsSync(fp)) { jsonResponse(res, { error: 'Stream not ready' }, 503); return; }

          const ct = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
            : (file.endsWith('.mp4') || file.endsWith('.m4s')) ? 'video/mp4'
            : 'application/octet-stream';
          const data = fs.readFileSync(fp);
          res.writeHead(200, {
            'Content-Type': ct,
            'Cache-Control': 'no-cache',
            'Content-Length': data.length.toString(),
          });
          res.end(data);
        },
      },

      // GET /api/cameras/zones — read zone config
      {
        method: 'GET',
        path: '/api/cameras/zones',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          const zonesPath = path.join(process.cwd(), 'data', 'zones.json');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(fs.existsSync(zonesPath) ? fs.readFileSync(zonesPath, 'utf8') : '{}');
        },
      },

      // POST /api/cameras/zones — write zone config
      {
        method: 'POST',
        path: '/api/cameras/zones',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => { data += chunk.toString(); });
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });
          const dataDir = path.join(process.cwd(), 'data');
          if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(path.join(dataDir, 'zones.json'), body, 'utf8');
          jsonResponse(res, { ok: true });
        },
      },

      // GET /plugins/annke-cameras/zone-editor.html — serve the zone drawing tool
      {
        method: 'GET',
        path: '/plugins/annke-cameras/zone-editor.html',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          const htmlPath = path.join(__dirname, 'zone-editor.html');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(htmlPath, 'utf8'));
        },
      },

      // GET /api/cameras/events — SSE stream: vehicle-entry, vehicle-exit, garage-door, motion
      {
        method: 'GET',
        path: '/api/cameras/events',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          if (!this.detector) { jsonResponse(res, { error: 'Detector not ready' }, 503); return; }
          this.detector.addClient(res);
        },
      },

      // GET /api/cameras/garage-state — current known garage door open/closed state
      {
        method: 'GET',
        path: '/api/cameras/garage-state',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.detector ? this.detector.getDoorStates() : {});
        },
      },

      // POST /api/cameras/garage-state — manually set a door's known state { zoneId, isOpen }
      {
        method: 'POST',
        path: '/api/cameras/garage-state',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await readBody(req);
          const { zoneId, isOpen } = JSON.parse(body);
          if (typeof zoneId !== 'string') { jsonResponse(res, { error: 'zoneId required' }, 400); return; }
          this.detector?.setDoorState(zoneId, !!isOpen);
          jsonResponse(res, { ok: true });
        },
      },

      // GET /api/cameras/detect-debug
      {
        method: 'GET',
        path: '/api/cameras/detect-debug',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, {
            resolution: `${ZoneDetector.DW}x${ZoneDetector.DH}`,
            threshold: ZoneDetector.MOTION_THRESH,
            lastScores: this.detector?.lastDebug ?? [],
          });
        },
      },

      // POST /api/cameras/garage-visual-state — receives state push from vision service
      {
        method: 'POST',
        path: '/api/cameras/garage-visual-state',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            const body = await readBody(req);
            const data = JSON.parse(body);
            if (Array.isArray(data.doors)) {
              for (const door of data.doors) {
                if (door.zoneId && typeof door.isOpen === 'boolean') {
                  this.detector?.setDoorState(door.zoneId, door.isOpen);
                }
              }
            }
            jsonResponse(res, { ok: true });
          } catch (e) { jsonResponse(res, { ok: false, error: String(e) }, 400); }
        },
      },

      // GET /api/cameras/digital-zoom
      {
        method: 'GET',
        path: '/api/cameras/digital-zoom',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          try {
            if (fs.existsSync(DIGITAL_ZOOM_FILE))
              jsonResponse(res, JSON.parse(fs.readFileSync(DIGITAL_ZOOM_FILE, 'utf8')));
            else
              jsonResponse(res, {});
          } catch { jsonResponse(res, {}); }
        },
      },

      // POST /api/cameras/digital-zoom
      {
        method: 'POST',
        path: '/api/cameras/digital-zoom',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const body = await readBody(req);
          try {
            const data = JSON.parse(body);
            fs.writeFileSync(DIGITAL_ZOOM_FILE, JSON.stringify(data, null, 2), 'utf8');
            if (this.detector) this.detector.clearCropCache();
            jsonResponse(res, { ok: true });
          } catch (e) { jsonResponse(res, { ok: false, error: String(e) }, 400); }
        },
      },

      // POST /api/cameras/garage-scan — grab live frames and re-verify open/closed state via brightness
      {
        method: 'POST',
        path: '/api/cameras/garage-scan',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          if (!this.detector) { jsonResponse(res, { error: 'Detector not ready' }, 503); return; }
          try {
            const results = await this.detector.scanGarageState();
            jsonResponse(res, { ok: true, results });
          } catch (err: any) {
            jsonResponse(res, { error: err.message }, 500);
          }
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): AnnkeCamerasPlugin {
  return new AnnkeCamerasPlugin(manifest);
}
