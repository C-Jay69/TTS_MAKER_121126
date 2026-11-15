#!/usr/bin/env python3
"""
Minimal OpenAI-compatible Kokoro TTS server for Audiobook Studio.

Exposes the endpoints the app expects from Kokoro-FastAPI:

    POST /v1/audio/speech   {model, input, voice, response_format, speed} -> WAV
    GET  /v1/models
    GET  /health

It reuses the Kokoro install already present in the user's venv (the `kokoro`
package + hexgrad/Kokoro-82M weights), so no extra dependencies are needed —
only the Python standard library.

Run with the venv interpreter:

    /home/c-jay69/venv/bin/python scripts/kokoro-server.py

Options:
    --host 127.0.0.1   interface to bind (use 0.0.0.0 to allow other devices)
    --port 8880        port (Kokoro-FastAPI default)
    --device cpu       torch device (cpu, cuda, mps)
"""

from __future__ import annotations

import argparse
import gc
import io
import json
import os
import sys
import threading
import traceback
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAMPLE_RATE = 24000

# The leading letter of a Kokoro voice id selects the language pipeline.
VOICE_LANG_PREFIX = {
    "a": "a",  # American English
    "b": "b",  # British English
    "e": "e",  # Spanish
    "f": "f",  # French
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "j": "j",  # Japanese
    "p": "p",  # Brazilian Portuguese
    "z": "z",  # Mandarin Chinese
}

VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]


def log(*args):
    print("[kokoro-server]", *args, file=sys.stderr, flush=True)


def clamp_speed(value) -> float:
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return 1.0
    return max(0.5, min(2.0, speed))


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class KokoroEngine:
    """Loads KPipeline objects on demand and serializes inference.

    Each cached pipeline keeps a whole Kokoro model resident (~0.5-1 GB once
    torch is loaded), and the voice table spans nine languages. Caching every
    language a user tries would grow without bound and make this process the
    biggest target on a memory-constrained machine — earlyoom has killed it
    here before. So only a couple of languages stay resident and the least
    recently used one is evicted.
    """

    def __init__(self, device: str | None = None):
        self.device = device
        # One voice per book means one language in practice; allow more through
        # KOKORO_CACHE_PIPELINES for multi-language projects on a roomy machine.
        self.max_pipelines = max(1, _env_int("KOKORO_CACHE_PIPELINES", 1))
        self.pipelines: OrderedDict[str, object] = OrderedDict()
        self.lock = threading.Lock()

    def pipeline(self, lang: str):
        pipeline = self.pipelines.get(lang)
        if pipeline is not None:
            self.pipelines.move_to_end(lang)
            return pipeline

        while len(self.pipelines) >= self.max_pipelines:
            evicted_lang, _ = self.pipelines.popitem(last=False)
            log(f"evicting pipeline lang={evicted_lang!r} to free memory")
            gc.collect()

        from kokoro import KPipeline

        log(f"loading pipeline lang={lang!r} device={self.device or 'auto'} ...")
        pipeline = KPipeline(lang_code=lang, device=self.device or None)
        self.pipelines[lang] = pipeline
        log(f"pipeline ready lang={lang!r}")
        return pipeline

    def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        import numpy as np

        voice = (voice or "af_heart").strip()
        lang = VOICE_LANG_PREFIX.get(voice[:1].lower(), "a")
        speed = clamp_speed(speed)

        with self.lock:
            pipeline = self.pipeline(lang)
            parts = []
            for result in pipeline(text, voice=voice, speed=speed, split_pattern=r"\n+"):
                audio = getattr(result, "audio", None)
                if audio is None:
                    continue
                if hasattr(audio, "detach"):  # torch tensor
                    audio = audio.detach().cpu().numpy()
                parts.append(np.asarray(audio, dtype=np.float32))

        if not parts:
            raise RuntimeError("Kokoro produced no audio for this text")

        samples = np.concatenate(parts)
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 0.99:
            samples = samples * (0.99 / peak)
        pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm16.tobytes())
        return buffer.getvalue()


ENGINE: KokoroEngine | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "KokoroLocal/1.0"

    # ---- helpers -----------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _write(self, body: bytes) -> bool:
        """Write a response body, tolerating a client that hung up.

        The browser aborts in-flight synthesis when the user pauses, cancels,
        resets the manuscript or reloads the page. The socket is then already
        closed, so writing raises BrokenPipeError / ConnectionResetError.
        Treat that as a normal disconnect instead of dumping a traceback.
        """
        try:
            self.wfile.write(body)
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            log(f"client disconnected before the response finished ({self.path})")
            self.close_connection = True
            return False

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self._write(body)

    def _error(self, status: int, message: str):
        self._json(status, {"error": {"message": message, "type": "kokoro_error"}})

    def log_message(self, fmt, *args):  # quieter access log
        log(fmt % args)

    # ---- routes ------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path in ("/health", "/v1/health"):
            self._json(200, {"status": "ok", "voices": len(VOICES)})
        elif path in ("/v1/models", "/models"):
            self._json(200, {
                "object": "list",
                "data": [{"id": "kokoro", "object": "model", "owned_by": "local"}],
            })
        elif path in ("/v1/audio/voices", "/audio/voices"):
            self._json(200, {"voices": VOICES})
        else:
            self._error(404, f"Unknown path: {self.path}")

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path not in ("/v1/audio/speech", "/audio/speech"):
            self._error(404, f"Unknown path: {self.path}")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw or b"{}")
        except (BrokenPipeError, ConnectionResetError):
            log("client disconnected while sending the request body")
            self.close_connection = True
            return
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(400, f"Invalid JSON body: {exc}")
            return

        text = (payload.get("input") or "").strip()
        if not text:
            self._error(400, "Field 'input' is required")
            return

        try:
            wav = ENGINE.synthesize(
                text,
                payload.get("voice") or "af_heart",
                payload.get("speed") or 1.0,
            )
        except Exception as exc:  # noqa: BLE001 - report every failure to the client
            log("synthesis failed:", exc)
            traceback.print_exc(file=sys.stderr)
            self._error(500, str(exc))
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self._cors()
        self.end_headers()
        self._write(wav)


def main():
    global ENGINE

    parser = argparse.ArgumentParser(description="Local OpenAI-compatible Kokoro TTS server")
    parser.add_argument("--host", default=os.environ.get("KOKORO_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("KOKORO_PORT", "8880")))
    parser.add_argument("--device", default=os.environ.get("KOKORO_DEVICE") or None)
    args = parser.parse_args()

    ENGINE = KokoroEngine(device=args.device)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    log(f"listening on http://{args.host}:{args.port}/v1  (POST /v1/audio/speech)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
