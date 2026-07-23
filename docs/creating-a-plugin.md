# Creating a BaileyOS Plugin

This guide walks you through building a plugin for BaileyOS from scratch. By the end, you will have a working device driver with a dashboard widget, ready to submit as a pull request.

---

## Prerequisites

- Node.js 18+ and TypeScript installed
- A local clone of the `baileyos-community` repository
- Basic understanding of TypeScript and HTTP APIs
- (Optional) A physical or virtual device to integrate

---

## Step 1: Clone the Template

Every plugin lives in its own folder under `src/plugins/`. Start by copying the template:

```bash
cp -r src/plugins/_template src/plugins/my-device
```

Replace `my-device` with your plugin's ID (lowercase, kebab-case). This folder name **must match** the `id` field in your manifest.

Your new folder contains three files:

```
src/plugins/my-device/
  manifest.json   -- Plugin metadata and configuration
  driver.ts       -- Device driver (TypeScript)
  widget.html     -- Dashboard UI widget
```

---

## Step 2: Edit manifest.json

Open `manifest.json` and update every field to match your device:

| Field          | What to set                                                       |
|----------------|-------------------------------------------------------------------|
| `id`           | Your folder name, e.g. `"hue-bridge"`                            |
| `name`         | Human-readable name, e.g. `"Philips Hue Bridge"`                 |
| `version`      | Start at `"1.0.0"`, bump with each release                       |
| `description`  | One-line summary of what this plugin does                         |
| `author`       | Your name and email                                               |
| `category`     | One of: `lighting`, `audio`, `security`, `climate`, `locks`, `cameras`, `sensors`, `utility` |
| `driver`       | Leave as `"driver.ts"` unless you rename the file                 |
| `widget`       | Leave as `"widget.html"`, or set to `null` for headless plugins   |
| `protocol`     | How your device communicates: `tcp`, `serial`, `http`, `mqtt`, `websocket`, `bluetooth` |
| `connection`   | Default host/port (or serial path, MQTT broker, etc.)             |
| `capabilities` | Array of strings describing what the device can do                |
| `dependencies` | IDs of other plugins yours depends on (loaded first)              |
| `enabled`      | `true` to auto-load at startup, `false` for manual activation     |

**Example** for a Philips Hue integration:

```json
{
  "id": "hue-bridge",
  "name": "Philips Hue Bridge",
  "version": "1.0.0",
  "description": "Controls Philips Hue lights via the Bridge API.",
  "author": "Jane Smith <jane@example.com>",
  "category": "lighting",
  "driver": "driver.ts",
  "widget": "widget.html",
  "protocol": "http",
  "connection": {
    "host": "192.168.1.50",
    "port": 80
  },
  "capabilities": ["power", "brightness", "color", "groups"],
  "dependencies": [],
  "enabled": true
}
```

---

## Step 3: Implement driver.ts

The driver is where all the real logic lives. Your class must implement the `BasePlugin` interface, which requires these methods:

### constructor(manifest)

Called once when the plugin-registry creates your driver instance.

- Store the manifest for later use (connection settings, etc.)
- Initialize default state (device is offline at this point)
- Do **not** make network calls here

```typescript
constructor(manifest: PluginManifest) {
  this.manifest = manifest;
  this.id = manifest.id;
  this.name = manifest.name;
  this.state = { power: false, status: 'offline' };
}
```

### async init(): Promise\<boolean\>

Called once after construction for one-time setup.

- Validate connection settings from the manifest
- Read any persistent configuration from disk
- Allocate resources (caches, lookup tables, etc.)
- Return `true` to proceed, `false` to disable the plugin

```typescript
async init(): Promise<boolean> {
  const conn = this.manifest.connection;
  if (!conn?.host) {
    this.log.error('No host configured');
    return false;
  }
  return true;
}
```

### async connect(): Promise\<boolean\>

Establish a live connection to the hardware/service.

- Open a TCP socket, HTTP session, serial port, MQTT connection, etc.
- Fetch the initial device state
- Start a polling interval or event listener for ongoing updates
- Return `true` if connected, `false` to trigger retry

```typescript
async connect(): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/status`);
    const data = await res.json();
    this.state = { ...data, status: 'online' };
    this.pollInterval = setInterval(() => this.poll(), 5000);
    return true;
  } catch (err) {
    return false;
  }
}
```

### async disconnect(): Promise\<void\>

Clean up when the plugin is stopped or the server shuts down.

- Close sockets and serial ports
- Clear intervals and timeouts
- Flush any pending writes
- Set state to offline

```typescript
async disconnect(): Promise<void> {
  clearInterval(this.pollInterval);
  this.connected = false;
  this.state.status = 'offline';
}
```

### getState(): DeviceState

Return the current cached device state. Called by:
- The dashboard widget (via SSE)
- API route handlers
- Other plugins that depend on yours

**This must be fast.** Return cached state, do not make network calls.

```typescript
getState(): MyDeviceState {
  return { ...this.state };
}
```

### getRoutes(): RouteDefinition[]

Define HTTP endpoints that the api-router mounts at `/api/plugins/<your-id>/`.

Each route needs `method`, `path`, and `handler`:

```typescript
getRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/status',
      handler: async (req, res) => {
        res.json(this.getState());
      },
    },
    {
      method: 'POST',
      path: '/power',
      handler: async (req, res) => {
        // Send command to device, update state, broadcast via SSE
        this.broadcastState();
        res.json({ success: true });
      },
    },
  ];
}
```

### Broadcasting State Changes

Whenever your device state changes, broadcast it so all connected dashboards update in real time:

```typescript
if (globalThis.baileyOS?.sse) {
  globalThis.baileyOS.sse.broadcast(this.id, this.getState());
}
```

---

## Step 4: Create widget.html

The widget is a self-contained HTML file displayed in the BaileyOS dashboard. It communicates with your driver through two channels:

1. **SSE (Server-Sent Events)** -- receives live state updates pushed from the server
2. **HTTP API** -- sends commands to your plugin's routes

### Key patterns:

**Receive state updates via SSE:**

```javascript
const evtSource = new EventSource('/api/sse');
evtSource.addEventListener('my-device', (event) => {
  const state = JSON.parse(event.data);
  updateUI(state);
});
```

**Send commands via API:**

```javascript
await fetch('/api/plugins/my-device/power', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ power: true }),
});
```

**Theming:** Use the BaileyOS CSS variables (`--bailey-bg`, `--bailey-cyan`, etc.) defined in the template to keep your widget consistent with the dashboard.

The template `widget.html` includes a complete working example with a power toggle, brightness slider, status indicator, and SSE connection. Modify it to match your device's capabilities.

---

## Step 5: Test Your Plugin

### 5a. Register your plugin

BaileyOS auto-discovers plugins by scanning `src/plugins/` for folders containing a `manifest.json`. Simply having your folder in place is enough.

### 5b. Start the dev server

```bash
npm run dev
```

The console output will show your plugin being loaded:

```
[plugin-registry] Loading plugin: my-device
[plugin:my-device] Initializing...
[plugin:my-device] Configured for 192.168.1.100:8080
[plugin:my-device] Connecting to 192.168.1.100:8080...
```

### 5c. Verify via API

```bash
# Check plugin status
curl http://localhost:3333/api/plugins/my-device/status

# Test a command
curl -X POST http://localhost:3333/api/plugins/my-device/power \
  -H "Content-Type: application/json" \
  -d '{"power": true}'
```

### 5d. Check the dashboard

Open the BaileyOS dashboard in your browser. Your widget should appear as a card. Verify that:

- The status indicator shows the correct connection state
- Controls send commands and the UI updates
- SSE updates arrive when the device state changes externally

### 5e. Test error handling

- Disconnect your device and verify the plugin shows "error" or "offline"
- Restart the server and confirm the plugin reconnects cleanly
- Send invalid API requests and confirm you get proper error responses

---

## Step 6: Submit a Pull Request

Once your plugin is working:

1. **Create a branch:**
   ```bash
   git checkout -b plugin/my-device
   ```

2. **Commit your plugin folder:**
   ```bash
   git add src/plugins/my-device/
   git commit -m "Add my-device plugin: brief description of what it does"
   ```

3. **Push and open a PR:**
   ```bash
   git push -u origin plugin/my-device
   ```
   Then open a pull request on GitHub against the `main` branch.

4. **PR checklist** -- make sure you have:
   - [ ] `manifest.json` with all fields filled in correctly
   - [ ] `driver.ts` implementing all BasePlugin methods
   - [ ] `widget.html` (or `null` in manifest if headless)
   - [ ] Tested with a real or simulated device
   - [ ] No hardcoded credentials (use `manifest.connection` for settings)
   - [ ] Clean console output (no unhandled errors or warnings)

---

## Tips

- **Start simple.** Get `init()` and `connect()` working before building a complex widget.
- **Use the Logger.** `this.log.info()`, `this.log.warn()`, `this.log.error()` -- these are namespaced and appear cleanly in the BaileyOS console.
- **Prefer push over poll.** If your device supports WebSocket, MQTT, or SSE, use that instead of `setInterval` polling. It reduces latency and server load.
- **Keep getState() fast.** Cache everything. Never make a network call inside `getState()`.
- **Test offline behavior.** Devices go offline. Your plugin should handle disconnections gracefully and recover when the device comes back.
- **Check existing plugins.** Look at other plugins in `src/plugins/` for real-world examples of TCP, serial, MQTT, and HTTP integrations.
