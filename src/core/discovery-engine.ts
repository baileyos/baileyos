// BaileyOS Discovery Engine
// Scans network/serial/BLE and matches devices against plugin manifests

import * as net from 'net';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PluginManifest } from './plugin-interface';

export interface DiscoveredDevice {
  type: 'network' | 'serial' | 'ble';
  address: string;
  port?: number;
  mac?: string;
  vendor?: string;
  name?: string;
  openPorts?: number[];
  services?: string[];
}

export interface MatchResult {
  plugin: PluginManifest;
  device: DiscoveredDevice;
  confidence: number; // 0-100
  matchReason: string;
}

export interface ScanResult {
  matched: MatchResult[];
  unmatched: DiscoveredDevice[];
  scanDuration: number;
}

export class DiscoveryEngine extends EventEmitter {
  private pluginsDir: string;
  private manifests: PluginManifest[] = [];

  constructor(pluginsDir: string) {
    super();
    this.pluginsDir = pluginsDir;
    this.loadManifests();
  }

  private loadManifests(): void {
    try {
      const folders = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const folder of folders) {
        const manifestPath = path.join(this.pluginsDir, folder.name, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          this.manifests.push(manifest);
        }
      }
      console.log(`[Discovery] Loaded ${this.manifests.length} plugin manifests`);
    } catch (err: any) {
      console.error('[Discovery] Error loading manifests:', err.message);
    }
  }

  async scan(subnet: string = '192.168.1'): Promise<ScanResult> {
    const start = Date.now();
    const devices: DiscoveredDevice[] = [];

    console.log(`[Discovery] Starting network scan on ${subnet}.0/24...`);
    this.emit('scanStart');

    // Network scan: probe known ports on subnet
    const knownPorts = new Set<number>();
    for (const manifest of this.manifests) {
      if (manifest.discovery?.network?.ports) {
        manifest.discovery.network.ports.forEach(p => knownPorts.add(p));
      }
    }
    // Add common smart home ports
    [80, 443, 554, 3000, 3001, 8080, 8443, 10006, 23, 2601, 34567].forEach(p => knownPorts.add(p));

    const portsArray = Array.from(knownPorts);

    // Scan first 254 hosts
    const scanPromises: Promise<void>[] = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      scanPromises.push(this.probeHost(ip, portsArray, devices));
    }

    // Run in batches of 50 to avoid overwhelming
    for (let i = 0; i < scanPromises.length; i += 50) {
      await Promise.allSettled(scanPromises.slice(i, i + 50));
    }

    console.log(`[Discovery] Found ${devices.length} devices`);

    // Match devices against manifests
    const matched: MatchResult[] = [];
    const unmatched: DiscoveredDevice[] = [];

    for (const device of devices) {
      let bestMatch: MatchResult | null = null;

      for (const manifest of this.manifests) {
        const match = this.matchDevice(device, manifest);
        if (match && (!bestMatch || match.confidence > bestMatch.confidence)) {
          bestMatch = match;
        }
      }

      if (bestMatch) {
        matched.push(bestMatch);
      } else {
        unmatched.push(device);
      }
    }

    const result: ScanResult = {
      matched,
      unmatched,
      scanDuration: Date.now() - start
    };

    console.log(`[Discovery] Matched: ${matched.length}, Unmatched: ${unmatched.length}, Duration: ${result.scanDuration}ms`);
    this.emit('scanComplete', result);
    return result;
  }

  private probeHost(ip: string, ports: number[], devices: DiscoveredDevice[]): Promise<void> {
    return new Promise(async (resolve) => {
      const openPorts: number[] = [];

      const portChecks = ports.map(port => this.checkPort(ip, port));
      const results = await Promise.allSettled(portChecks);

      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          openPorts.push(ports[idx]);
        }
      });

      if (openPorts.length > 0) {
        devices.push({
          type: 'network',
          address: ip,
          openPorts,
          name: `Device at ${ip}`
        });
      }

      resolve();
    });
  }

  private checkPort(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1500);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  private matchDevice(device: DiscoveredDevice, manifest: PluginManifest): MatchResult | null {
    if (!manifest.discovery) return null;

    if (device.type === 'network' && manifest.discovery.network) {
      const netRules = manifest.discovery.network;
      const matchedPorts = netRules.ports.filter(p => device.openPorts?.includes(p));

      if (matchedPorts.length > 0) {
        const confidence = Math.min(90, 50 + matchedPorts.length * 20);
        return {
          plugin: manifest,
          device,
          confidence,
          matchReason: `Open ports match: ${matchedPorts.join(', ')}`
        };
      }

      // MAC prefix match
      if (netRules.macPrefixes && device.mac) {
        const macUpper = device.mac.toUpperCase().replace(/[:-]/g, '');
        for (const prefix of netRules.macPrefixes) {
          if (macUpper.startsWith(prefix.toUpperCase().replace(/[:-]/g, ''))) {
            return {
              plugin: manifest,
              device,
              confidence: 85,
              matchReason: `MAC prefix match: ${prefix}`
            };
          }
        }
      }
    }

    if (device.type === 'serial' && manifest.discovery.serial) {
      const serialRules = manifest.discovery.serial;
      // Serial matching would require probing — return potential match
      return {
        plugin: manifest,
        device,
        confidence: 40,
        matchReason: `Serial port detected, compatible baud rates: ${serialRules.baudRates.join(', ')}`
      };
    }

    return null;
  }

  // Enumerate serial ports (Windows)
  async scanSerial(): Promise<DiscoveredDevice[]> {
    const devices: DiscoveredDevice[] = [];
    try {
      const { SerialPort } = require('serialport') as any;
      const ports = await SerialPort.list();
      for (const port of ports) {
        devices.push({
          type: 'serial',
          address: port.path,
          vendor: port.manufacturer || 'Unknown',
          name: port.friendlyName || port.path
        });
      }
    } catch (err: any) {
      console.log('[Discovery] Serial scan unavailable:', err.message);
    }
    return devices;
  }

  // Get API route for scan results
  getRoutes() {
    return [
      {
        method: 'GET' as const,
        path: '/api/discovery/scan',
        handler: async (_req: any, res: any) => {
          try {
            const result = await this.scan();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      },
      {
        method: 'GET' as const,
        path: '/api/discovery/serial',
        handler: async (_req: any, res: any) => {
          try {
            const devices = await this.scanSerial();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(devices));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      }
    ];
  }
}
