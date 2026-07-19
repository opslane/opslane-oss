import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from opslane.transport import FatalSendError, RetryableSendError, Transport


def make_transport(send_fn, **kwargs):
    transport = Transport(endpoint="https://x.example", api_key="k", **kwargs)
    transport._send_fn = send_fn
    transport._thread_enabled = False
    return transport


def test_send_success_drains_queue():
    sent = []
    transport = make_transport(lambda payload: sent.append(payload))
    transport.enqueue({"n": 1})
    transport.enqueue({"n": 2})
    transport._drain()
    assert [payload["n"] for payload in sent] == [1, 2]
    assert transport.queue_size() == 0


def test_queue_cap_drops_oldest():
    sent = []
    transport = make_transport(lambda payload: sent.append(payload), queue_size=3)
    for i in range(5):
        transport.enqueue({"n": i})
    transport._drain()
    assert [payload["n"] for payload in sent] == [2, 3, 4]
    assert transport.queue_size() == 0


def test_rate_limit_drops_at_enqueue(caplog):
    transport = make_transport(lambda payload: None, max_events_per_minute=2)
    with caplog.at_level(logging.WARNING, logger="opslane"):
        for i in range(5):
            transport.enqueue({"n": i})
    assert transport.queue_size() == 2
    assert any("rate limit" in record.message for record in caplog.records)


def test_rate_limit_admission_is_atomic_across_threads():
    transport = make_transport(lambda payload: None, max_events_per_minute=10)
    barrier = threading.Barrier(50)

    def enqueue(i):
        barrier.wait()
        transport.enqueue({"n": i})

    threads = [threading.Thread(target=enqueue, args=(i,)) for i in range(50)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert transport.queue_size() == 10


def test_retryable_failure_requeues_with_backoff():
    calls = []

    def failing(payload):
        calls.append(payload)
        raise RetryableSendError(status=503)

    transport = make_transport(failing)
    transport.enqueue({"n": 1})
    transport._drain()
    assert len(calls) == 1
    assert transport.queue_size() == 1
    assert transport._backoff_until > time.monotonic()


def test_fatal_failure_drops_immediately(caplog):
    def fatal(payload):
        raise FatalSendError(status=401)

    transport = make_transport(fatal)
    with caplog.at_level(logging.WARNING, logger="opslane"):
        transport.enqueue({"n": 1})
        transport._drain()
    assert transport.queue_size() == 0
    assert any("401" in record.message for record in caplog.records)


def test_max_attempts_then_drop():
    def failing(payload):
        raise RetryableSendError(status=503)

    transport = make_transport(failing, max_attempts=3)
    transport.enqueue({"n": 1})
    for _ in range(10):
        transport._backoff_until = 0.0
        transport._drain()
    assert transport.queue_size() == 0


def test_failing_event_does_not_block_successors():
    sent = []

    def selective(payload):
        if payload["n"] == 1:
            raise RetryableSendError(status=503)
        sent.append(payload)

    transport = make_transport(selective, max_attempts=2)
    transport.enqueue({"n": 1})
    transport.enqueue({"n": 2})
    for _ in range(5):
        transport._backoff_until = 0.0
        transport._drain()
    assert [payload["n"] for payload in sent] == [2]


def test_retry_after_overrides_backoff():
    def failing(payload):
        raise RetryableSendError(status=429, retry_after=42.0)

    transport = make_transport(failing)
    transport.enqueue({"n": 1})
    before = time.monotonic()
    transport._drain()
    assert transport._backoff_until == pytest.approx(before + 42.0, abs=1.0)


def test_parse_retry_after_delta_and_http_date():
    from email.utils import format_datetime
    from datetime import datetime, timedelta, timezone

    from opslane.transport import _parse_retry_after

    assert _parse_retry_after(None) is None
    assert _parse_retry_after("42") == 42.0
    assert _parse_retry_after("not a date") is None

    future = datetime.now(timezone.utc) + timedelta(seconds=30)
    parsed = _parse_retry_after(format_datetime(future, usegmt=True))
    assert parsed == pytest.approx(30.0, abs=2.0)

    past = datetime.now(timezone.utc) - timedelta(seconds=30)
    assert _parse_retry_after(format_datetime(past, usegmt=True)) == 0.0


def test_retry_after_capped_at_60():
    def failing(payload):
        raise RetryableSendError(status=429, retry_after=3600.0)

    transport = make_transport(failing)
    transport.enqueue({"n": 1})
    before = time.monotonic()
    transport._drain()
    assert transport._backoff_until <= before + 61.0


def test_flush_returns_true_on_empty_and_false_on_stuck():
    transport = make_transport(lambda payload: None)
    assert transport.flush(timeout=0.2) is True

    def failing(payload):
        raise RetryableSendError(status=503)

    stuck = make_transport(failing)
    stuck.enqueue({"n": 1})
    assert stuck.flush(timeout=0.3) is False


def test_flush_does_not_defeat_retry_after():
    def failing(payload):
        raise RetryableSendError(status=429, retry_after=30.0)

    transport = make_transport(failing)
    transport.enqueue({"n": 1})
    transport._drain()
    before = transport._backoff_until
    assert transport.flush(timeout=0.2) is False
    assert transport._backoff_until == before


def test_enqueue_never_raises():
    def exploding(payload):
        raise RuntimeError("unexpected")

    transport = make_transport(exploding)
    transport.enqueue({"n": 1})
    transport._drain()
    assert transport.queue_size() == 0


def test_fork_reset_reinitializes_state():
    transport = make_transport(lambda payload: None)
    transport.enqueue({"n": 1})
    transport._reset_after_fork()
    assert transport.queue_size() == 0
    transport.enqueue({"n": 2})
    assert transport.queue_size() == 1


@pytest.mark.parametrize("network_error", [TimeoutError("timed out"), OSError("down")])
def test_direct_network_errors_are_retryable(monkeypatch, network_error):
    def fail(*_args, **_kwargs):
        raise network_error

    import opslane.transport as transport_module

    monkeypatch.setattr(transport_module._OPENER, "open", fail)
    transport = Transport(endpoint="https://x.example", api_key="k")
    with pytest.raises(RetryableSendError):
        transport._http_send({"n": 1})


def test_redirects_not_followed_and_fatal():
    hits = []

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            hits.append(("POST", self.path))
            self.send_response(302)
            self.send_header("Location", "/elsewhere")
            self.end_headers()

        def do_GET(self):
            hits.append(("GET", self.path))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        transport = Transport(
            endpoint=f"http://127.0.0.1:{server.server_address[1]}", api_key="key"
        )
        with pytest.raises(FatalSendError):
            transport._http_send({"n": 1})
        assert hits == [("POST", "/api/v1/events")]
    finally:
        server.shutdown()
        server.server_close()


def test_stop_terminates_background_thread():
    transport = Transport(endpoint="https://x.example", api_key="k")
    transport._send_fn = lambda payload: None
    transport.enqueue({"n": 1})
    assert transport.flush(timeout=2.0)
    thread = transport._thread
    assert thread is not None and thread.is_alive()
    transport.stop()
    thread.join(timeout=2.0)
    assert not thread.is_alive()
    # A stopped transport must not resurrect its thread.
    transport.enqueue({"n": 2})
    assert transport._thread is thread


def test_real_http_delivery():
    received = []

    class CaptureHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append(
                {
                    "path": self.path,
                    "api_key": self.headers.get("X-API-Key"),
                    "body": json.loads(body),
                }
            )
            self.send_response(202)
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        transport = Transport(
            endpoint=f"http://127.0.0.1:{server.server_address[1]}", api_key="key"
        )
        transport.enqueue({"n": 1})
        assert transport.flush(timeout=5.0)
        assert received == [
            {"path": "/api/v1/events", "api_key": "key", "body": {"n": 1}}
        ]
    finally:
        server.shutdown()
        server.server_close()
