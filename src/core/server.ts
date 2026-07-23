// BaileyOS Community Server
// Lightweight HTTP server with plugin-based architecture

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { PluginRegistry } from './plugin-registry';
import { ApiRouter } from './api-router';
import { SSEManager } from './sse-manager';

const PORT = parseInt(process.env.BAILEYOS_PORT || process.env.PORT || '3333', 10);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'src', 'plugins');
const DASHBOARD_DIR = path.join(PROJECT_ROOT, 'src', 'dashboard');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

const MOCK_MODE = process.env.MOCK_MODE === 'true' || process.argv.includes('--mock');

// Keep the process alive through unhandled plugin errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] Uncaught exception (process kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-GUARD] Unhandled rejection (process kept alive):', reason);
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function main() {
  console.log('============================================================');
  console.log('  BaileyOS Server');
  console.log(`  Port: ${PORT} | Mock: ${MOCK_MODE}`);
  console.log('============================================================');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  console.log(`[Server] Config loaded: ${(config.integrations || []).length} integrations`);

  const registry = new PluginRegistry(PLUGINS_DIR, config, MOCK_MODE);
  await registry.loadAll();

  const router = new ApiRouter(registry);
  router.registerPluginRoutes();

  const sse = new SSEManager(registry);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── SSE streams ────────────────────────────────────────────────────────
    if (sse.tryHandle(req, res)) return;

    // ── System API routes ──────────────────────────────────────────────────
    if (pathname === '/api/plugins') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(registry.getActivePluginList()));
      return;
    }

    if (pathname === '/api/health') {
      const health: any = {
        status: 'ok',
        uptime: process.uptime(),
        sseClients: sse.getClientCount(),
        plugins: {},
        systems: [],
      };
      for (const [id, plugin] of registry.getPlugins()) {
        const conn = plugin.isConnected();
        health.plugins[id] = { connected: conn, mock: plugin.isMock(), category: plugin.category };
        health.systems.push({
          id,
          name: plugin.name || id,
          icon: plugin.category || 'default',
          category: plugin.category,
          connected: conn,
          mock: plugin.isMock(),
          detail: conn ? 'Connected' : 'Disconnected',
        });
      }
      health.allHealthy = health.systems.every((s: any) => s.connected);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    // ── Plugin widget files: /plugins/{id}/{file} ──────────────────────────
    const widgetMatch = pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
    if (widgetMatch) {
      const [, pluginId, fileName] = widgetMatch;
      const filePath = path.join(PLUGINS_DIR, pluginId, fileName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentTypes: Record<string, string> = {
          '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
          '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
        };
        res.writeHead(200, {
          'Content-Type': contentTypes[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // ── Plugin API routes ──────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      const handled = await router.handle(req, res);
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Route not found', path: pathname }));
      return;
    }

    // ── Dashboard shell ────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/bailey') {
      const shellPath = path.join(DASHBOARD_DIR, 'shell.html');
      if (fs.existsSync(shellPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(shellPath).pipe(res);
        return;
      }
    }

    // Static dashboard files
    if (pathname.startsWith('/dashboard/')) {
      const filePath = path.join(DASHBOARD_DIR, pathname.replace('/dashboard/', ''));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const ct: Record<string, string> = {
          '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
        };
        res.writeHead(200, { 'Content-Type': ct[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // Static assets
    if (pathname.startsWith('/assets/')) {
      const filePath = path.join(ASSETS_DIR, pathname.replace('/assets/', ''));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const ct: Record<string, string> = {
          '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
          '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
          '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
          '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
        };
        res.writeHead(200, {
          'Content-Type': ct[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // Root-level static files (admin-module.js, overlay-engine.js, etc.)
    const rootStaticExts = ['.js', '.css', '.png', '.jpg', '.svg', '.webp', '.json', '.ico'];
    if (rootStaticExts.some(ext => pathname.endsWith(ext))) {
      for (const dir of [DASHBOARD_DIR, SRC_DIR, PROJECT_ROOT]) {
        const filePath = path.join(dir, pathname.replace(/^\//, ''));
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          const ct: Record<string, string> = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
          };
          res.writeHead(200, { 'Content-Type': ct[ext] || 'application/octet-stream' });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }
    }

    // Catch-all: serve dashboard shell (SPA support)
    const shellPath = path.join(DASHBOARD_DIR, 'shell.html');
    if (fs.existsSync(shellPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(shellPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] BaileyOS running on http://0.0.0.0:${PORT}`);
    console.log(`[Server] Dashboard: http://localhost:${PORT}/`);
    console.log(`[Server] Health: http://localhost:${PORT}/api/health`);
  });

  const shutdown = async () => {
    console.log('\n[Server] Shutting down...');
    await registry.disconnectAll();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  setInterval(() => {
    const connected = Array.from(registry.getPlugins().values()).filter(p => p.isConnected()).length;
    const total = registry.getPlugins().size;
    console.log(`[Health] ${connected}/${total} plugins connected | ${sse.getClientCount()} SSE clients`);
  }, 30000);
}

main().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
