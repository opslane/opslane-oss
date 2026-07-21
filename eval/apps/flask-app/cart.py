from dataclasses import dataclass


@dataclass
class Item:
    price: int | None
    details: object | None = None


def cart_total(items: list[Item]) -> int:
    return sum(item.price or 0 for item in items)


def item_label(item: Item) -> str:
    return getattr(item.details, "label", "unknown")
