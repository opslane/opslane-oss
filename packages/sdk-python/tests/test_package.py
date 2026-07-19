"""Package metadata and public-surface smoke tests."""
import importlib
import importlib.metadata

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


def test_zero_runtime_dependencies():
    # The design guarantees stdlib-only. Assert it from distribution metadata
    # (module-import sniffing is weaker and affected by pytest plugins).
    reqs = importlib.metadata.requires("opslane") or []
    runtime = [r for r in reqs if "extra ==" not in r]
    assert runtime == [], f"unexpected runtime dependencies: {runtime}"
