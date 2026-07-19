"""Bounded, asynchronous HTTP transport for error events."""
import email.utils
import json
import logging
import os
import queue
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import weakref
from collections import deque
from datetime import datetime, timezone

logger = logging.getLogger("opslane")

DRAIN_INTERVAL = 5.0
BATCH_SIZE = 10
MAX_BACKOFF = 60.0
RATE_LIMIT_WINDOW = 60.0  # max_events_per_minute counts enqueues in this window

_CLEARTEXT_OK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _parse_retry_after(header):
    """Retry-After per RFC 9110: delta-seconds or an HTTP-date."""
    if header is None:
        return None
    try:
        return float(header)
    except (TypeError, ValueError):
        pass
    try:
        when = email.utils.parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: a POST 301/302/303 would silently become a bodyless
    GET while still forwarding the API key to the redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirectHandler)


class RetryableSendError(Exception):
    """Network, rate-limit, or server error that may succeed on retry."""

    def __init__(self, status=None, retry_after=None):
        super().__init__(f"retryable send failure (status={status})")
        self.status = status
        self.retry_after = retry_after


class FatalSendError(Exception):
    """A non-retryable client error."""

    def __init__(self, status):
        super().__init__(f"fatal send failure (status={status})")
        self.status = status


class Transport:
    def __init__(
        self,
        endpoint,
        api_key,
        max_events_per_minute=100,
        http_timeout=5.0,
        queue_size=100,
        max_attempts=5,
    ):
        self._endpoint = endpoint.rstrip("/") + "/api/v1/events"
        scheme_host = urllib.parse.urlsplit(self._endpoint)
        if scheme_host.scheme != "https" and scheme_host.hostname not in _CLEARTEXT_OK_HOSTS:
            logger.warning(
                "opslane: endpoint %s is not https; API key and event data "
                "will travel in cleartext",
                endpoint,
            )
        self._api_key = api_key
        self._http_timeout = http_timeout
        self._queue_size = queue_size
        self._max_attempts = max_attempts
        self._max_per_minute = max_events_per_minute

        self._queue = queue.Queue(maxsize=queue_size)
        self._sent_stamps = deque()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread = None
        self._pid = None
        self._backoff_until = 0.0
        self._in_flight = False
        self._stopped = False
        self._send_fn = self._http_send
        self._thread_enabled = True

        if hasattr(os, "register_at_fork"):
            self_ref = weakref.ref(self)

            def _after_fork_in_child():
                transport = self_ref()
                if transport is not None:
                    transport._reset_after_fork()

            os.register_at_fork(after_in_child=_after_fork_in_child)

    def enqueue(self, payload):
        """Queue an event without blocking or raising into application code."""
        try:
            self._ensure_thread()
            if not self._admit(payload):
                logger.warning("opslane: client-side rate limit hit; event dropped")
                return
            self._wake.set()
        except Exception:
            logger.warning("opslane: enqueue failed; event dropped", exc_info=True)

    def flush(self, timeout=5.0):
        """Wait for pending events to drain, honoring active retry backoff."""
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                with self._lock:
                    if self._queue.empty() and not self._in_flight:
                        return True
                if self._thread_enabled and not self._queue.empty():
                    self._ensure_thread()
                self._wake.set()
                time.sleep(0.05)
            with self._lock:
                return self._queue.empty() and not self._in_flight
        except Exception:
            logger.warning("opslane: flush failed", exc_info=True)
            return False

    def queue_size(self):
        return self._queue.qsize()

    def stop(self):
        """Let the background thread exit; called when a client is replaced."""
        self._stopped = True
        self._wake.set()

    def _reset_after_fork(self):
        """Discard inherited events and rebuild synchronization in a child."""
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._queue = queue.Queue(maxsize=self._queue_size)
        self._sent_stamps = deque()
        self._thread = None
        self._pid = None
        self._in_flight = False
        self._backoff_until = 0.0
        logger.debug("opslane: fork detected; transport state reinitialized")

    def _admit(self, payload):
        """Atomically enforce the process rate limit and enqueue an event."""
        now = time.monotonic()
        with self._lock:
            while self._sent_stamps and now - self._sent_stamps[0] > RATE_LIMIT_WINDOW:
                self._sent_stamps.popleft()
            if len(self._sent_stamps) >= self._max_per_minute:
                return False
            self._put_dropping_oldest([payload, 0])
            self._sent_stamps.append(now)
            return True

    def _put_dropping_oldest(self, item):
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            try:
                self._queue.get_nowait()
                logger.warning("opslane: queue full; oldest event dropped")
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(item)
            except queue.Full:
                logger.warning("opslane: queue full; event dropped")

    def _ensure_thread(self):
        if self._stopped:
            return
        if not self._thread_enabled:
            self._pid = self._pid or os.getpid()
            return
        with self._lock:
            pid = os.getpid()
            if (
                self._thread is not None
                and self._thread.is_alive()
                and self._pid == pid
            ):
                return
            self._pid = pid
            self._thread = threading.Thread(
                target=self._run, name="opslane-transport", daemon=True
            )
            self._thread.start()

    def _run(self):
        while not self._stopped:
            self._wake.wait(timeout=DRAIN_INTERVAL)
            self._wake.clear()
            try:
                self._drain()
            except Exception:
                logger.warning("opslane: drain error", exc_info=True)

    def _drain(self):
        for _ in range(BATCH_SIZE):
            if time.monotonic() < self._backoff_until:
                return
            with self._lock:
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:
                    return
                self._in_flight = True
            payload, attempts = item
            try:
                self._send_fn(payload)
            except RetryableSendError as exc:
                attempts += 1
                if attempts >= self._max_attempts:
                    logger.warning(
                        "opslane: event dropped after %d attempts (status=%s)",
                        attempts,
                        exc.status,
                    )
                else:
                    self._put_dropping_oldest([payload, attempts])
                    delay = (
                        exc.retry_after
                        if exc.retry_after is not None
                        else min(MAX_BACKOFF, 2**attempts)
                        * (0.5 + random.random() / 2)
                    )
                    delay = min(MAX_BACKOFF, max(0.0, delay))
                    self._backoff_until = time.monotonic() + delay
                    logger.debug("opslane: retrying in %.1fs", delay)
            except FatalSendError as exc:
                logger.warning(
                    "opslane: event rejected (status=%s); dropped", exc.status
                )
            except Exception:
                logger.warning(
                    "opslane: unexpected send error; event dropped", exc_info=True
                )
            finally:
                with self._lock:
                    self._in_flight = False

    def _http_send(self, payload):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-API-Key": self._api_key,
            },
            method="POST",
        )
        try:
            with _OPENER.open(request, timeout=self._http_timeout):
                pass
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                logger.warning(
                    "opslane: endpoint redirected (status=%s); redirects are "
                    "not followed — point the SDK at the final endpoint URL",
                    exc.code,
                )
                raise FatalSendError(status=exc.code) from exc
            if exc.code == 429 or exc.code >= 500:
                header = exc.headers.get("Retry-After") if exc.headers else None
                retry_after = _parse_retry_after(header)
                raise RetryableSendError(
                    status=exc.code, retry_after=retry_after
                ) from exc
            raise FatalSendError(status=exc.code) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RetryableSendError() from exc
