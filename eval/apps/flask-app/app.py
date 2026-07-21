from flask import Flask, jsonify

from cart import Item, cart_total

app = Flask(__name__)


@app.get("/cart/total")
def total():
    return jsonify({"total": cart_total([Item(5), Item(None)])})
