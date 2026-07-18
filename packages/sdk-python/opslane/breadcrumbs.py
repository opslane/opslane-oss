"""Request-scoped breadcrumb ring buffer."""
from collections import deque

MAX_BREADCRUMBS = 50


class BreadcrumbBuffer:
    def __init__(self, maxlen: int = MAX_BREADCRUMBS):
        self._buf = deque(maxlen=maxlen)

    def add(self, crumb: dict) -> None:
        self._buf.append(crumb)

    def snapshot(self) -> list:
        return list(self._buf)
