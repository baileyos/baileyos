#!/usr/bin/env python3
"""
Bailey ESPHome Voice Satellite Client
Connects to the Third Reality Voice Dev device (ESPHome native API v42.7)
and runs the full voice pipeline without Home Assistant:
  wake word (on device) -> STT (Whisper) -> chat (qwen3) -> TTS (Kokoro) -> playback (mpv on device)
"""

import asyncio
import io
import json
import os
import time
import urllib.request
import wave

DEVICE_HOST = os.environ.get('DEVICE_HOST', '192.168.1.117')
DEVICE_PORT = int(os.environ.get('DEVICE_PORT', 6053))
BAILEY_PORT = int(os.environ.get('BAILEY_PORT', 3333))
WHISPER_PORT = int(os.environ.get('WHISPER_PORT', 8790))
BAILEY_LAN_IP = os.environ.get('BAILEY_LAN_IP', '192.168.1.5')

# ESPHome message IDs (from api.proto option (id) = N)
MSG_HELLO_REQUEST              = 1
MSG_HELLO_RESPONSE             = 2
MSG_DISCONNECT_REQUEST         = 3
MSG_DISCONNECT_RESPONSE        = 4
MSG_PING_REQUEST               = 5
MSG_PING_RESPONSE              = 6
MSG_SUBSCRIBE_VOICE_ASSISTANT  = 89
MSG_VOICE_ASSISTANT_REQUEST    = 90
MSG_VOICE_ASSISTANT_RESPONSE   = 91
MSG_VOICE_ASSISTANT_EVENT      = 92
MSG_VOICE_ASSISTANT_AUDIO      = 106

# VoiceAssistantEvent enum values
VA_ERROR        = 0
VA_RUN_START    = 1
VA_RUN_END      = 2
VA_STT_START    = 3
VA_STT_END      = 4
VA_INTENT_START = 5
VA_INTENT_END   = 6
VA_TTS_START    = 7
VA_TTS_END      = 8

# ── Protobuf wire helpers ─────────────────────────────────────────────────────

def _encode_varint(v: int) -> bytes:
    out = []
    while True:
        bits = v & 0x7F
        v >>= 7
        if v:
            out.append(0x80 | bits)
        else:
            out.append(bits)
            break
    return bytes(out)

def _decode_varint(data: bytes, pos: int):
    result, shift = 0, 0
    while pos < len(data):
        b = data[pos]; pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos

def _enc_uint32(field: int, v: int) -> bytes:
    return _encode_varint((field << 3) | 0) + _encode_varint(v)

def _enc_bool(field: int, v: bool) -> bytes:
    return _enc_uint32(field, 1 if v else 0)

def _enc_string(field: int, s: str) -> bytes:
    b = s.encode()
    return _encode_varint((field << 3) | 2) + _encode_varint(len(b)) + b

def _enc_bytes(field: int, b: bytes) -> bytes:
    return _encode_varint((field << 3) | 2) + _encode_varint(len(b)) + b

def _enc_msg(field: int, payload: bytes) -> bytes:
    return _encode_varint((field << 3) | 2) + _encode_varint(len(payload)) + payload

def _parse_fields(payload: bytes) -> dict:
    """Simple protobuf parser -> {field_num: [raw_values]}."""
    fields: dict = {}
    pos = 0
    while pos < len(payload):
        tag, pos = _decode_varint(payload, pos)
        fn, wt = tag >> 3, tag & 7
        if wt == 0:
            v, pos = _decode_varint(payload, pos)
            fields.setdefault(fn, []).append(v)
        elif wt == 2:
            ln, pos = _decode_varint(payload, pos)
            fields.setdefault(fn, []).append(payload[pos:pos+ln])
            pos += ln
        elif wt == 5:
            fields.setdefault(fn, []).append(payload[pos:pos+4]); pos += 4
        elif wt == 1:
            fields.setdefault(fn, []).append(payload[pos:pos+8]); pos += 8
        else:
            break
    return fields

# ── ESPHome frame helpers ─────────────────────────────────────────────────────

def _frame(msg_type: int, payload: bytes) -> bytes:
    """Encode one ESPHome plain-text frame: 0x00 | varint(size) | varint(type) | payload."""
    return b'\x00' + _encode_varint(len(payload)) + _encode_varint(msg_type) + payload

async def _read_frame(reader: asyncio.StreamReader):
    """Read one ESPHome frame, return (msg_type, payload)."""
    preamble = await reader.readexactly(1)
    if preamble != b'\x00':
        raise ValueError(f'Bad preamble: {preamble.hex()}')
    # varint: payload size
    size, shift = 0, 0
    while True:
        b = (await reader.readexactly(1))[0]
        size |= (b & 0x7F) << shift
        if not (b & 0x80): break
        shift += 7
    # varint: message type
    msg_type, shift = 0, 0
    while True:
        b = (await reader.readexactly(1))[0]
        msg_type |= (b & 0x7F) << shift
        if not (b & 0x80): break
        shift += 7
    payload = await reader.readexactly(size) if size else b''
    return msg_type, payload

# ── Built message helpers ─────────────────────────────────────────────────────

def _hello():
    return _frame(MSG_HELLO_REQUEST,
        _enc_string(1, 'Bailey') + _enc_uint32(2, 1) + _enc_uint32(3, 10))

def _subscribe_va():
    # subscribe=True, flags=1 (VOICE_ASSISTANT_SUBSCRIBE_API_AUDIO)
    return _frame(MSG_SUBSCRIBE_VOICE_ASSISTANT,
        _enc_bool(1, True) + _enc_uint32(2, 1))

def _va_response(port=0, error=False):
    return _frame(MSG_VOICE_ASSISTANT_RESPONSE,
        _enc_uint32(1, port) + _enc_bool(2, error))

def _va_event(event_type: int, pairs=None) -> bytes:
    payload = _enc_uint32(1, event_type)
    for name, value in (pairs or []):
        ev_data = _enc_string(1, name) + _enc_string(2, value)
        payload += _enc_msg(2, ev_data)
    return _frame(MSG_VOICE_ASSISTANT_EVENT, payload)

def _ping_response():
    return _frame(MSG_PING_RESPONSE, b'')

# ── HTTP helpers ──────────────────────────────────────────────────────────────

async def _http_post(url: str, data: bytes, headers: dict) -> bytes:
    loop = asyncio.get_running_loop()
    def _do():
        req = urllib.request.Request(url, data=data, method='POST', headers=headers)
        return urllib.request.urlopen(req, timeout=30).read()
    return await loop.run_in_executor(None, _do)

# ── Voice pipeline ────────────────────────────────────────────────────────────

async def _run_pipeline(writer: asyncio.StreamWriter, pcm_data: bytes, pipeline_lock: asyncio.Lock):
    async with pipeline_lock:
        try:
            await _pipeline(writer, pcm_data)
        except Exception as e:
            print(f'[esphome] pipeline error: {e}', flush=True)
            writer.write(_va_event(VA_RUN_END))
            await writer.drain()

async def _pipeline(writer: asyncio.StreamWriter, pcm_data: bytes):
    # Wrap PCM in WAV for Whisper
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(pcm_data)
    wav_bytes = buf.getvalue()

    # STT
    writer.write(_va_event(VA_STT_START))
    await writer.drain()
    try:
        resp = await _http_post(
            f'http://127.0.0.1:{WHISPER_PORT}/transcribe?ext=wav',
            wav_bytes, {'Content-Type': 'audio/wav'})
        transcript = json.loads(resp).get('text', '').strip()
    except Exception as e:
        print(f'[esphome] STT error: {e}', flush=True)
        writer.write(_va_event(VA_ERROR, [('message', 'STT failed')]))
        writer.write(_va_event(VA_RUN_END))
        await writer.drain()
        return

    print(f'[esphome] transcript: {transcript!r}', flush=True)
    writer.write(_va_event(VA_STT_END, [('text', transcript)]))
    await writer.drain()

    if not transcript:
        writer.write(_va_event(VA_RUN_END))
        await writer.drain()
        return

    # Chat
    writer.write(_va_event(VA_INTENT_START))
    await writer.drain()
    try:
        resp = await _http_post(
            f'http://127.0.0.1:{BAILEY_PORT}/api/chat',
            json.dumps({'message': transcript}).encode(),
            {'Content-Type': 'application/json'})
        d = json.loads(resp)
        reply = (d.get('reply') or d.get('response') or d.get('text') or '').strip()
    except Exception as e:
        print(f'[esphome] chat error: {e}', flush=True)
        reply = "Sorry, I couldn't process that."

    print(f'[esphome] reply: {reply!r}', flush=True)
    writer.write(_va_event(VA_INTENT_END))
    await writer.drain()

    if not reply:
        writer.write(_va_event(VA_RUN_END))
        await writer.drain()
        return

    # TTS — get WAV from Kokoro, save to assets, send URL to device (played via mpv)
    try:
        tts_wav = await _http_post(
            f'http://127.0.0.1:{BAILEY_PORT}/api/voice/speak',
            json.dumps({'text': reply}).encode(),
            {'Content-Type': 'application/json'})

        fname = f'tts_{int(time.time()*1000)}.wav'
        fpath = os.path.join(os.getcwd(), 'assets', fname)
        with open(fpath, 'wb') as f:
            f.write(tts_wav)

        tts_url = f'http://{BAILEY_LAN_IP}:{BAILEY_PORT}/assets/{fname}'
        print(f'[esphome] TTS URL: {tts_url}', flush=True)

        # Calculate audio duration so we wait appropriately before cleanup
        with io.BytesIO(tts_wav) as b:
            with wave.open(b, 'rb') as w:
                duration = w.getnframes() / w.getframerate()

        writer.write(_va_event(VA_TTS_START, [('tts_output', tts_url)]))
        await writer.drain()

        # Wait for device to finish playing, then signal end
        await asyncio.sleep(duration + 1.0)
        writer.write(_va_event(VA_TTS_END))
        await writer.drain()

        # Clean up temp file
        try:
            os.unlink(fpath)
        except OSError:
            pass

    except Exception as e:
        print(f'[esphome] TTS error: {e}', flush=True)

    writer.write(_va_event(VA_RUN_END))
    await writer.drain()

# ── Main connection loop ──────────────────────────────────────────────────────

async def connect():
    pipeline_lock = asyncio.Lock()

    while True:
        writer = None
        try:
            print(f'[esphome] connecting to {DEVICE_HOST}:{DEVICE_PORT}...', flush=True)
            reader, writer = await asyncio.open_connection(DEVICE_HOST, DEVICE_PORT)

            # Handshake — some firmware versions send extra messages before HelloResponse
            writer.write(_hello())
            await writer.drain()
            got_hello = False
            for _ in range(8):
                msg_type, payload = await asyncio.wait_for(_read_frame(reader), timeout=5.0)
                if msg_type == MSG_HELLO_RESPONSE:
                    got_hello = True
                    break
                elif msg_type == MSG_PING_REQUEST:
                    writer.write(_ping_response())
                    await writer.drain()
                else:
                    fields = _parse_fields(payload)
                    print(f'[esphome] handshake: unexpected type={msg_type} payload={payload.hex()} fields={fields}', flush=True)
                    # Accept if it has version fields (field1=major, field2=minor) — firmware uses non-standard ID
                    if 1 in fields and 2 in fields:
                        print(f'[esphome] treating type={msg_type} as HelloResponse', flush=True)
                        got_hello = True
                        break
            if not got_hello:
                raise ValueError('Did not receive HelloResponse')
            print('[esphome] handshake OK — waiting for wake word', flush=True)

            # Subscribe to voice assistant pipeline
            writer.write(_subscribe_va())
            await writer.drain()

            audio_chunks: list[bytes] = []

            while True:
                msg_type, payload = await asyncio.wait_for(_read_frame(reader), timeout=60.0)

                if msg_type == MSG_VOICE_ASSISTANT_REQUEST:
                    f = _parse_fields(payload)
                    start = bool(f.get(1, [0])[0])
                    if start:
                        print('[esphome] wake word! streaming audio...', flush=True)
                        audio_chunks = []
                        writer.write(_va_response(port=0, error=False))
                        await writer.drain()

                elif msg_type == MSG_VOICE_ASSISTANT_AUDIO:
                    f = _parse_fields(payload)
                    chunk = f.get(1, [b''])[0]
                    end   = bool(f.get(2, [0])[0])
                    if chunk:
                        audio_chunks.append(chunk)
                    if end and audio_chunks:
                        combined = b''.join(audio_chunks)
                        audio_chunks = []
                        print(f'[esphome] audio done: {len(combined)} bytes', flush=True)
                        asyncio.create_task(_run_pipeline(writer, combined, pipeline_lock))

                elif msg_type == MSG_PING_REQUEST:
                    writer.write(_ping_response())
                    await writer.drain()

                elif msg_type in (MSG_DISCONNECT_REQUEST, MSG_DISCONNECT_RESPONSE):
                    print('[esphome] device disconnected', flush=True)
                    break

        except asyncio.IncompleteReadError:
            print('[esphome] connection lost', flush=True)
        except asyncio.TimeoutError:
            print('[esphome] read timeout — reconnecting', flush=True)
        except Exception as e:
            print(f'[esphome] error: {e}', flush=True)

        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        print('[esphome] reconnecting in 5s...', flush=True)
        await asyncio.sleep(5)


if __name__ == '__main__':
    asyncio.run(connect())
