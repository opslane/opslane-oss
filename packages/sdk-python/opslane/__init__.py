"""Opslane Python SDK.

Batch 0 scaffold: the public API surface exists but is NOT implemented.
Every entry point raises NotImplementedError so nobody ships this alpha
believing errors are being captured. Batch 1 (opslane-oss#87) implements
capture, context, and transport.
"""

__version__ = "0.1.0a1"

__all__ = ["init", "set_user", "clear_user", "capture_exception", "flush"]

_NOT_IMPLEMENTED = (
    "The opslane SDK is a pre-release scaffold; error capture is not "
    "implemented yet. Track progress: "
    "https://github.com/opslane/opslane-oss/issues/87"
)


def init(**kwargs):
    """Configure the SDK. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def set_user(user):
    """Attach user context to subsequent events. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def clear_user():
    """Clear user context. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def capture_exception(exc):
    """Capture a handled exception. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def flush(timeout=5.0):
    """Drain the event queue. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)
