// BaileyOS Plugin Interface Contract
// Every plugin must implement this interface

import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';

export type PluginCategory = 'lighting' | 'audio' | 'security' | 'cameras' | 'locks' | 'climate' | 'media' | 'gate' | 'automation';

export interface PluginRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse, body?: any) => void | Promise<void>;
}

export interface DiscoveryRules {
  network?: {
    ports: number[];
    macPrefixes?: string[];
    mdns?: string[];
    ssdp?: string[];
  };
  serial?: {
    baudRates: number[];
    dataBits?: number;
    parity?: string;
    stopBits?: number;
    probeCommand?: string;
    expectResponse?: string;
  };
  ble?: {
    serviceUuids?: string[];
  };
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  category: PluginCategory;
  icon: string;
  description: string;
  author: string;
  discovery?: DiscoveryRules;
  configSchema?: Record<string, any>;
  widget: string;
  driver: string;
}

export interface BaileyPlugin extends EventEmitter {
  id: string;
  name: string;
  version: string;
  category: PluginCategory;
  icon: string;
  description: string;
  init(config: any, mockMode?: boolean): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  isMock(): boolean;
  getState(): any;
  discoveryRules?: DiscoveryRules;
  getRoutes(): PluginRoute[];
  widgetPath: string;
}

export abstract class BasePlugin extends EventEmitter implements BaileyPlugin {
  id: string;
  name: string;
  version: string;
  category: PluginCategory;
  icon: string;
  description: string;
  widgetPath: string = 'widget.html';
  discoveryRules?: DiscoveryRules;

  protected connected: boolean = false;
  protected mockMode: boolean = false;
  protected config: any = {};

  constructor(manifest: PluginManifest) {
    super();
    this.id = manifest.id;
    this.name = manifest.name;
    this.version = manifest.version;
    this.category = manifest.category;
    this.icon = manifest.icon;
    this.description = manifest.description;
    this.widgetPath = manifest.widget || 'widget.html';
    this.discoveryRules = manifest.discovery;
  }

  async init(config: any, mockMode: boolean = false): Promise<void> {
    this.config = config;
    this.mockMode = mockMode;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getState(): any;
  abstract getRoutes(): PluginRoute[];

  isConnected(): boolean { return this.connected; }
  isMock(): boolean { return this.mockMode; }
}
