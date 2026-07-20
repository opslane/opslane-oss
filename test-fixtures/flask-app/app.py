"""Fixture Flask app for the E2B install benchmark (Batch 0, #86), the
Batch 1 (#87) SDK smoke test, and Batch 3 (#89) evals. /boom raises
deliberately."""
from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/boom")
def boom():
    raise ValueError("seeded failure for SDK testing")


@app.get("/boom-secret")
def boom_secret():
    """Raises with planted FAKE credentials (a DSN and a ghp_ token). The
    python-smoke e2e asserts the read API serves this incident with both
    values redacted; they must never appear in an API response."""
    raise ValueError(
        "connect to postgres://svc:plantedfakepassword@db.internal/app failed"
        " (token ghp_plantedfakee2esecret123)"
    )
