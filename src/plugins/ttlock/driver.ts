// MalamaOS Plugin: TTLock Smart Locks
// TTLock Cloud API v3: https://euapi.ttlock.com/v3
// BLE discovery UUID: 0000fee7-0000-1000-8000-00805f9b34fb

import { BasePlugin } from '../../core/plugin-interface';
import type { PluginManifest, PluginRoute } from '../../core/plugin-interface';
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';

// --- Types ---

interface LockDevice {
  id: string;
  name: string;
  mac: string;
  model: string;
  battery: number;
  locked: boolean;
  stateKnown: boolean;  // false when lock/list returns null lockStatus and no BLE query has confirmed it
  online: boolean;
  lastActivity: string;
}

interface ActivityEntry {
  id: string;
  lockId: string;
  action: string;
  user: string;
  timestamp: string;
  method: string;
}

interface Passcode {
  id: string;
  lockId: string;
  code: string;
  name: string;
  startDate?: string;
  endDate?: string;
  active: boolean;
}

const API_BASE = 'https://euapi.ttlock.com/v3';

// --- Helper ---

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

// --- Plugin Class ---

class TTLockPlugin extends BasePlugin {
  private locks: Map<string, LockDevice> = new Map();
  private activity: ActivityEntry[] = [];
  private passcodes: Map<string, Passcode[]> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // Separate map for command protection â€” avoids race condition where syncLocks()
  // replaces the lock object in this.locks while lockDevice()/unlockDevice() is mid-await.
  private cmdProtect: Map<string, { locked: boolean; ts: number }> = new Map();
  private readonly CMD_PROTECT_MS = 15 * 1000;  // 15 seconds
  private lastQueryStateTs: Map<string, number> = new Map();
  private readonly QUERY_STATE_THROTTLE_MS = 2 * 60 * 1000; // BLE state query per lock, max every 2 minutes
  private rateLimitedUntil = 0; // epoch ms â€” stop all API calls until this time (errcode 30007)

  private accessToken = '';
  private refreshToken = '';
  private clientId = '';
  private clientSecret = '';
  private configPath = '';

  constructor(manifest: PluginManifest) {
    super(manifest);
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    await super.init(config, mockMode);

    this.clientId = config.client_id || '';
    this.clientSecret = config.client_secret || '';
    this.accessToken = config.access_token || '';
    this.refreshToken = config.refresh_token || '';
    // Resolve config.json path relative to this plugin file so refreshed tokens can be persisted
    this.configPath = path.resolve(__dirname, '../../../../config.json');

    if (!this.clientId) this.mockMode = true;
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    if (this.mockMode) {
      this.initMockLocks();
      this.connected = true;
      this.emit('connected', { mock: true });
      console.log('[ttlock] Connected in MOCK MODE with 3 simulated locks');
    } else {
      await this.syncLocks();
      this.connected = true;
      this.emit('connected', { mock: false });
      console.log('[ttlock] Connected in LIVE mode, synced ' + this.locks.size + ' locks');
    }

    const interval = this.config.poll_interval || 15000;
    this.pollTimer = setInterval(() => this.pollStatus(), interval);

    if (!this.mockMode) {
      // Audit timed tasks on startup â€” TTLock cloud automations can auto-unlock
      setTimeout(() => this.auditTimedTasks(), 5000);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    this.emit('disconnected');
    console.log('[ttlock] Disconnected');
  }

  // --- Mock Data ---

  private initMockLocks(): void {
    const mockLocks: LockDevice[] = [
      {
        id: 'ttl-front-001', name: 'Front Door',
        mac: 'AA:BB:CC:DD:EE:01', model: 'TTLock Pro 3S',
        battery: 87, locked: true, stateKnown: true, online: true,
        lastActivity: new Date().toISOString(),
      },
      {
        id: 'ttl-back-002', name: 'Back Door',
        mac: 'AA:BB:CC:DD:EE:02', model: 'TTLock Pro 3S',
        battery: 62, locked: true, stateKnown: true, online: true,
        lastActivity: new Date().toISOString(),
      },
      {
        id: 'ttl-garage-003', name: 'Garage Entry',
        mac: 'AA:BB:CC:DD:EE:03', model: 'TTLock S31',
        battery: 45, locked: false, stateKnown: true, online: true,
        lastActivity: new Date().toISOString(),
      },
    ];

    for (const lock of mockLocks) {
      this.locks.set(lock.id, lock);
      this.passcodes.set(lock.id, []);
    }

    this.activity.push(
      {
        id: 'act-001', lockId: 'ttl-front-001', action: 'lock',
        user: 'Auto Lock', timestamp: new Date(Date.now() - 3600000).toISOString(), method: 'auto',
      },
      {
        id: 'act-002', lockId: 'ttl-garage-003', action: 'unlock',
        user: "User", timestamp: new Date(Date.now() - 1800000).toISOString(), method: 'app',
      },
      {
        id: 'act-003', lockId: 'ttl-back-002', action: 'lock',
        user: "User", timestamp: new Date(Date.now() - 900000).toISOString(), method: 'passcode',
      },
    );
  }

  // --- TTLock Cloud API ---

  private async apiCall(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    const url = API_BASE + endpoint;
    const body = new URLSearchParams({
      clientId: this.clientId,
      accessToken: this.accessToken,
      date: Date.now().toString(),
      ...params,
    });

    // Monthly limit circuit-breaker â€” stop hammering the API when 30007 was returned
    if (Date.now() < this.rateLimitedUntil) {
      throw new Error('TTLock API monthly limit exceeded â€” paused until ' + new Date(this.rateLimitedUntil).toISOString());
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();

    // Monthly call limit exceeded â€” back off until start of next month
    if (data.errcode === 30007) {
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      this.rateLimitedUntil = nextMonth.getTime();
      console.error(`[ttlock] Monthly API limit exceeded (30007) â€” pausing all calls until ${nextMonth.toISOString()}`);
      return data;
    }

    // Token expired (error code 10003) -- refresh and retry
    if (data.errcode === 10003) {
      console.log('[ttlock] Token expired, refreshing...');
      await this.refreshAccessToken();
      body.set('accessToken', this.accessToken);
      const retry = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return retry.json();
    }

    return data;
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });

    const res = await fetch(API_BASE + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.access_token) {
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token || this.refreshToken;
      this.emit('tokenRefreshed', { access_token: this.accessToken });
      console.log('[ttlock] Token refreshed successfully');
      this.persistTokens();
    } else {
      console.error('[ttlock] Token refresh failed â€” errcode:', data.errcode, data.errmsg || data.msg || JSON.stringify(data));
      this.emit('error', new Error('Token refresh failed: ' + (data.errmsg || data.errcode)));
    }
  }

  private persistTokens(): void {
    if (!this.configPath) return;
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      const integration = (cfg.integrations || []).find((i: any) => i.id === 'ttlock');
      if (integration) {
        integration.access_token = this.accessToken;
        integration.refresh_token = this.refreshToken;
        fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf-8');
        console.log('[ttlock] Tokens persisted to config.json');
      }
    } catch (e) {
      console.warn('[ttlock] Could not persist tokens:', e);
    }
  }

  // --- Sync & Poll ---

  private async auditTimedTasks(): Promise<void> {
    for (const id of this.locks.keys()) {
      try {
        const data = await this.apiCall('/timedTask/list', { lockId: id, pageNo: '1', pageSize: '50' });
        if (data.list && data.list.length > 0) {
          console.warn(`[ttlock] TIMED TASKS on lock ${id}:`);
          for (const t of data.list) {
            console.warn(`[ttlock]   task id=${t.timedTaskId} type=${t.taskType} minute=${t.minute} enabled=${t.status}`);
          }
        } else {
          console.log(`[ttlock] No timed tasks on lock ${id}`);
        }
      } catch (e) {
        console.log(`[ttlock] Could not fetch timed tasks for ${id}`);
      }
    }
  }

  private async syncLocks(): Promise<void> {
    if (this.mockMode) return;

    const data = await this.apiCall('/lock/list', { pageNo: '1', pageSize: '100' });

    if (!data.list) {
      console.error('[ttlock] lock/list returned no list â€” errcode:', data.errcode, data.errmsg || data.msg || JSON.stringify(data));
      return;
    }

    const now = Date.now();
    const apiIds = new Set<string>();

    for (const l of data.list) {
      const id = String(l.lockId);
      apiIds.add(id);
      const existing = this.locks.get(id);

      // Check the separate command-protection map â€” immune to object-identity races.
      const cmd = this.cmdProtect.get(id);
      const recentCommand = cmd != null && (now - cmd.ts < this.CMD_PROTECT_MS);
      // lockStatus: 0=locked, 1=unlocked, -1=offline; null/undefined = model doesn't report via list
      const apiReportsLocked = l.lockStatus === 0;
      const apiReportsUnlocked = l.lockStatus === 1;
      const apiKnowsState = apiReportsLocked || apiReportsUnlocked;
      const prevLocked = existing?.locked ?? true;
      const prevStateKnown = existing?.stateKnown ?? false;
      const lockedFromApi = apiReportsUnlocked ? false : (apiReportsLocked ? true : prevLocked);
      const locked = recentCommand ? cmd.locked : lockedFromApi;
      const stateKnown = recentCommand ? true : (apiKnowsState ? true : prevStateKnown);

      console.log(`[ttlock] sync ${id}: apiStatus=${l.lockStatus} apiKnown=${apiKnowsState} stateKnown=${stateKnown} protected=${recentCommand} final=${locked}`);

      // If the lock was previously seen as locked and is now reporting unlocked (unprotected), log the cause
      if (!recentCommand && !lockedFromApi && existing?.locked) {
        console.warn(`[ttlock] UNEXPECTED UNLOCK detected for ${id} â€” fetching activity log...`);
        this.apiCall('/lockRecord/list', { lockId: id, pageNo: '1', pageSize: '5' }).then((log: any) => {
          if (log.list) {
            for (const r of log.list) {
              console.warn(`[ttlock] record: type=${r.recordType} user="${r.username}" time=${new Date(r.lockDate).toISOString()} source=${r.keyboardPwdType ?? r.recordTypeStr ?? 'unknown'}`);
            }
          }
        }).catch(() => {});
      }

      const lock: LockDevice = {
        id,
        name: l.lockAlias || l.lockName || 'Lock ' + id,
        mac: l.lockMac || '',
        model: l.lockModel || 'Unknown',
        battery: l.electricQuantity ?? existing?.battery ?? -1,
        locked,
        stateKnown,
        online: l.lockStatus !== -1,
        lastActivity: existing?.lastActivity || new Date().toISOString(),
      };

      this.locks.set(id, lock);
      if (!this.passcodes.has(id)) this.passcodes.set(id, []);
    }

    // Remove locks that disappeared from the API response
    for (const id of this.locks.keys()) {
      if (!apiIds.has(id)) this.locks.delete(id);
    }
  }

  // queryOpenState uses BLE via gateway â€” only works when lock is in range of a paired gateway.
  // Returns true=locked, false=unlocked, null=error/offline/unsupported.
  private async queryOpenState(lockId: string): Promise<boolean | null> {
    try {
      const data = await this.apiCall('/lock/queryOpenState', { lockId });
      if (data.state === 0) return true;   // 0 = locked
      if (data.state === 1) return false;  // 1 = unlocked
      console.log(`[ttlock] queryOpenState ${lockId}: errcode=${data.errcode} errmsg=${data.errmsg}`);
      return null;
    } catch (e) {
      console.log(`[ttlock] queryOpenState ${lockId} failed:`, e);
      return null;
    }
  }

  private async pollStatus(): Promise<void> {
    if (this.mockMode) {
      for (const lock of this.locks.values()) {
        if (Math.random() < 0.1) {
          lock.battery = Math.max(0, lock.battery - 1);
          this.emit('stateChange', { type: 'battery', lockId: lock.id, battery: lock.battery });
        }
      }
      return;
    }
    // Use syncLocks() â€” one /lock/list call covers all locks vs one /lock/queryOpenState per lock.
    await this.syncLocks();

    // BLE state query for locks where list doesn't report lockStatus (S534 model).
    // Throttled to every 2 minutes per lock â€” ~65k calls/month, trivial vs 10M plan.
    const now = Date.now();
    for (const [id, lock] of this.locks.entries()) {
      if (!lock.stateKnown) {
        const last = this.lastQueryStateTs.get(id) || 0;
        if (now - last >= this.QUERY_STATE_THROTTLE_MS) {
          this.lastQueryStateTs.set(id, now);
          const locked = await this.queryOpenState(id);
          if (locked !== null) {
            lock.stateKnown = true;
            lock.locked = locked;
            console.log(`[ttlock] BLE state ${id}: locked=${locked}`);
            this.emit('stateChange', { type: 'lock', lockId: id, locked });
          }
        }
      }
    }
  }

  // --- Lock / Unlock ---

  private async lockDevice(lockId: string): Promise<{ success: boolean; message: string }> {
    const device = this.locks.get(lockId);
    if (!device) return { success: false, message: 'Lock not found' };

    if (this.mockMode) {
      device.locked = true;
      device.lastActivity = new Date().toISOString();
      this.addActivity(lockId, 'lock', 'MalamaOS', 'api');
      this.emit('stateChange', { type: 'lock', lockId, locked: true });
      return { success: true, message: device.name + ' locked' };
    }

    const data = await this.apiCall('/lock/lock', { lockId });
    console.log(`[ttlock] lock command ${lockId}: errcode=${data.errcode} errmsg=${data.errmsg}`);
    if (data.errcode === 0) {
      this.cmdProtect.set(lockId, { locked: true, ts: Date.now() });
      const current = this.locks.get(lockId);
      if (current) { current.locked = true; current.stateKnown = true; current.lastActivity = new Date().toISOString(); }
      this.addActivity(lockId, 'lock', 'MalamaOS', 'api');
      this.emit('stateChange', { type: 'lock', lockId, locked: true });
      return { success: true, message: device.name + ' locked' };
    }

    return { success: false, message: data.errmsg || 'Lock command failed' };
  }

  private async unlockDevice(lockId: string): Promise<{ success: boolean; message: string }> {
    const device = this.locks.get(lockId);
    if (!device) return { success: false, message: 'Lock not found' };

    if (this.mockMode) {
      device.locked = false;
      device.stateKnown = true;
      device.lastActivity = new Date().toISOString();
      this.addActivity(lockId, 'unlock', 'MalamaOS', 'api');
      this.emit('stateChange', { type: 'lock', lockId, locked: false });
      return { success: true, message: device.name + ' unlocked' };
    }

    const data = await this.apiCall('/lock/unlock', { lockId });
    console.log(`[ttlock] unlock command ${lockId}: errcode=${data.errcode} errmsg=${data.errmsg}`);
    if (data.errcode === 0) {
      this.cmdProtect.set(lockId, { locked: false, ts: Date.now() });
      const current = this.locks.get(lockId);
      if (current) { current.locked = false; current.stateKnown = true; current.lastActivity = new Date().toISOString(); }
      this.addActivity(lockId, 'unlock', 'MalamaOS', 'api');
      this.emit('stateChange', { type: 'lock', lockId, locked: false });
      return { success: true, message: device.name + ' unlocked' };
    }

    return { success: false, message: data.errmsg || 'Unlock command failed' };
  }

  // --- Activity Log ---

  private addActivity(lockId: string, action: string, user: string, method: string): void {
    const entry: ActivityEntry = {
      id: 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      lockId, action, user,
      timestamp: new Date().toISOString(),
      method,
    };
    this.activity.unshift(entry);
    if (this.activity.length > 200) this.activity.length = 200;
  }

  private async getActivityLog(lockId: string, limit: number = 50): Promise<ActivityEntry[]> {
    if (!this.mockMode) {
      const data = await this.apiCall('/lockRecord/list', {
        lockId,
        pageNo: '1',
        pageSize: String(limit),
      });
      if (data.list) {
        // TTLock unlock recordTypes: 1(app), 3(keypad), 5(fingerprint), 7(card),
        // 9(manual handle), 11(wristband), 44(remote app), 47(timed task)
        const UNLOCK_TYPES = new Set([1, 3, 5, 7, 9, 11, 44, 47]);
        return data.list.map((r: any) => ({
          id: String(r.recordId),
          lockId,
          action: UNLOCK_TYPES.has(r.recordType) ? 'unlock' : 'lock',
          user: r.username || 'Unknown',
          timestamp: new Date(r.lockDate).toISOString(),
          method: r.recordTypeStr || String(r.recordType),
        }));
      }
    }
    return this.activity.filter((a) => a.lockId === lockId).slice(0, limit);
  }

  // --- State ---

  getState(): any {
    return {
      connected: this.connected,
      mock: this.mockMode,
      locks: Array.from(this.locks.values()),
      totalActivity: this.activity.length,
    };
  }

  getRoutes(): PluginRoute[] {
    return [
      // GET /api/locks/state
      {
        method: 'GET',
        path: '/api/locks/state',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, this.getState());
        },
      },

      // POST /api/locks/sync  â€” force immediate re-sync + return raw API response for debugging
      {
        method: 'POST',
        path: '/api/locks/sync',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          if (this.mockMode) { jsonResponse(res, { mock: true, locks: Array.from(this.locks.values()) }); return; }
          let rawResponse: any = null;
          try {
            rawResponse = await this.apiCall('/lock/list', { pageNo: '1', pageSize: '100' });
          } catch (e: any) {
            jsonResponse(res, { error: e.message, rawResponse: null }, 500);
            return;
          }
          await this.syncLocks();
          jsonResponse(res, { rawResponse, locks: Array.from(this.locks.values()) });
        },
      },

      // POST /api/locks/:id/lock
      {
        method: 'POST',
        path: '/api/locks/:id/lock',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/locks\/([^/]+)\/lock/);
          if (!match) { jsonResponse(res, { error: 'Invalid lock ID' }, 400); return; }

          const result = await this.lockDevice(match[1]);
          jsonResponse(res, result);
        },
      },

      // POST /api/locks/:id/unlock
      {
        method: 'POST',
        path: '/api/locks/:id/unlock',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/locks\/([^/]+)\/unlock/);
          if (!match) { jsonResponse(res, { error: 'Invalid lock ID' }, 400); return; }

          const result = await this.unlockDevice(match[1]);
          jsonResponse(res, result);
        },
      },

      // GET /api/locks/:id/activity
      {
        method: 'GET',
        path: '/api/locks/:id/activity',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/locks\/([^/]+)\/activity/);
          if (!match) { jsonResponse(res, { error: 'Invalid lock ID' }, 400); return; }

          const parsedUrl = new URL(url, 'http://localhost');
          const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
          const log = await this.getActivityLog(match[1], limit);
          jsonResponse(res, { activity: log });
        },
      },

      // POST /api/locks/:id/refresh  â€” real-time BLE state query (ignores throttle)
      {
        method: 'POST',
        path: '/api/locks/:id/refresh',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/locks\/([^/]+)\/refresh/);
          if (!match) { jsonResponse(res, { error: 'Invalid lock ID' }, 400); return; }
          const lockId = match[1];
          if (this.mockMode) {
            const lock = this.locks.get(lockId);
            if (!lock) { jsonResponse(res, { error: 'Lock not found' }, 404); return; }
            jsonResponse(res, { success: true, lockId, locked: lock.locked, stateKnown: true, source: 'mock' });
            return;
          }
          const locked = await this.queryOpenState(lockId);
          if (locked !== null) {
            const lock = this.locks.get(lockId);
            if (lock) { lock.locked = locked; lock.stateKnown = true; }
            this.lastQueryStateTs.set(lockId, Date.now());
            jsonResponse(res, { success: true, lockId, locked, stateKnown: true, source: 'ble' });
          } else {
            jsonResponse(res, { success: false, message: 'BLE query failed â€” lock may be offline or out of gateway range' });
          }
        },
      },

      // GET /api/locks/activity  â€” in-memory activity across all locks (populated by Bailey commands)
      {
        method: 'GET',
        path: '/api/locks/activity',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          jsonResponse(res, { activities: this.activity.slice(0, 50) });
        },
      },

      // POST /api/locks/:id/passcode
      {
        method: 'POST',
        path: '/api/locks/:id/passcode',
        handler: async (req: IncomingMessage, res: ServerResponse, body?: any) => {
          const url = req.url ?? '';
          const match = url.match(/\/api\/locks\/([^/]+)\/passcode/);
          if (!match) { jsonResponse(res, { error: 'Invalid lock ID' }, 400); return; }

          const data = body || await parseBody(req);
          if (!data.code || !data.name) {
            jsonResponse(res, { success: false, message: 'code and name required' }, 400);
            return;
          }

          const lockId = match[1];
          const device = this.locks.get(lockId);
          if (!device) { jsonResponse(res, { success: false, message: 'Lock not found' }, 404); return; }

          const passcodeId = 'pc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

          if (this.mockMode) {
            const pc: Passcode = {
              id: passcodeId, lockId, code: data.code, name: data.name,
              startDate: data.startDate, endDate: data.endDate, active: true,
            };
            const list = this.passcodes.get(lockId) || [];
            list.push(pc);
            this.passcodes.set(lockId, list);
            this.addActivity(lockId, 'passcode_added', data.name, 'api');
            jsonResponse(res, { success: true, passcodeId, message: 'Passcode added for ' + data.name });
            return;
          }

          const params: Record<string, string> = {
            lockId,
            keyboardPwd: data.code,
            keyboardPwdName: data.name,
            keyboardPwdType: '2',
          };
          if (data.startDate) params.startDate = new Date(data.startDate).getTime().toString();
          if (data.endDate) {
            params.endDate = new Date(data.endDate).getTime().toString();
            params.keyboardPwdType = '3';
          }

          let apiResult: any;
          try {
            apiResult = await this.apiCall('/keyboardPwd/add', params);
          } catch (e: any) {
            jsonResponse(res, { success: false, message: e.message }, 500); return;
          }
          if (apiResult.keyboardPwdId) {
            jsonResponse(res, { success: true, passcodeId: String(apiResult.keyboardPwdId), message: 'Passcode added for ' + data.name });
          } else {
            jsonResponse(res, { success: false, message: apiResult.errmsg || 'Failed to add passcode' });
          }
        },
      },
    ];
  }
}

// --- Factory Export ---

export function createPlugin(manifest: PluginManifest): TTLockPlugin {
  return new TTLockPlugin(manifest);
}
