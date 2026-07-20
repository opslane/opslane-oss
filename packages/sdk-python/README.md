# Opslane Python SDK

Backend error capture for the Opslane error-resolution engine. Python 3.11+
and Flask 3 are supported in this pre-release.

```bash
pip install opslane
```

```python
import opslane
from flask import Flask
from opslane.integrations.flask import OpslaneFlask

opslane.init(api_key="...", endpoint="https://ingest.example.com")

app = Flask(__name__)
OpslaneFlask(app)

# After application authentication:
opslane.set_user({"id": "user-123", "email": "user@example.com"})
```

Unhandled Flask exceptions are captured automatically. Use
`opslane.capture_exception(exc)` for handled errors and `opslane.flush()` for
a best-effort explicit drain during shutdown.

Call `opslane.set_user(...)` from view code or a `before_request` hook
registered *after* `OpslaneFlask(app)`: the wrapper resets its request scope
(including the user) at the start of each request, so a user set by an earlier
hook is cleared.

Client IP addresses (`remote_addr`) are only sent when you opt in with
`opslane.init(..., send_pii=True)`.

Licensed under the MIT License.
