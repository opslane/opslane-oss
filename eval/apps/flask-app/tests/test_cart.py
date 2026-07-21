from cart import Item, cart_total, item_label
from app import app


def test_total_handles_missing_price() -> None:
    assert cart_total([Item(5), Item(None)]) == 5


def test_total_adds_prices() -> None:
    assert cart_total([Item(5), Item(7)]) == 12


def test_label_handles_missing_details() -> None:
    assert item_label(Item(1, None)) == "unknown"


def test_label_reads_details() -> None:
    details = type("Details", (), {"label": "sale"})()
    assert item_label(Item(1, details)) == "sale"


def test_flask_total_route() -> None:
    response = app.test_client().get("/cart/total")
    assert response.status_code == 200
    assert response.json == {"total": 5}
