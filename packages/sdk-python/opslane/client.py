"""Build error event payloads and hand them to the HTTP transport."""
import platform as _platform
import sys
import traceback
from datetime import datetime, timezone

from opslane import context as ctx

DEFAULT_SENSITIVE_HEADERS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "authentication",
        "cookie",
        "set-cookie",
        "x-api-key",
        "x-csrf-token",
        "x-auth-token",
        "x-access-token",
        "x-amz-security-token",
    }
)

# Oversized events would be rejected wholesale by the server's 1MB
# request-body cap; truncate at build time so pathological exceptions still
# deliver. Limits are encoded UTF-8 bytes (the unit the server enforces).
MAX_MESSAGE_BYTES = 8 * 1024
MAX_STACK_BYTES = 256 * 1024
MAX_CRUMB_MESSAGE_BYTES = 1024
_TRUNCATION_MARKER = "\n...[truncated by opslane sdk]...\n"

_LEVEL_MAP = {
    "DEBUG": "debug",
    "INFO": "info",
    "WARNING": "warning",
    "ERROR": "error",
    "CRITICAL": "error",
}


def map_log_level(levelname: str) -> str:
    return _LEVEL_MAP.get(levelname, "info")


def filter_headers(headers, deny_list) -> dict:
    return {
        key.lower(): value
        for key, value in (headers or {}).items()
        if key.lower() not in deny_list
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _utf8_head(text: str, max_bytes: int) -> str:
    return text.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")


def _utf8_tail(text: str, max_bytes: int) -> str:
    return text.encode("utf-8")[-max_bytes:].decode("utf-8", errors="ignore")


def _truncate_tail(text: str, limit_bytes: int) -> str:
    if len(text.encode("utf-8")) <= limit_bytes:
        return text
    marker = "...[truncated]"
    return _utf8_head(text, limit_bytes - len(marker)) + marker


def _truncate_middle(text: str, limit_bytes: int) -> str:
    """Keep the head (traceback header) and tail (newest frames, message)."""
    if len(text.encode("utf-8")) <= limit_bytes:
        return text
    keep = (limit_bytes - len(_TRUNCATION_MARKER.encode("utf-8"))) // 2
    return _utf8_head(text, keep) + _TRUNCATION_MARKER + _utf8_tail(text, keep)


def _bounded_crumb(crumb: dict) -> dict:
    message = crumb.get("message")
    if isinstance(message, str):
        bounded = _truncate_tail(message, MAX_CRUMB_MESSAGE_BYTES)
        if bounded is not message:
            return {**crumb, "message": bounded}
    return crumb


def _qualified_type(exc: BaseException) -> str:
    exception_type = type(exc)
    module = getattr(exception_type, "__module__", "")
    if module in ("builtins", "", None):
        return exception_type.__qualname__
    return f"{module}.{exception_type.__qualname__}"


class Client:
    def __init__(
        self,
        api_key,
        endpoint,
        release=None,
        sensitive_headers=None,
        send_pii=False,
        max_events_per_minute=100,
        http_timeout=5.0,
        transport=None,
    ):
        from opslane.transport import Transport

        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.release = release
        self.send_pii = send_pii
        self.sensitive_headers = frozenset(
            header.lower()
            for header in (sensitive_headers or DEFAULT_SENSITIVE_HEADERS)
        )
        self.transport = transport or Transport(
            endpoint=self.endpoint,
            api_key=api_key,
            max_events_per_minute=max_events_per_minute,
            http_timeout=http_timeout,
        )

    def capture_exception(self, exc: BaseException) -> None:
        self.transport.enqueue(self.build_payload(exc))

    def build_payload(self, exc: BaseException) -> dict:
        from opslane import __version__

        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        payload = {
            "timestamp": _now_iso(),
            "platform": "python",
            "runtime": {
                "name": sys.implementation.name,
                "version": _platform.python_version(),
            },
            "error": {
                "type": _qualified_type(exc),
                "message": _truncate_tail(str(exc), MAX_MESSAGE_BYTES),
                "stack": _truncate_middle(stack, MAX_STACK_BYTES),
            },
            "breadcrumbs": [
                _bounded_crumb(crumb) for crumb in ctx.get_breadcrumbs()
            ],
            "context": self._build_context(),
            "sdk_version": __version__,
        }
        if self.release:
            payload["release"] = self.release
        return payload

    def _build_context(self) -> dict:
        from opslane import __version__

        context = {
            "user_agent": f"Python/{_platform.python_version()} opslane/{__version__}"
        }
        request = ctx.get_request()
        if request:
            context["url"] = (
                f"{request.get('method', '')} {request.get('path', '')}".strip()
            )
            request_context = {
                "method": request.get("method", ""),
                "path": request.get("path", ""),
                "headers": filter_headers(
                    request.get("headers"), self.sensitive_headers
                ),
            }
            if self.send_pii and request.get("remote_addr"):
                request_context["remote_addr"] = request["remote_addr"]
            context["request"] = request_context

        user = ctx.get_user()
        if user and user.get("id"):
            mapped = {"id": str(user["id"])}
            if user.get("email"):
                mapped["email"] = str(user["email"])
            account = user.get("account") or {}
            if user.get("account_id") or account.get("id"):
                mapped["account_id"] = str(user.get("account_id") or account.get("id"))
            if user.get("account_name") or account.get("name"):
                mapped["account_name"] = str(
                    user.get("account_name") or account.get("name")
                )
            context["user"] = mapped
        return context
