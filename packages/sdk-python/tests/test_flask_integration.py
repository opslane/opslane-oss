import pytest
from flask import Flask, abort

import opslane
from opslane import _state
from opslane.integrations.flask import OpslaneFlask


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
        return True


@pytest.fixture
def app_and_transport():
    _state.client = None
    opslane.init(api_key="k", endpoint="https://x.example")
    transport = StubTransport()
    _state.client.transport = transport

    app = Flask(__name__)
    app.config["PROPAGATE_EXCEPTIONS"] = False
    integration = OpslaneFlask(app)

    @app.get("/boom")
    def boom():
        raise ValueError("seeded failure")

    @app.get("/handled")
    def handled():
        raise KeyError("recovered")

    @app.errorhandler(KeyError)
    def recover(error):
        return {"recovered": True}, 200

    @app.errorhandler(500)
    def custom_500(error):
        return {"custom_500": True}, 500

    @app.get("/gone")
    def gone():
        abort(404)

    @app.get("/explicit")
    def explicit():
        try:
            raise RuntimeError("looked after")
        except RuntimeError as exc:
            opslane.capture_exception(exc)
        return {"ok": True}

    @app.get("/warn")
    def warn():
        app.logger.warning("token near expiry")
        raise ValueError("with breadcrumb")

    @app.get("/who")
    def who():
        opslane.set_user({"id": "u-req"})
        raise ValueError("user attached")

    yield app, transport

    app.logger.removeHandler(integration._log_handler)


def test_unhandled_exception_captured(app_and_transport):
    app, transport = app_and_transport
    response = app.test_client().get(
        "/boom", headers={"Authorization": "Bearer s3cr3t"}
    )
    assert response.status_code == 500
    assert len(transport.sent) == 1
    payload = transport.sent[0]
    assert payload["error"]["type"] == "ValueError"
    request = payload["context"]["request"]
    assert request["method"] == "GET" and request["path"] == "/boom"
    assert "authorization" not in request["headers"]
    assert payload["context"]["url"] == "GET /boom"
    assert payload["breadcrumbs"][0]["type"] == "http"
    assert payload["breadcrumbs"][0]["message"] == "GET /boom"


def test_errorhandler_recovered_not_captured(app_and_transport):
    app, transport = app_and_transport
    response = app.test_client().get("/handled")
    assert response.status_code == 200
    assert transport.sent == []


def test_custom_500_handler_still_captured(app_and_transport):
    app, transport = app_and_transport
    response = app.test_client().get("/boom")
    assert response.get_json() == {"custom_500": True}
    assert len(transport.sent) == 1


def test_http_exception_not_captured(app_and_transport):
    app, transport = app_and_transport
    assert app.test_client().get("/gone").status_code == 404
    assert transport.sent == []


def test_explicit_capture_works(app_and_transport):
    app, transport = app_and_transport
    assert app.test_client().get("/explicit").status_code == 200
    assert len(transport.sent) == 1
    assert transport.sent[0]["error"]["type"] == "RuntimeError"


def test_log_breadcrumbs_at_warning(app_and_transport):
    app, transport = app_and_transport
    app.test_client().get("/warn")
    logs = [
        crumb
        for crumb in transport.sent[0]["breadcrumbs"]
        if crumb["type"] == "log"
    ]
    assert logs and logs[0]["message"] == "token near expiry"
    assert logs[0]["level"] == "warning"


def test_user_scoped_to_request(app_and_transport):
    app, transport = app_and_transport
    app.test_client().get("/who")
    assert transport.sent[0]["context"]["user"]["id"] == "u-req"
    app.test_client().get("/boom")
    assert "user" not in transport.sent[1]["context"]


def test_double_wrap_is_noop(app_and_transport):
    app, transport = app_and_transport
    OpslaneFlask(app)
    app.test_client().get("/boom")
    assert len(transport.sent) == 1
