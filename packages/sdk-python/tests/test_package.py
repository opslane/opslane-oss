"""Batch 0 smoke tests: the package exists, imports, exposes the public API,
and refuses to pretend it works. Behavior tests arrive in Batch 1."""
import importlib
import importlib.metadata

import pytest


def test_package_imports():
    mod = importlib.import_module("opslane")
    assert mod.__version__


def test_version_matches_distribution_metadata():
    import opslane

    assert opslane.__version__ == importlib.metadata.version("opslane")


def test_public_api_surface():
    import opslane

    for name in ("init", "set_user", "clear_user", "capture_exception", "flush"):
        assert callable(getattr(opslane, name)), f"opslane.{name} missing"


def test_api_fails_loudly_until_implemented():
    # Batch 0 publishes a scaffold. A silent no-op init() would give users a
    # false sense that monitoring is active; every entry point must raise.
    import opslane

    with pytest.raises(NotImplementedError):
        opslane.init(api_key="x")
    with pytest.raises(NotImplementedError):
        opslane.capture_exception(ValueError("x"))


def test_flask_integration_fails_loudly():
    from opslane.integrations.flask import OpslaneFlask

    with pytest.raises(NotImplementedError):
        OpslaneFlask(object())


def test_zero_runtime_dependencies():
    # The design guarantees stdlib-only. Assert it from distribution metadata
    # (module-import sniffing is weaker and affected by pytest plugins).
    reqs = importlib.metadata.requires("opslane") or []
    runtime = [r for r in reqs if "extra ==" not in r]
    assert runtime == [], f"unexpected runtime dependencies: {runtime}"
