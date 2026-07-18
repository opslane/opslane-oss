"""Flask lifecycle, exception-signal, and logging integration."""
import logging

from flask import g, request
from flask.signals import got_request_exception

import opslane
from opslane import context as _context
from opslane.client import _now_iso, map_log_level

logger = logging.getLogger("opslane")

_EXTENSION_KEY = "opslane"
_TOKENS_KEY = "_opslane_scope_tokens"


class _BreadcrumbLogHandler(logging.Handler):
    def emit(self, record):
        try:
            _context.add_breadcrumb(
                {
                    "type": "log",
                    "timestamp": _now_iso(),
                    "category": record.name,
                    "level": map_log_level(record.levelname),
                    "message": record.getMessage(),
                }
            )
        except Exception:
            pass


class OpslaneFlask:
    """Attach Opslane error capture to one Flask application."""

    def __init__(self, app, log_level=logging.WARNING):
        if app.extensions.get(_EXTENSION_KEY):
            logger.warning(
                "opslane: app already wrapped; ignoring second OpslaneFlask"
            )
            return
        app.extensions[_EXTENSION_KEY] = self

        app.before_request(self._before_request)
        app.teardown_request(self._teardown_request)
        got_request_exception.connect(self._on_exception, app, weak=False)

        self._log_handler = _BreadcrumbLogHandler(level=log_level)
        app.logger.addHandler(self._log_handler)

    def _before_request(self):
        if getattr(g, _TOKENS_KEY, None) is not None:
            return
        metadata = {
            "method": request.method,
            "path": request.path,
            "headers": dict(request.headers),
            "remote_addr": request.remote_addr,
        }
        setattr(g, _TOKENS_KEY, _context.push_scope(metadata))
        _context.add_breadcrumb(
            {
                "type": "http",
                "timestamp": _now_iso(),
                "category": "request",
                "message": f"{request.method} {request.path}",
                "data": {
                    "method": request.method,
                    "path": request.path,
                    "content_type": request.content_type or "",
                },
            }
        )

    def _teardown_request(self, exc):
        tokens = g.pop(_TOKENS_KEY, None)
        if tokens is not None:
            _context.reset_scope(tokens)

    def _on_exception(self, sender, exception, **extra):
        opslane.capture_exception(exception)
