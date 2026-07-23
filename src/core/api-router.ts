// BaileyOS API Router
// Auto-registers plugin routes - no per-plugin code

import { IncomingMessage, ServerResponse } from 'http';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PluginRegistry } from './plugin-registry';
import { PluginRoute } from './plugin-interface';

interface RegisteredRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (req: IncomingMessage, res: ServerResponse, body?: any) => void | Promise<void>;
  pluginId: string;
}

// --- Action Logger ---

const ACTION_LOG = join(process.cwd(), 'logs', 'actions.jsonl');
const LOG_DIR = join(process.cwd(), 'logs');

// Known device IP map — add entries as devices are identified
const KNOWN_DEVICES: Record<string, string> = {
  '127.0.0.1': 'Bailey-AI (internal)',
  '::1':        'Bailey-AI (internal)',
  '::ffff:127.0.0.1': 'Bailey-AI (internal)',
};

function resolveIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (real) return Array.isArray(real) ? real[0] : real;
  const addr = (req.socket as any)?.remoteAddress || '';
  return addr.replace('::ffff:', '') || 'unknown';
}

function resolveDevice(ip: string): string {
  return KNOWN_DEVICES[ip] || KNOWN_DEVICES['::ffff:' + ip] || ip;
}

function writeActionLog(entry: object): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(ACTION_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

export class ApiRouter {
  private routes: RegisteredRoute[] = [];
  private registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  registerSystemRoutes(): void {
    for (const route of this.getSystemRoutes()) {
      this.addRoute('system', route);
    }
  }

  registerPluginRoutes(): void {
    for (const [id, plugin] of this.registry.getPlugins()) {
      const pluginRoutes = plugin.getRoutes();
      for (const route of pluginRoutes) {
        this.addRoute(id, route);
      }
      console.log(`[Router] Registered ${pluginRoutes.length} routes for ${id}`);
    }
  }

  private addRoute(pluginId: string, route: PluginRoute): void {
    const paramNames: string[] = [];
    const patternStr = route.path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const pattern = new RegExp(`^${patternStr}$`);

    this.routes.push({
      method: route.method,
      pattern,
      paramNames,
      handler: route.handler,
      pluginId
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });

      (req as any).params = params;
      (req as any).query = Object.fromEntries(url.searchParams);

      // --- Action tracking ---
      const shouldLog = method !== 'GET' && !pathname.startsWith('/api/events');
      const ip = resolveIp(req);
      const device = resolveDevice(ip);
      const ua = (req.headers['user-agent'] || '').slice(0, 150);

      // Capture body bytes — both this listener and the handler's listener receive them
      const bodyChunks: Buffer[] = [];
      if (shouldLog) {
        req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
      }

      // Intercept writeHead to capture HTTP status
      let statusCode = 200;
      const origWriteHead = res.writeHead.bind(res);
      (res as any).writeHead = (code: number, ...rest: any[]): ServerResponse => {
        statusCode = code;
        return origWriteHead(code, ...rest);
      };

      try {
        await route.handler(req, res);
      } catch (err: any) {
        console.error(`[Router] Error in ${route.pluginId} ${method} ${pathname}:`, err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }

      if (shouldLog) {
        res.on('finish', () => {
          let body: any = {};
          try {
            const raw = Buffer.concat(bodyChunks).toString('utf8');
            if (raw) body = JSON.parse(raw);
          } catch {}

          writeActionLog({
            ts: new Date().toISOString(),
            method,
            path: pathname,
            plugin: route.pluginId,
            ip,
            device,
            ua,
            body,
            status: statusCode,
          });
        });
      }

      return true;
    }

    return false;
  }

  private parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: any) => data += chunk);
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
      req.on('error', reject);
    });
  }

  getSystemRoutes(): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/api/plugins',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.registry.getActivePluginList()));
        }
      },
      {
        method: 'GET',
        path: '/api/health',
        handler: (_req, res) => {
          const health: any = { status: 'ok', plugins: {} };
          for (const [id, plugin] of this.registry.getPlugins()) {
            health.plugins[id] = {
              connected: plugin.isConnected(),
              mock: plugin.isMock(),
              category: plugin.category
            };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        }
      },
      {
        method: 'GET',
        path: '/api/actions',
        handler: (req, res) => {
          const qurl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
          const limit  = Math.min(parseInt(qurl.searchParams.get('limit')  || '100', 10), 1000);
          const plugin = qurl.searchParams.get('plugin');
          const ip     = qurl.searchParams.get('ip');
          const device = qurl.searchParams.get('device');
          const since  = qurl.searchParams.get('since'); // ISO timestamp

          let lines: string[] = [];
          try {
            if (existsSync(ACTION_LOG)) {
              lines = readFileSync(ACTION_LOG, 'utf8').trim().split('\n').filter(Boolean);
            }
          } catch {}

          let entries: any[] = lines.slice(-Math.min(limit * 5, 5000)).map(l => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);

          if (plugin) entries = entries.filter((e: any) => e.plugin === plugin);
          if (ip)     entries = entries.filter((e: any) => e.ip === ip);
          if (device) entries = entries.filter((e: any) => (e.device || '').toLowerCase().includes(device.toLowerCase()));
          if (since)  entries = entries.filter((e: any) => e.ts >= since);

          entries = entries.slice(-limit).reverse();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ count: entries.length, entries }));
        }
      },
      {
        method: 'POST',
        path: '/api/actions/label-device',
        handler: (req, res) => {
          let data = '';
          req.on('data', (c: any) => data += c);
          req.on('end', () => {
            try {
              const { ip: labelIp, name } = JSON.parse(data);
              if (!labelIp || !name) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ip and name required' }));
                return;
              }
              KNOWN_DEVICES[labelIp] = name;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ip: labelIp, name }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid json' }));
            }
          });
        }
      }
    ];
  }
}
