#!/usr/bin/env python3
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import mlx.core as mx
from mlx_whisper.transcribe import ModelHolder, transcribe

HOST = "127.0.0.1"
PORT = int(os.environ.get("VIDMARK_WHISPER_PORT", "31416"))
MODEL = os.environ.get("MLX_WHISPER_MODEL", "mlx-community/whisper-turbo")

print("Loading MLX Whisper Turbo into memory…", flush=True)
ModelHolder.get_model(MODEL, mx.float16)
print(f"Vidmark Whisper worker is ready at http://{HOST}:{PORT}", flush=True)


class WhisperHandler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, {"ok": True, "engine": "MLX Whisper Turbo (warm)"})
        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            audio_path = payload["audioPath"]
            language = payload.get("language", "en")
            result = transcribe(audio_path, path_or_hf_repo=MODEL, language=language, verbose=False)
            transcript = result.get("text", "").strip()
            if not transcript:
                return self.send_json(422, {"error": "No speech was detected."})
            return self.send_json(200, {"transcript": transcript})
        except Exception as error:
            return self.send_json(500, {"error": str(error) or "Local transcription failed."})

    def log_message(self, *_args):
        pass


HTTPServer((HOST, PORT), WhisperHandler).serve_forever()
