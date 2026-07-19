"""The SDK payload must match frozen, replayable Python wire fixtures.

To generate fixtures for a new version (never edit existing files):
    OPSLANE_WRITE_FIXTURES=1 .venv/bin/pytest tests/test_wire_shape.py
"""
import json
import os
import pathlib

import opslane
from opslane import context as ctx
from opslane.client import Client

FIXTURES = (
    pathlib.Path(__file__).resolve().parents[3] / "test-fixtures" / "wire" / "events"
)
VERSION = opslane.__version__

FROZEN_TS = "2026-07-18T00:00:00.000Z"
FROZEN_STACK = (
    "Traceback (most recent call last):\n"
    '  File "/app/api/routes/users.py", line 42, in get_user\n'
    "    user = db.query(User).filter_by(id=user_id).one()\n"
    "ValueError: No row was found\n"
)
FROZEN_PYVER = "3.12.1"
FROZEN_UA = f"Python/{FROZEN_PYVER} opslane/{VERSION}"


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)


def _freeze_volatile(payload):
    payload = json.loads(json.dumps(payload))
    payload["timestamp"] = FROZEN_TS
    payload["error"]["stack"] = FROZEN_STACK
    payload["runtime"]["version"] = FROZEN_PYVER
    payload["context"]["user_agent"] = FROZEN_UA
    for crumb in payload["breadcrumbs"]:
        crumb["timestamp"] = FROZEN_TS
    return payload


def _build(full: bool):
    client = Client(
        api_key="k",
        endpoint="https://x.example",
        release="v1.2.3" if full else None,
        transport=StubTransport(),
    )
    tokens = ctx.push_scope(
        {
            "method": "GET",
            "path": "/api/users/123",
            "headers": {"Content-Type": "application/json"},
            "remote_addr": "10.0.1.50",
        }
        if full
        else None
    )
    try:
        if full:
            ctx.set_user(
                {
                    "id": "user-123",
                    "email": "jane@example.com",
                    "account": {"id": "acct-42", "name": "Example Inc"},
                }
            )
            ctx.add_breadcrumb(
                {
                    "type": "log",
                    "timestamp": FROZEN_TS,
                    "category": "app.auth",
                    "level": "warning",
                    "message": "Token near expiry",
                }
            )
        try:
            raise ValueError("No row was found")
        except ValueError as exc:
            client.capture_exception(exc)
    finally:
        ctx.reset_scope(tokens)
    return _freeze_volatile(client.transport.sent[0])


def _check(name: str, payload: dict):
    path = FIXTURES / f"python-v{VERSION}-{name}.json"
    if os.environ.get("OPSLANE_WRITE_FIXTURES") == "1" and not path.exists():
        path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    frozen = json.loads(path.read_text())
    assert payload == frozen, f"SDK output diverged from frozen fixture {path.name}"


def test_minimal_matches_fixture():
    _check("minimal", _build(full=False))


def test_full_matches_fixture():
    _check("full", _build(full=True))
