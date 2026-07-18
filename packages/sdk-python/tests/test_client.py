import opslane
from opslane import context as ctx
from opslane.client import (
    DEFAULT_SENSITIVE_HEADERS,
    Client,
    filter_headers,
    map_log_level,
)


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
        return True


def make_client(**kwargs):
    return Client(
        api_key="k",
        endpoint="https://ingest.example.com",
        transport=StubTransport(),
        **kwargs,
    )


def _capture(client):
    try:
        raise ValueError("boom hex 0xDEADBEEF")
    except ValueError as exc:
        client.capture_exception(exc)
    return client.transport.sent[-1]


def test_payload_core_fields():
    payload = _capture(make_client())
    assert payload["platform"] == "python"
    assert payload["runtime"]["name"]
    assert payload["runtime"]["version"].count(".") == 2
    assert payload["error"]["type"] == "ValueError"
    assert "boom hex" in payload["error"]["message"]
    assert payload["error"]["stack"].startswith(
        "Traceback (most recent call last):"
    )
    assert payload["sdk_version"] == opslane.__version__
    assert payload["timestamp"].endswith("Z")
    assert "release" not in payload


def test_qualified_exception_type():
    class Custom(Exception):
        pass

    client = make_client()
    try:
        raise Custom("x")
    except Custom as exc:
        client.capture_exception(exc)
    assert client.transport.sent[-1]["error"]["type"].endswith(
        "test_client.test_qualified_exception_type.<locals>.Custom"
    )


def test_request_context_and_compat_fields():
    tokens = ctx.push_scope(
        {
            "method": "GET",
            "path": "/api/users/123",
            "headers": {
                "Content-Type": "application/json",
                "Authorization": "Bearer s3cr3t",
            },
            "remote_addr": "10.0.1.50",
        }
    )
    try:
        payload = _capture(make_client())
    finally:
        ctx.reset_scope(tokens)
    request = payload["context"]["request"]
    assert request["method"] == "GET"
    assert "authorization" not in request["headers"]
    assert request["headers"]["content-type"] == "application/json"
    assert "remote_addr" not in request  # PII, requires send_pii=True
    assert payload["context"]["url"] == "GET /api/users/123"
    assert payload["context"]["user_agent"].startswith("Python/")


def test_remote_addr_sent_only_with_send_pii():
    meta = {
        "method": "GET",
        "path": "/x",
        "headers": {},
        "remote_addr": "10.0.1.50",
    }
    tokens = ctx.push_scope(meta)
    try:
        payload = _capture(make_client(send_pii=True))
    finally:
        ctx.reset_scope(tokens)
    assert payload["context"]["request"]["remote_addr"] == "10.0.1.50"


def test_oversized_message_and_stack_truncated():
    from opslane.client import MAX_MESSAGE_BYTES, MAX_STACK_BYTES

    client = make_client()
    # Multibyte characters: limits are enforced on encoded bytes, the unit the
    # server's 1MB request cap uses.
    try:
        raise ValueError("錯" * MAX_MESSAGE_BYTES)
    except ValueError as exc:
        exc.args = (exc.args[0] + "x" * MAX_STACK_BYTES,)  # bloat the stack too
        client.capture_exception(exc)
    payload = client.transport.sent[-1]
    assert len(payload["error"]["message"].encode("utf-8")) <= MAX_MESSAGE_BYTES
    assert payload["error"]["message"].endswith("...[truncated]")
    assert len(payload["error"]["stack"].encode("utf-8")) <= MAX_STACK_BYTES
    assert payload["error"]["stack"].startswith("Traceback (most recent call last):")


def test_oversized_breadcrumb_messages_truncated():
    from opslane.client import MAX_CRUMB_MESSAGE_BYTES

    tokens = ctx.push_scope(None)
    try:
        ctx.add_breadcrumb(
            {"type": "log", "category": "app", "level": "info", "message": "m" * 100_000}
        )
        payload = _capture(make_client())
    finally:
        ctx.reset_scope(tokens)
    crumb_message = payload["breadcrumbs"][0]["message"]
    assert len(crumb_message.encode("utf-8")) <= MAX_CRUMB_MESSAGE_BYTES
    assert crumb_message.endswith("...[truncated]")


def test_user_context_mapping():
    tokens = ctx.push_scope(None)
    try:
        ctx.set_user(
            {
                "id": "u1",
                "email": "a@b.c",
                "account": {"id": "acme", "name": "Acme"},
            }
        )
        payload = _capture(make_client())
    finally:
        ctx.reset_scope(tokens)
    assert payload["context"]["user"] == {
        "id": "u1",
        "email": "a@b.c",
        "account_id": "acme",
        "account_name": "Acme",
    }


def test_breadcrumbs_included():
    tokens = ctx.push_scope(None)
    try:
        ctx.add_breadcrumb(
            {
                "type": "log",
                "category": "app",
                "level": "warning",
                "message": "near expiry",
                "timestamp": "t",
            }
        )
        payload = _capture(make_client())
    finally:
        ctx.reset_scope(tokens)
    assert payload["breadcrumbs"][0]["message"] == "near expiry"


def test_filter_headers_deny_list():
    headers = {
        "Authorization": "x",
        "Proxy-Authorization": "x",
        "Authentication": "x",
        "Cookie": "x",
        "X-API-Key": "x",
        "X-CSRF-Token": "x",
        "X-Auth-Token": "x",
        "X-Access-Token": "x",
        "X-Amz-Security-Token": "x",
        "Set-Cookie": "x",
        "Accept": "text/html",
    }
    assert filter_headers(headers, DEFAULT_SENSITIVE_HEADERS) == {
        "accept": "text/html"
    }


def test_user_account_fields_coerced_to_strings():
    # Non-string values (UUIDs, ints) must not poison json.dumps in the
    # background sender, which would silently drop the event.
    import json
    import uuid

    account_id = uuid.uuid4()
    tokens = ctx.push_scope(None)
    try:
        ctx.set_user({"id": 7, "email": "a@b.c", "account_id": account_id})
        payload = _capture(make_client())
    finally:
        ctx.reset_scope(tokens)
    assert payload["context"]["user"]["id"] == "7"
    assert payload["context"]["user"]["account_id"] == str(account_id)
    json.dumps(payload)


def test_map_log_level():
    assert map_log_level("WARNING") == "warning"
    assert map_log_level("CRITICAL") == "error"
    assert map_log_level("unknown") == "info"


def test_release_included_when_set():
    payload = _capture(make_client(release="v1.2.3"))
    assert payload["release"] == "v1.2.3"
