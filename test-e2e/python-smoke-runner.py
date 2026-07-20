"""Runs the fixture Flask app wired to the real Python SDK.

Spawned by python-smoke.test.ts. Not a test itself: it is the "customer
application" leg of the e2e — the checked-in test-fixtures/flask-app served
over real HTTP with the real opslane SDK attached, pointing at whatever
ingestion stack the e2e suite targets.

Env:
  OPSLANE_API_KEY   raw SDK key for the seeded tenant (required)
  OPSLANE_ENDPOINT  ingestion base URL, e.g. http://localhost:8093 (required)
  PORT              port to serve the Flask app on (required)
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "sdk-python"))
sys.path.insert(0, os.path.join(ROOT, "test-fixtures", "flask-app"))

import opslane
from opslane.integrations.flask import OpslaneFlask

opslane.init(
    api_key=os.environ["OPSLANE_API_KEY"],
    endpoint=os.environ["OPSLANE_ENDPOINT"],
    release="python-smoke-e2e",
)

from app import app  # the fixture app: /health, /boom, /boom-secret

app.config["PROPAGATE_EXCEPTIONS"] = False
OpslaneFlask(app)

if __name__ == "__main__":
    app.run(port=int(os.environ["PORT"]))
