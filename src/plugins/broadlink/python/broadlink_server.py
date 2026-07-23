#!/usr/bin/env python3
"""Bailey BroadLink sidecar — HTTP bridge for RM4 Pro IR/RF control.

Setup: pip install broadlink
Start: python broadlink_server.py
"""

import json
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

try:
    import broadlink
except ImportError:
    print("ERROR: broadlink not installed. Run: pip install broadlink", flush=True)
    sys.exit(1)

PORT = 8797

# host_ip -> authenticated broadlink device
DEVICES: dict = {}


def _respond(handler: BaseHTTPRequestHandler, code: int, body: dict) -> None:
    data = json.dumps(body).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass  # suppress default access log

    # ---- GET ----

    def do_GET(self) -> None:
        p = urlparse(self.path).path
        if p == "/health":
            _respond(self, 200, {"status": "ok", "connected": list(DEVICES.keys())})
        else:
            _respond(self, 404, {"error": "not found"})

    # ---- POST ----

    def do_POST(self) -> None:
        p = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        if p == "/discover":
            self._discover(body)
        elif p == "/connect":
            self._connect(body)
        elif p == "/learn":
            self._learn(body)
        elif p == "/send":
            self._send(body)
        else:
            _respond(self, 404, {"error": "not found"})

    def _discover(self, body: dict) -> None:
        timeout = int(body.get("timeout", 5))
        try:
            found = broadlink.discover(timeout=timeout)
            result = []
            for dev in found:
                try:
                    dev.auth()
                    ip = dev.host[0]
                    DEVICES[ip] = dev
                    result.append({"host": ip, "type": type(dev).__name__, "mac": dev.mac.hex()})
                except Exception as e:
                    result.append({"error": str(e)})
            _respond(self, 200, {"found": result})
        except Exception as e:
            _respond(self, 500, {"error": str(e)})

    def _connect(self, body: dict) -> None:
        host = body.get("host")
        if not host:
            _respond(self, 400, {"error": "host required"})
            return
        if host in DEVICES:
            _respond(self, 200, {"ok": True, "host": host, "cached": True})
            return
        try:
            devs = broadlink.discover(timeout=5, discover_ip_address=host)
            if not devs:
                _respond(self, 404, {"error": f"no BroadLink device found at {host}"})
                return
            dev = devs[0]
            dev.auth()
            DEVICES[host] = dev
            _respond(self, 200, {"ok": True, "host": host, "type": type(dev).__name__})
        except Exception as e:
            _respond(self, 500, {"error": str(e)})

    def _learn(self, body: dict) -> None:
        host = body.get("host")
        timeout = int(body.get("timeout", 10))
        if not host:
            _respond(self, 400, {"error": "host required"})
            return
        if host not in DEVICES:
            _respond(self, 400, {"error": f"{host} not connected — POST /connect first"})
            return
        dev = DEVICES[host]
        try:
            dev.enter_learning()
            deadline = time.time() + timeout
            code = None
            while time.time() < deadline:
                time.sleep(0.5)
                try:
                    code = dev.check_data()
                    if code:
                        break
                except Exception:
                    pass
            if code:
                _respond(self, 200, {"ok": True, "code": code.hex()})
            else:
                _respond(self, 408, {"error": "no IR signal received within timeout — point remote at blaster and try again"})
        except Exception as e:
            _respond(self, 500, {"error": str(e)})

    def _send(self, body: dict) -> None:
        host = body.get("host")
        code_hex = body.get("code")
        if not host or not code_hex:
            _respond(self, 400, {"error": "host and code required"})
            return
        if host not in DEVICES:
            _respond(self, 400, {"error": f"{host} not connected — POST /connect first"})
            return
        try:
            DEVICES[host].send_data(bytes.fromhex(code_hex))
            _respond(self, 200, {"ok": True})
        except Exception as e:
            _respond(self, 500, {"error": str(e)})


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"BroadLink sidecar running on port {PORT}", flush=True)
    server.serve_forever()
