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
