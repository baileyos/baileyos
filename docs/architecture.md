# BaileyOS Architecture

BaileyOS is a plugin-based smart home platform. Every device integration -- lighting, audio, locks, cameras, sensors -- is a self-contained plugin. The core system handles orchestration, routing, and real-time communication. This document explains how the pieces fit together and how to extend the system.

---

## Design Principles

1. **Everything is a plugin.** Device drivers are never part of the core. Each plugin is isolated so one crashing plugin cannot take down the system.
2. **Core is small and stable.** The core (~600 lines total across 5 components) handles plugin loading, HTTP routing, SSE broadcasting, and device discovery. It rarely changes.
3. **Crash containment.** Each plugin runs in its own try/catch boundary. If a plugin throws, the plugin-registry catches it, marks the plugin as errored, and the rest of the system continues.
4. **Real-time by default.** All state changes flow through SSE (Server-Sent Events) to every connected dashboard. No polling from the frontend.
5. **Configuration over code.** Each plugin declares its capabilities, connection settings, and dependencies in a `manifest.json`. The admin panel can override settings without touching code.

---

## System Overview

```
                    +------------------+
                    |    Dashboard     |  (browser)
                    |   (widgets)      |
                    +--------+---------+
                             |
                        SSE + HTTP
                             |
+----------------------------+----------------------------+
|                        BaileyOS Core                    |
|                                                         |
|  +----------+  +-----------+  +----------+  +---------+ |
|  |  server   |  | api-router|  |sse-manager|  |discovery| |
|  +----+-----+  +-----+-----+  +----+-----+  +----+----+ |
|       |              |              |              |      |
|       +--------------+--------------+--------------+      |
|                          |                                |
|                 +--------+--------+                       |
|                 | plugin-registry |                       |
|                 +--------+--------+                       |
|                          |                                |
+----------------------------+----------------------------+
                             |
              +--------------+--------------+
              |              |              |
        +-----+----+  +-----+----+  +------+-----+
        | Plugin A  |  | Plugin B  |  | Plugin C   |
        | (lights)  |  | (audio)   |  | (locks)    |
        +-----------+  +-----------+  +------------+
              |              |              |
          [Device]       [Device]       [Device]
```

---

## Core Components

### 1. server

**File:** `src/core/server.ts`

The HTTP server (Express-based) that hosts the entire system. Responsibilities:

- Start the HTTP listener on the configured port (default: 3333)
- Mount the api-router for all `/api/` routes
- Serve the dashboard static files
- Initialize the other core components at startup

The server is the entry point. It creates the plugin-registry, api-router, sse-manager, and discovery-engine, then starts listening.

```
Startup sequence:
  server.start()
    -> plugin-registry.loadAll()
    -> api-router.mount(plugins)
    -> sse-manager.start()
    -> discovery-engine.scan()
    -> HTTP listen on port
```

---

### 2. api-router

**File:** `src/core/api-router.ts`

Routes all HTTP requests to the correct plugin. When a plugin is loaded, the api-router reads its `getRoutes()` method and mounts each route under a namespaced path:

```
/api/plugins/<plugin-id>/<route-path>
```

For example, a plugin with id `hue-bridge` that defines a GET `/status` route becomes:

```
GET /api/plugins/hue-bridge/status
```

The api-router also provides system-level routes:

| Route                        | Method | Description                        |
|------------------------------|--------|------------------------------------|
| `/api/plugins`               | GET    | List all loaded plugins + status   |
| `/api/plugins/:id/status`    | GET    | Get a specific plugin's state      |
| `/api/plugins/:id/enable`    | POST   | Enable a disabled plugin           |
| `/api/plugins/:id/disable`   | POST   | Disable a running plugin           |
| `/api/system/health`         | GET    | System health check                |

---

### 3. plugin-registry

**File:** `src/core/plugin-registry.ts`

The heart of the system. The plugin-registry is responsible for:

- **Discovery:** Scanning `src/plugins/` for folders containing a `manifest.json`
- **Validation:** Checking that the manifest has all required fields and the driver file exists
- **Dependency resolution:** Loading plugins in the correct order based on `dependencies`
- **Lifecycle management:** Calling `init()`, `connect()`, and `disconnect()` in the right order
- **Crash containment:** Wrapping every plugin method call in try/catch so one plugin cannot crash the system
- **Hot-reload:** (Future) Watching plugin folders for changes and reloading without restart

**Plugin loading sequence:**

```
1. Scan src/plugins/ for manifest.json files
2. Parse and validate each manifest
3. Sort by dependencies (topological sort)
4. For each plugin:
   a. Import the driver module (dynamic import)
   b. Instantiate the driver class, passing the manifest
   c. Call init() -- if false, skip this plugin
   d. Call connect() -- if false, mark as disconnected (retry later)
   e. Call getRoutes() and hand routes to api-router
   f. Register the plugin as active
```

**Error handling:**

If a plugin throws during any lifecycle method, the registry:
- Catches the error
- Logs it with the plugin's namespace
- Marks the plugin status as `error`
- Continues loading other plugins

---

### 4. sse-manager

**File:** `src/core/sse-manager.ts`

Manages Server-Sent Events connections to all dashboard clients. When a browser opens the dashboard, it connects to `/api/sse` and receives a persistent event stream.

**How it works:**

1. Dashboard opens an `EventSource` connection to `/api/sse`
2. The sse-manager registers the connection
3. When a plugin calls `globalThis.baileyOS.sse.broadcast(pluginId, state)`, the sse-manager sends that state as a named event to every connected client
4. The dashboard widget listens for events matching its plugin ID and updates the UI

**Event format:**

```
event: hue-bridge
data: {"power":true,"brightness":75,"status":"online","lastSeen":"2026-07-23T08:00:00Z"}

event: htd-audio
data: {"zone":1,"volume":45,"source":"Streaming","muted":false}
```

The sse-manager also handles:
- **Connection cleanup:** Removes dead connections when clients disconnect
- **Heartbeat:** Sends periodic `:keepalive` comments to prevent proxy timeouts
- **Broadcast throttling:** Limits updates to prevent flooding slow clients

---

### 5. discovery-engine

**File:** `src/core/discovery-engine.ts`

Automatically finds devices on the local network that could be controlled by installed plugins. This is an optional convenience layer.

**Discovery methods:**

- **mDNS/Bonjour:** Listens for service announcements (e.g., `_hue._tcp`, `_http._tcp`)
- **SSDP/UPnP:** Scans for Universal Plug and Play devices
- **Network scan:** Probes known ports on the local subnet
- **Manual registration:** Devices can be added by hand in the admin panel

When a device is discovered, the discovery-engine checks installed plugin manifests to see if any plugin matches (by protocol, port, or service type). If a match is found, it pre-fills the connection settings and notifies the admin.

---

## Plugin Structure

Every plugin is a folder inside `src/plugins/` containing at minimum:

```
src/plugins/<plugin-id>/
  manifest.json    -- Metadata, config, capabilities
  driver.ts        -- TypeScript driver implementing BasePlugin
  widget.html      -- Dashboard widget (optional, set null in manifest)
```

### The BasePlugin Interface

```typescript
interface BasePlugin {
  readonly id: string;
  readonly name: string;

  init(): Promise<boolean>;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  getState(): DeviceState;
  getRoutes(): RouteDefinition[];
}
```

Every driver must implement this interface. See `src/plugins/_template/driver.ts` for a fully commented example, or read `docs/creating-a-plugin.md` for a step-by-step tutorial.

---

## How Plugins Are Loaded Dynamically

BaileyOS uses dynamic imports to load plugins at runtime without any hardcoded references in the core:

```typescript
// plugin-registry.ts (simplified)
async function loadPlugin(manifestPath: string) {
  // 1. Read and parse the manifest
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  // 2. Dynamically import the driver module
  const pluginDir = path.dirname(manifestPath);
  const driverPath = path.join(pluginDir, manifest.driver);
  const module = await import(driverPath);

  // 3. Instantiate the driver class
  const DriverClass = module.default;
  const driver = new DriverClass(manifest);

  // 4. Run the lifecycle
  const initOk = await driver.init();
  if (!initOk) return null;

  const connectOk = await driver.connect();
  // Store driver in registry regardless -- it can reconnect later

  return driver;
}
```

This means:
- **No imports to update** when you add a new plugin. Just drop the folder in.
- **No build step required** for the registry to find new plugins.
- **Plugins can be added/removed at runtime** (with hot-reload, when implemented).

---

## Data Flow

### State update flow (device to dashboard):

```
Device state changes
  -> Plugin driver detects change (poll or push)
  -> Driver updates internal state cache
  -> Driver calls broadcastState()
  -> sse-manager sends SSE event to all connected dashboards
  -> Dashboard widget receives event, updates UI
```

### Command flow (dashboard to device):

```
User clicks button in widget
  -> Widget sends HTTP POST to /api/plugins/<id>/<action>
  -> api-router routes to plugin's handler
  -> Handler sends command to device
  -> Handler updates internal state
  -> Handler calls broadcastState()
  -> All dashboards receive updated state via SSE
```

---

## How to Extend BaileyOS

### Add a new device plugin

Follow the tutorial in `docs/creating-a-plugin.md`. Copy the template, edit the manifest, implement the driver, build a widget.

### Add a new core capability

If you need something that does not fit in a plugin (e.g., a new transport protocol, a scheduling system, a rules engine):

1. Create a new file in `src/core/`
2. Export a class or module with a clear interface
3. Initialize it in `server.ts` during startup
4. Expose it to plugins via `globalThis.baileyOS` if plugins need access

### Add API routes outside of plugins

System-level routes go in `src/core/api-router.ts`. Plugin-specific routes go in the plugin's `getRoutes()` method. Do not mix them.

### Modify the dashboard

The dashboard is a static HTML/CSS/JS application served from `src/dashboard/`. Widget HTML files from plugins are loaded into the dashboard dynamically. To change the dashboard layout or theme, edit the dashboard source files.

---

## File Tree Reference

```
baileyos-community/
  src/
    core/
      server.ts            -- HTTP server, entry point
      api-router.ts        -- Route mounting and system API
      plugin-registry.ts   -- Plugin discovery, loading, lifecycle
      sse-manager.ts       -- Real-time event broadcasting
      discovery-engine.ts  -- Network device auto-discovery
      types.ts             -- Shared TypeScript interfaces
      logger.ts            -- Namespaced logging utility
    plugins/
      _template/           -- Starter template (copy this)
        manifest.json
        driver.ts
        widget.html
      centralite/          -- Centralite/LiteJet lighting
      htd-audio/           -- HTD Lync 12 audio
      elk-security/        -- ELK M1 security panel
      ttlock/              -- TTLock smart locks
      ...                  -- Your plugin here
    dashboard/
      index.html           -- Main dashboard page
      styles.css           -- Dashboard theme
      app.js               -- Widget loader and SSE client
  docs/
    architecture.md        -- This file
    creating-a-plugin.md   -- Step-by-step plugin tutorial
  package.json
  tsconfig.json
```

---

## Key Interfaces

These are defined in `src/core/types.ts`:

```typescript
// Every plugin manifest must conform to this shape
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  driver: string;
  widget: string | null;
  protocol: string;
  connection: Record<string, any>;
  capabilities: string[];
  dependencies: string[];
  enabled: boolean;
}

// Base state that all plugins return from getState()
interface DeviceState {
  status: 'online' | 'offline' | 'error';
  [key: string]: any;
}

// Route definition for the api-router
interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (req: Request, res: Response) => Promise<void>;
}
```
