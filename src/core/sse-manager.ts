// MalamaOS SSE Manager
// Auto-creates SSE endpoints per plugin, broadcasts state changes

import { IncomingMessage, ServerResponse } from 'http';
import { PluginRegistry } from './plugin-registry';

interface SSEClient {
  id: string;
  res: ServerResponse;
  pluginId: string | null;
}

export class SSEManager {
  private clients: SSEClient[] = [];
  private registry: PluginRegistry;
  private clientIdCounter: number = 0;

  constructor(registry: PluginRegistry) {
    this.registry = registry;

    registry.on('pluginStateChange', ({ pluginId, state }: any) => {
      this.broadcast(pluginId, { type: 'stateChange', pluginId, data: state });
    });

    registry.on('pluginConnected', (pluginId: string) => {
      this.broadcast(null, { type: 'pluginConnected', pluginId });
    });

    registry.on('pluginDisconnected', (pluginId: string) => {
      this.broadcast(null, { type: 'pluginDisconnected', pluginId });
    });
  }

  handleSSE(req: IncomingMessage, res: ServerResponse, pluginId: string | null = null): void {
    const clientId = `sse-${++this.clientIdCounter}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });

    if (pluginId) {
      const plugin = this.registry.getPlugin(pluginId);
      if (plugin) {
        this.sendEvent(res, 'init', { pluginId, state: plugin.getState() });
      }
    } else {
      const allState: any = {};
      for (const [id, plugin] of this.registry.getPlugins()) {
        allState[id] = { state: plugin.getState(), connected: plugin.isConnected(), mock: plugin.isMock() };
      }
      this.sendEvent(res, 'init', allState);
    }

    const client: SSEClient = { id: clientId, res, pluginId };
    this.clients.push(client);

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients = this.clients.filter(c => c.id !== clientId);
    });
  }

  private broadcast(pluginId: string | null, data: any): void {
    const targets = this.clients.filter(c => {
      if (c.pluginId === null) return true;
      return c.pluginId === pluginId;
    });

    for (const client of targets) {
      try {
        this.sendEvent(client.res, data.type, data);
      } catch {
        // Client disconnected
      }
    }
  }

  private sendEvent(res: ServerResponse, event: string, data: any): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  tryHandle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/stream') {
      this.handleSSE(req, res, null);
      return true;
    }

    const match = pathname.match(/^\/api\/([^/]+)\/stream$/);
    if (match) {
      const pluginId = match[1];
      if (this.registry.getPlugin(pluginId)) {
        this.handleSSE(req, res, pluginId);
        return true;
      }
    }

    return false;
  }

  getClientCount(): number {
    return this.clients.length;
  }
}
