// MalamaOS Plugin Registry
// Discovers, loads, and manages all plugins

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { MalamaPlugin, PluginManifest } from './plugin-interface';

export class PluginRegistry extends EventEmitter {
  private plugins: Map<string, MalamaPlugin> = new Map();
  private manifests: Map<string, PluginManifest> = new Map();
  private pluginsDir: string;
  private config: any;
  private mockMode: boolean;

  constructor(pluginsDir: string, config: any, mockMode: boolean = false) {
    super();
    this.pluginsDir = pluginsDir;
    this.config = config;
    this.mockMode = mockMode;
  }

  async loadAll(): Promise<void> {
    const pluginFolders = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    console.log(`[Registry] Scanning ${pluginFolders.length} plugin folders...`);

    for (const folder of pluginFolders) {
      const manifestPath = path.join(this.pluginsDir, folder.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        console.log(`[Registry] Skipping ${folder.name} - no manifest.json`);
        continue;
      }

      try {
        await this.loadPlugin(folder.name);
      } catch (err: any) {
        console.error(`[Registry] Failed to load ${folder.name}:`, err.message);
      }
    }

    console.log(`[Registry] ${this.plugins.size} plugins loaded`);
  }

  private async loadPlugin(folderName: string): Promise<void> {
    const pluginDir = path.join(this.pluginsDir, folderName);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const integrations = this.config.integrations || [];
    const pluginConfig = integrations.find((i: any) => i.id === manifest.id);

    if (!pluginConfig) {
      console.log(`[Registry] ${manifest.id} - no config entry, skipping`);
      return;
    }

    if (pluginConfig.enabled === false) {
      console.log(`[Registry] ${manifest.id} - disabled in config`);
      return;
    }

    const driverPath = path.join(pluginDir, manifest.driver.replace('.ts', ''));
    const driverModule = require(driverPath);

    let plugin: MalamaPlugin;
    if (typeof driverModule.createPlugin === 'function') {
      plugin = driverModule.createPlugin(manifest);
    } else if (typeof driverModule.default === 'function') {
      plugin = new driverModule.default(manifest);
    } else {
      throw new Error(`Driver ${manifest.driver} must export createPlugin() or default class`);
    }

    const shouldMock = this.mockMode || pluginConfig.mock === true;
    await plugin.init(pluginConfig, shouldMock);

    try {
      await plugin.connect();
      console.log(`[Registry] ${manifest.id} - connected${shouldMock ? ' (MOCK)' : ''}`);
    } catch (err: any) {
      console.error(`[Registry] ${manifest.id} - connection failed: ${err.message}`);
    }

    plugin.on('stateChange', (state: any) => {
      this.emit('pluginStateChange', { pluginId: manifest.id, state });
    });

    plugin.on('connected', () => {
      this.emit('pluginConnected', manifest.id);
    });

    plugin.on('disconnected', () => {
      this.emit('pluginDisconnected', manifest.id);
    });

    this.plugins.set(manifest.id, plugin);
    this.manifests.set(manifest.id, manifest);
  }

  getPlugin(id: string): MalamaPlugin | undefined {
    return this.plugins.get(id);
  }

  getPlugins(): Map<string, MalamaPlugin> {
    return this.plugins;
  }

  getPluginsByCategory(category: string): MalamaPlugin[] {
    return Array.from(this.plugins.values()).filter(p => p.category === category);
  }

  getManifest(id: string): PluginManifest | undefined {
    return this.manifests.get(id);
  }

  getActivePluginList(): Array<{ id: string; name: string; category: string; icon: string; connected: boolean; mock: boolean }> {
    return Array.from(this.plugins.entries()).map(([id, plugin]) => ({
      id,
      name: plugin.name,
      category: plugin.category,
      icon: plugin.icon,
      connected: plugin.isConnected(),
      mock: plugin.isMock()
    }));
  }

  getPluginWidgetPath(id: string): string | null {
    const manifest = this.manifests.get(id);
    if (!manifest) return null;
    return path.join(this.pluginsDir, id, manifest.widget);
  }

  async disconnectAll(): Promise<void> {
    for (const [id, plugin] of this.plugins) {
      try {
        await plugin.disconnect();
        console.log(`[Registry] ${id} disconnected`);
      } catch (err: any) {
        console.error(`[Registry] ${id} disconnect error:`, err.message);
      }
    }
  }
}
