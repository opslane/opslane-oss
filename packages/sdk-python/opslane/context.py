"""Context-local request state: user, breadcrumbs, and request metadata.

The mutable breadcrumb buffer is shared when a context is explicitly copied.
That limitation does not affect the supported sync-Flask deployment model,
where each request owns one thread/context.
"""
import contextvars
from typing import Optional

from opslane.breadcrumbs import BreadcrumbBuffer

_user: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "opslane_user", default=None
)
_breadcrumbs: contextvars.ContextVar[Optional[BreadcrumbBuffer]] = contextvars.ContextVar(
    "opslane_breadcrumbs", default=None
)
_request: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "opslane_request", default=None
)


def push_scope(request_meta: Optional[dict]) -> tuple:
    """Start a fresh request scope and return tokens used to restore it."""
    return (
        _user.set(None),
        _breadcrumbs.set(BreadcrumbBuffer()),
        _request.set(dict(request_meta) if request_meta else None),
    )


def reset_scope(tokens: tuple) -> None:
    """Restore a scope, degrading safely when called from another context."""
    for var, token in zip((_user, _breadcrumbs, _request), tokens):
        try:
            var.reset(token)
        except ValueError:
            var.set(None)


def set_user(user: Optional[dict]) -> None:
    _user.set(dict(user) if user else None)


def get_user() -> Optional[dict]:
    return _user.get()


def clear_user() -> None:
    _user.set(None)


def add_breadcrumb(crumb: dict) -> None:
    buf = _breadcrumbs.get()
    if buf is None:
        buf = BreadcrumbBuffer()
        _breadcrumbs.set(buf)
    buf.add(crumb)


def get_breadcrumbs() -> list:
    buf = _breadcrumbs.get()
    return buf.snapshot() if buf is not None else []


def get_request() -> Optional[dict]:
    return _request.get()
