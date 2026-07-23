// MalamaOS Plugin: Audio Bridge
// Routes Bailey TTS announcements to HTD Lync 12 zones via PC audio output.
// Flow: Bailey calls /api/audio-bridge/speak → switch zone to PC source → play WAV via SoundPlayer → restore zone.
//
// MONDAY SETUP:
//   1. Connect USB→RCA from Bailey-AI audio out to an open HTD source input
//   2. Note the HTD source number (e.g. physical jacks 13-14 = Source 7)
//   3. Set pcSourceHtdInput in config.json to that source number
//   4. Test: POST /api/audio-bridge/test { "zone": 1 }

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';

interface AudioBridgeConfig {
  serverPort?: number;
  // HTD source number the USB→RCA PC audio feeds into. Confirm Monday.
  // Physical jacks: 1-2=Src1, 3-4=Src2, ..., 13-14=Src7, 15-16=Src8.
  pcSourceHtdInput?: number;
  defaultVolume?: number;  // 0–60 scale; 0 = don't change volume
  dwellMs?: number;        // ms to wait after source switch for amplifier to route audio
  speakVoice?: string;
  // Map of room name (lowercase) → HTD zone number for /speak with {room}
  zones?: Record<string, number>;
}

interface SpeakRequest {
  text: string;
  zones?: number[];
  room?: string;
  voice?: string;
  volume?: number;
}

function jsonResponse(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function playWav(wavFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // SoundPlayer.PlaySync() blocks the PowerShell process until playback completes.
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(New-Object System.Media.SoundPlayer '${wavFile.replace(/'/g, "''")}').PlaySync()`],
      { timeout: 120_000 },
      (err) => err ? reject(err) : resolve(),
    );
  });
}

class AudioBridgePlugin extends BasePlugin {
  private cfg!: Required<AudioBridgeConfig>;
  private lastSpeak: { ts: string; text: string; zones: number[] } | null = null;
  private speaking = false;

  constructor(manifest: PluginManifest) { super(manifest); }

  async init(config: any, mockMode = false): Promise<void> {
    await super.init(config, mockMode);
    this.cfg = {
      serverPort:       config.serverPort      ?? 3333,
      pcSourceHtdInput: config.pcSourceHtdInput ?? 7,
      defaultVolume:    config.defaultVolume    ?? 25,
      dwellMs:          config.dwellMs          ?? 1500,
      speakVoice:       config.speakVoice       ?? 'af_bella',
      zones:            config.zones            ?? {},
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit('connected', { mock: this.isMock() });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit('disconnected');
  }

  getState() {
    return {
      connected: this.connected,
      mock: this.isMock(),
      pcSourceHtdInput: this.cfg.pcSourceHtdInput,
      defaultVolume: this.cfg.defaultVolume,
      dwellMs: this.cfg.dwellMs,
      speaking: this.speaking,
      lastSpeak: this.lastSpeak,
      zoneMap: this.cfg.zones,
    };
  }

  private base = () => `http://127.0.0.1:${this.cfg.serverPort}`;

  private resolveZones(body: SpeakRequest): number[] {
    if (body.zones?.length) return body.zones;
    if (body.room) {
      const zone = this.cfg.zones[body.room.toLowerCase()];
      if (zone) return [zone];
    }
    return [];
  }

  private async speakInZones(text: string, zones: number[], voice: string, volume: number): Promise<void> {
    if (this.isMock()) {
      console.log(`[audio-bridge] MOCK speak: "${text}" zones=${zones}`);
      return;
    }
    if (this.speaking) {
      console.warn('[audio-bridge] already speaking — queued request dropped');
      return;
    }
    this.speaking = true;
    this.emit('stateChange', this.getState());

    const base = this.base();

    // Save current zone states so we can restore them after speaking.
    let prevStates: Map<number, { power: boolean; source: number; volume: number; mute: boolean }> = new Map();
    try {
      const stateRes = await fetch(`${base}/api/audio/state`);
      const stateData: any = await stateRes.json();
      for (const z of (stateData.zones ?? [])) {
        if (zones.includes(z.zone)) {
          prevStates.set(z.zone, { power: z.power, source: z.source, volume: z.volume, mute: z.mute });
        }
      }
    } catch (e) {
      console.warn('[audio-bridge] could not read HTD state — will not restore:', e);
    }

    const h = { 'Content-Type': 'application/json' };
    const post = (url: string, body: any) =>
      fetch(`${base}${url}`, { method: 'POST', headers: h, body: JSON.stringify(body) }).catch(() => {});

    try {
      for (const z of zones) {
        const prev = prevStates.get(z);
        // Mute first for a clean transition if the zone is already playing something.
        if (prev?.power) await post(`/api/audio/zone/${z}/mute`, { mute: true });
        await post(`/api/audio/zone/${z}/power`, { on: true });
        await post(`/api/audio/zone/${z}/source`, { source: this.cfg.pcSourceHtdInput });
        if (volume > 0) await post(`/api/audio/zone/${z}/volume`, { level: volume });
        // Unmute so the announcement is audible.
        await post(`/api/audio/zone/${z}/mute`, { mute: false });
      }

      // Wait for the zone to physically switch and the amplifier to route.
      await new Promise(r => setTimeout(r, this.cfg.dwellMs));

      // Generate TTS via voice-assistant plugin (confirmed route: POST /api/voice/speak → WAV).
      const ttsRes = await fetch(`${base}/api/voice/speak`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ text, voice }),
      });
      if (!ttsRes.ok) throw new Error(`TTS request failed: ${ttsRes.status}`);

      const audioBytes = Buffer.from(await ttsRes.arrayBuffer());
      const tmpFile = path.join(os.tmpdir(), `bailey-tts-${Date.now()}.wav`);
      fs.writeFileSync(tmpFile, audioBytes);

      try {
        await playWav(tmpFile);
      } finally {
        fs.unlink(tmpFile, () => {});
      }

    } finally {
      // Brief gap after audio ends before switching source back.
      await new Promise(r => setTimeout(r, 400));

      // Restore zones: mute → restore source + volume → restore mute state → power off if was off.
      for (const z of zones) {
        const prev = prevStates.get(z);
        await post(`/api/audio/zone/${z}/mute`, { mute: true });
        if (prev) {
          await post(`/api/audio/zone/${z}/source`, { source: prev.source });
          if (prev.volume > 0) await post(`/api/audio/zone/${z}/volume`, { level: prev.volume });
          await post(`/api/audio/zone/${z}/mute`, { mute: prev.mute });
          if (!prev.power) await post(`/api/audio/zone/${z}/power`, { on: false });
        }
      }

      this.speaking = false;
      this.emit('stateChange', this.getState());
    }
  }

  getRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/audio-bridge/state',
        handler: (_req, res) => jsonResponse(res, this.getState()),
      },
      {
        method: 'GET',
        path: '/api/audio-bridge/zones',
        handler: (_req, res) => jsonResponse(res, {
          zones: this.cfg.zones,
          pcSourceHtdInput: this.cfg.pcSourceHtdInput,
        }),
      },
      {
        method: 'POST',
        path: '/api/audio-bridge/speak',
        handler: async (req, res) => {
          const body: SpeakRequest = await parseBody(req);
          if (!body.text?.trim()) return jsonResponse(res, { error: 'text is required' }, 400);

          const zones = this.resolveZones(body);
          if (!zones.length) {
            return jsonResponse(res, {
              error: 'Specify zones[] array or room name. Configure zones map in config.json.',
            }, 400);
          }

          const voice = body.voice ?? this.cfg.speakVoice;
          const volume = body.volume ?? this.cfg.defaultVolume;
          this.lastSpeak = { ts: new Date().toISOString(), text: body.text, zones };

          // Fire-and-forget — caller gets 202 immediately; audio plays async.
          this.speakInZones(body.text, zones, voice, volume).catch(e =>
            console.error('[audio-bridge] speak error:', e.message),
          );

          jsonResponse(res, { ok: true, zones, text: body.text, voice, volume }, 202);
        },
      },
      {
        method: 'POST',
        path: '/api/audio-bridge/test',
        handler: async (req, res) => {
          const body = await parseBody(req);
          const zone = parseInt(body.zone, 10);
          if (!zone || zone < 1 || zone > 12) {
            return jsonResponse(res, { error: 'zone (1–12) required' }, 400);
          }
          const text = 'Bailey is online and ready.';
          this.speakInZones(text, [zone], this.cfg.speakVoice, this.cfg.defaultVolume).catch(e =>
            console.error('[audio-bridge] test error:', e.message),
          );
          jsonResponse(res, { ok: true, zone, text }, 202);
        },
      },
    ];
  }
}

export function createPlugin(manifest: PluginManifest): AudioBridgePlugin {
  return new AudioBridgePlugin(manifest);
}
