#!/usr/bin/env python3
"""Bailey Apple TV sidecar — pyatv bridge via HTTP.

Setup: pip install pyatv
Start: python appletv_server.py

Pairing flow (one-time per Apple TV):
  1. POST /scan          — discover Apple TVs on LAN
  2. POST /pair/start    { "address": "192.168.1.X", "protocol": "AirPlay" }
  3. A PIN appears on the Apple TV screen
  4. POST /pair/finish   { "address": "...", "protocol": "AirPlay", "pin": "1234" }
  5. Save returned credentials to config.json
  6. POST /connect       { "address": "...", "credentials": { "AirPlay": "..." } }
"""

import asyncio
import json
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

try:
    import pyatv
    import pyatv.const as pyatv_const
except ImportError:
    print("ERROR: pyatv not installed. Run: pip install pyatv", flush=True)
    sys.exit(1)

PORT = 8798

# Shared asyncio event loop running in a background thread.
_loop = asyncio.new_event_loop()

# address -> { atv: pyatv.interface.AppleTV, config: pyatv.interface.BaseConfig }
CONNECTED: dict = {}

# address -> { session: pairing_session }
PAIRING: dict = {}


def _run(coro, timeout=30):
    """Run a coroutine on the shared loop and return the result."""
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout)


def _respond(handler, code: int, body: dict) -> None:
    data = json.dumps(body).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


COMMANDS = {
    "play":         lambda rc: rc.play(),
    "pause":        lambda rc: rc.pause(),
    "stop":         lambda rc: rc.stop(),
    "next":         lambda rc: rc.next(),
    "previous":     lambda rc: rc.previous(),
    "menu":         lambda rc: rc.menu(),
    "home":         lambda rc: rc.home(),
    "home_hold":    lambda rc: rc.home_hold(),
    "select":       lambda rc: rc.select(),
    "up":           lambda rc: rc.up(),
    "down":         lambda rc: rc.down(),
    "left":         lambda rc: rc.left(),
    "right":        lambda rc: rc.right(),
    "volume_up":    lambda rc: rc.volume_up(),
    "volume_down":  lambda rc: rc.volume_down(),
    "turn_on":      lambda rc: rc.turn_on(),
    "turn_off":     lambda rc: rc.turn_off(),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            _respond(self, 200, {"status": "ok", "connected": list(CONNECTED.keys())})
        elif p == "/scan":
            try:
                devices = _run(pyatv.scan(), timeout=10)
                result = [{"name": d.name, "address": str(d.address), "id": str(d.identifier)} for d in devices]
                _respond(self, 200, {"devices": result})
            except Exception as e:
                _respond(self, 500, {"error": str(e)})
        elif p.startswith("/state/"):
            addr = p[7:]
            if addr not in CONNECTED:
                _respond(self, 404, {"error": f"{addr} not connected"})
            else:
                try:
                    state = _run(self._get_state(addr))
                    _respond(self, 200, state)
                except Exception as e:
                    _respond(self, 500, {"error": str(e)})
        elif p.startswith("/nowplaying/"):
            addr = p[12:]
            if addr not in CONNECTED:
                _respond(self, 404, {"error": f"{addr} not connected"})
            else:
                try:
                    state = _run(self._get_state(addr, include_playing=True))
                    _respond(self, 200, state)
                except Exception as e:
                    _respond(self, 500, {"error": str(e)})
        else:
            _respond(self, 404, {"error": "not found"})

    async def _get_state(self, addr: str, include_playing=False) -> dict:
        info = CONNECTED.get(addr, {})
        atv = info.get("atv")
        result: dict = {"address": addr, "connected": bool(atv)}
        if atv and include_playing:
            try:
                p = await atv.metadata.playing()
                result["playing"] = {
                    "title": p.title,
                    "artist": p.artist,
                    "album": p.album,
                    "media_type": str(p.media_type),
                    "device_state": str(p.device_state),
                    "position": p.position,
                    "total_time": p.total_time,
                }
            except Exception as e:
                result["playing"] = {"error": str(e)}
        return result

    def do_POST(self):
        p = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        if p == "/connect":
            self._connect(body)
        elif p == "/pair/start":
            self._pair_start(body)
        elif p == "/pair/finish":
            self._pair_finish(body)
        elif p.startswith("/") and p.endswith("/command"):
            addr = p[1:-8]  # strip leading / and trailing /command
            self._command(addr, body)
        else:
            _respond(self, 404, {"error": "not found"})

    def _connect(self, body: dict) -> None:
        address = body.get("address")
        credentials = body.get("credentials") or {}
        if not address:
            _respond(self, 400, {"error": "address required"})
            return
        try:
            result = _run(self._do_connect(address, credentials))
            _respond(self, 200 if result.get("ok") else 500, result)
        except Exception as e:
            _respond(self, 500, {"error": str(e)})

    async def _do_connect(self, address: str, credentials: dict) -> dict:
        if address in CONNECTED:
            # Already connected — close old connection first.
            try:
                CONNECTED[address]["atv"].close()
            except Exception:
                pass
        devices = await pyatv.scan(hosts=[address])
        if not devices:
            return {"error": f"no Apple TV found at {address}"}
        conf = devices[0]
        # Restore saved pairing credentials.
        for proto_name, creds in credentials.items():
            proto = getattr(pyatv_const.Protocol, proto_name, None)
            if proto:
                conf.set_credentials(proto, creds)
        atv = await pyatv.connect(conf)
        CONNECTED[address] = {"atv": atv, "config": conf, "name": conf.name}
        return {"ok": True, "address": address, "name": conf.name, "id": str(conf.identifier)}

    def _pair_start(self, body: dict) -> None:
        address = body.get("address")
        proto_name = body.get("protocol", "AirPlay")
        if not address:
            _respond(self, 400, {"error": "address required"})
            return
        try:
            result = _run(self._do_pair_start(address, proto_name))
            _respond(self, 200 if not result.get("error") else 500, result)
        except Exception as e:
            _respond(self, 500, {"error": str(e)})

    async def _do_pair_start(self, address: str, proto_name: str) -> dict:
        devices = await pyatv.scan(hosts=[address])
        if not devices:
            return {"error": f"no Apple TV at {address}"}
        conf = devices[0]
        proto = getattr(pyatv_const.Protocol, proto_name, pyatv_const.Protocol.AirPlay)
        session = await pyatv.pair(conf, proto)
        await session.begin()
        PAIRING[address] = {"session": session, "config": conf, "protocol": proto_name}
        return {"ok": True, "address": address, "protocol": proto_name, "awaiting_pin": True}

    def _pair_finish(self, body: dict) -> None:
        address = body.get("address")
        pin = body.get("pin")
        if not address or not pin:
            _respond(self, 400, {"error": "address and pin required"})
            return
        if address not in PAIRING:
            _respond(self, 400, {"error": f"no active pairing for {address} — POST /pair/start first"})
            return
        try:
            result = _run(self._do_pair_finish(address, str(pin)))
            _respond(self, 200 if not result.get("error") else 500, result)
        except Exception as e:
            _respond(self, 500, {"error": str(e)})

    async def _do_pair_finish(self, address: str, pin: str) -> dict:
        info = PAIRING.pop(address, None)
        if not info:
            return {"error": "pairing session expired"}
        session = info["session"]
        session.pin(int(pin))
        await session.finish()
        if not session.has_paired:
            return {"error": "pairing failed — wrong PIN?"}
        credentials = str(session.service.credentials)
        proto_name = info["protocol"]
        await session.close()
        return {
            "ok": True, "address": address, "protocol": proto_name,
            "credentials": credentials,
            "note": "Save credentials in config.json → apple-tv.devices[].credentials",
        }

    def _command(self, address: str, body: dict) -> None:
        if address not in CONNECTED:
            _respond(self, 400, {"error": f"{address} not connected — POST /connect first"})
            return
        cmd = body.get("command", "")
        fn = COMMANDS.get(cmd)
        if not fn:
            _respond(self, 400, {"error": f"unknown command '{cmd}'", "valid": list(COMMANDS.keys())})
            return
        try:
            _run(fn(CONNECTED[address]["atv"].remote_control))
            _respond(self, 200, {"ok": True, "command": cmd, "address": address})
        except Exception as e:
            _respond(self, 500, {"error": str(e)})


if __name__ == "__main__":
    threading.Thread(target=_loop.run_forever, daemon=True).start()
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Apple TV sidecar running on port {PORT}", flush=True)
    server.serve_forever()
