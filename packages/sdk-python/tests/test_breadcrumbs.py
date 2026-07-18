from opslane.breadcrumbs import MAX_BREADCRUMBS, BreadcrumbBuffer


def test_appends_in_order():
    buf = BreadcrumbBuffer()
    buf.add({"n": 1})
    buf.add({"n": 2})
    assert [c["n"] for c in buf.snapshot()] == [1, 2]


def test_ring_drops_oldest_at_cap():
    buf = BreadcrumbBuffer()
    for i in range(MAX_BREADCRUMBS + 10):
        buf.add({"n": i})
    snap = buf.snapshot()
    assert len(snap) == MAX_BREADCRUMBS
    assert snap[0]["n"] == 10
    assert snap[-1]["n"] == MAX_BREADCRUMBS + 9


def test_snapshot_is_a_copy():
    buf = BreadcrumbBuffer()
    buf.add({"n": 1})
    snap = buf.snapshot()
    snap.append({"n": 2})
    assert len(buf.snapshot()) == 1
