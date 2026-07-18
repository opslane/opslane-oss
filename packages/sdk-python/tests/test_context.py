import contextvars
import threading

from opslane import context as ctx


def test_scope_lifecycle():
    tokens = ctx.push_scope({"method": "GET", "path": "/x"})
    ctx.set_user({"id": "u1"})
    ctx.add_breadcrumb({"type": "log"})
    assert ctx.get_user() == {"id": "u1"}
    assert ctx.get_request()["path"] == "/x"
    assert len(ctx.get_breadcrumbs()) == 1
    ctx.reset_scope(tokens)
    assert ctx.get_user() is None
    assert ctx.get_request() is None
    assert ctx.get_breadcrumbs() == []


def test_no_bleed_across_threads():
    errors = []

    def worker(i: int):
        try:
            tokens = ctx.push_scope({"method": "GET", "path": f"/u/{i}"})
            ctx.set_user({"id": f"user-{i}"})
            ctx.add_breadcrumb({"n": i})
            assert ctx.get_user() == {"id": f"user-{i}"}
            assert ctx.get_breadcrumbs() == [{"n": i}]
            assert ctx.get_request()["path"] == f"/u/{i}"
            ctx.reset_scope(tokens)
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(50)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []


def test_clear_user():
    tokens = ctx.push_scope(None)
    ctx.set_user({"id": "u1"})
    ctx.clear_user()
    assert ctx.get_user() is None
    ctx.reset_scope(tokens)


def test_reset_scope_survives_foreign_context():
    tokens = contextvars.copy_context().run(ctx.push_scope, None)
    ctx.reset_scope(tokens)
