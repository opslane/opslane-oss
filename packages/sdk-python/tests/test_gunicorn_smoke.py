"""End-to-end smoke: Gunicorn -> SDK -> mock ingestion."""
import json
import os
import socket
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="gunicorn is POSIX-only")

APP_TEMPLATE = """
import opslane
from flask import Flask
from opslane.integrations.flask import OpslaneFlask

opslane.init(api_key="smoke-key", endpoint="http://127.0.0.1:{ingest_port}")
app = Flask(__name__)
OpslaneFlask(app)

@app.get("/boom")
def boom():
    raise ValueError("gunicorn smoke")
"""


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _terminate(process):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


@pytest.fixture
def capture_server():
    received = []

    class CaptureHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append(
                (
                    self.path,
                    {key.lower(): value for key, value in self.headers.items()},
                    json.loads(body),
                )
            )
            self.send_response(202)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], received
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


@pytest.mark.parametrize("preload", [False, True], ids=["postfork", "preload"])
def test_gunicorn_worker_delivers_events(tmp_path, capture_server, preload):
    ingest_port, received = capture_server
    (tmp_path / "smoke_app.py").write_text(
        textwrap.dedent(APP_TEMPLATE.format(ingest_port=ingest_port))
    )

    port = _free_port()
    args = [
        sys.executable,
        "-m",
        "gunicorn",
        "--workers",
        "1",
        "--bind",
        f"127.0.0.1:{port}",
        "smoke_app:app",
    ]
    if preload:
        args.insert(-1, "--preload")
    process = subprocess.Popen(
        args,
        cwd=tmp_path,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 20
        status = None
        while time.time() < deadline:
            try:
                urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/boom", timeout=3
                )
            except urllib.error.HTTPError as exc:
                status = exc.code
                break
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.25)
        assert status == 500, f"gunicorn never answered /boom (last={status})"

        deadline = time.time() + 10
        while time.time() < deadline and not received:
            time.sleep(0.2)
        assert received, "no event arrived at mock ingestion"
        path, headers, payload = received[0]
        assert path == "/api/v1/events"
        assert headers.get("x-api-key") == "smoke-key"
        assert payload["platform"] == "python"
        assert payload["error"]["type"] == "ValueError"
    finally:
        _terminate(process)
