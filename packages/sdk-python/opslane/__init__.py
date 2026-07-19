"""Opslane Python SDK: backend error capture for the Opslane engine."""
import atexit
import logging
import threading

from opslane import context as _context

__version__ = "0.1.0a2"

__all__ = ["init", "set_user", "clear_user", "capture_exception", "flush"]

logger = logging.getLogger("opslane")


class _State:
    def __init__(self):
        self.client = None
        self.lock = threading.Lock()
        self.atexit_registered = False


_state = _State()


def init(api_key, endpoint, release=None, **options):
    """Configure the SDK, draining and replacing an existing client."""
    from opslane.client import Client

    with _state.lock:
        old = _state.client
        if old is not None:
            logger.warning("opslane: already initialized; replacing client")
        _state.client = Client(
            api_key=api_key, endpoint=endpoint, release=release, **options
        )
        if not _state.atexit_registered:
            atexit.register(flush)
            _state.atexit_registered = True
    if old is not None:
        old.transport.flush(timeout=2.0)
        stop = getattr(old.transport, "stop", None)
        if stop is not None:
            stop()


def set_user(user):
    """Attach user context to subsequently captured events."""
    _context.set_user(user)


def clear_user():
    """Clear user context for subsequently captured events."""
    _context.clear_user()


def capture_exception(exc):
    """Capture an exception without raising into application code."""
    client = _state.client
    if client is None:
        logger.warning("opslane: capture_exception before init(); event dropped")
        return
    try:
        client.capture_exception(exc)
    except Exception:
        logger.warning("opslane: capture failed", exc_info=True)


def flush(timeout=5.0):
    """Drain pending events, returning whether the queue emptied in time."""
    client = _state.client
    if client is None:
        return True
    return client.transport.flush(timeout=timeout)
