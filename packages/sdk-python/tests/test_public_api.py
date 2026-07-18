import logging

import opslane
from opslane import _state


class StubTransport:
    def __init__(self):
        self.sent = []
        self.flushed = False

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
        self.flushed = True
        return True


def setup_function(_function):
    _state.client = None


def _init_with_stub(**kwargs):
    opslane.init(api_key="k", endpoint="https://x.example", **kwargs)
    _state.client.transport = StubTransport()
    return _state.client.transport


def test_capture_before_init_warns_and_drops(caplog):
    with caplog.at_level(logging.WARNING, logger="opslane"):
        opslane.capture_exception(ValueError("x"))
    assert any("init" in record.message for record in caplog.records)


def test_init_then_capture():
    transport = _init_with_stub()
    try:
        raise ValueError("boom")
    except ValueError as exc:
        opslane.capture_exception(exc)
    assert transport.sent[-1]["error"]["type"] == "ValueError"


def test_set_and_clear_user_flow():
    transport = _init_with_stub()
    opslane.set_user({"id": "u1"})
    try:
        raise ValueError("boom")
    except ValueError as exc:
        opslane.capture_exception(exc)
    assert transport.sent[-1]["context"]["user"]["id"] == "u1"
    opslane.clear_user()
    try:
        raise ValueError("boom2")
    except ValueError as exc:
        opslane.capture_exception(exc)
    assert "user" not in transport.sent[-1]["context"]


def test_reinit_warns_flushes_old_client_and_replaces(caplog):
    transport = _init_with_stub()
    first = _state.client
    with caplog.at_level(logging.WARNING, logger="opslane"):
        opslane.init(api_key="k2", endpoint="https://y.example")
    assert _state.client is not first
    assert transport.flushed
    assert any("already initialized" in record.message for record in caplog.records)


def test_flush_without_init_is_true():
    assert opslane.flush(timeout=0.1) is True
