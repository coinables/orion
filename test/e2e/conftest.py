"""Shared setup for the workspace end-to-end tests.

The page is opened from file:// (it has to work that way), Firefox runs headless, and the mempool.space / .onion API is
answered from the public-chain fixtures in test/fixtures, so the tests are deterministic and never touch the network.
"""
import json
import pathlib
import re

import pytest
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
FX = ROOT / "test" / "fixtures"
PAGE_URL = (ROOT / "public" / "workspace.html").as_uri()
SHOTS = pathlib.Path(__import__("os").environ.get("ORION_SHOTS", ROOT / "test" / "e2e" / "shots"))


def fx(name):
    return json.loads((FX / name).read_text(encoding="utf-8"))


NORMAL = fx("tx_normal.json")
OUTSPENDS = fx("outspends_normal.json")
SPENDERS = [fx("tx_spender_0.json"), fx("tx_spender_1.json")]
COINBASE = fx("tx_coinbase.json")
OPRETURN = fx("tx_opreturn.json")
ADDR_STATS = fx("address_stats.json")
ADDR_TXS = fx("address_txs.json")
ADDRESS = ADDR_STATS["address"]
HIST = fx("historical_price_sample.json")      # real mempool.space price points around 2022 plus the newest few
PRICES_NOW = fx("prices_now.json")


def make_routes():
    r = {
        "/tx/" + NORMAL["txid"]: NORMAL,
        "/tx/" + NORMAL["txid"] + "/outspends": OUTSPENDS,
        "/address/" + ADDRESS: ADDR_STATS,
        "/address/" + ADDRESS + "/txs": ADDR_TXS,
        "/blocks/tip/height": "971587",
        "/v1/prices": PRICES_NOW,
    }
    for cur in ("USD", "EUR", "GBP", "CAD", "CHF", "AUD", "JPY"):
        r["/v1/historical-price?currency=" + cur] = HIST
    for t in SPENDERS:
        r["/tx/" + t["txid"]] = t
        r["/tx/" + t["txid"] + "/outspends"] = [{"spent": False} for _ in t["vout"]]
    for t in (COINBASE, OPRETURN):
        r["/tx/" + t["txid"]] = t
        r["/tx/" + t["txid"] + "/outspends"] = [{"spent": False} for _ in t["vout"]]
    for t in ADDR_TXS:
        r.setdefault("/tx/" + t["txid"], t)
    return r


class Mock:
    """The fake API. `requests` records every call as (host, path); `fail` forces a status for a path."""

    def __init__(self):
        self.routes = make_routes()
        self.requests = []
        self.fail = {}
        self.delay_ms = 0

    def handle(self, route):
        m = re.match(r"^(https?://[^/]+)/api(/.*)$", route.request.url)
        host, path = m.group(1), m.group(2)
        self.requests.append((host, path))
        cors = {"access-control-allow-origin": "*"}
        if path in self.fail:
            return route.fulfill(status=self.fail[path], body="error", headers=cors)
        body = self.routes.get(path)
        if body is None:
            return route.fulfill(status=404, body="Transaction not found", headers=cors)
        if isinstance(body, str):
            return route.fulfill(status=200, body=body, headers={**cors, "content-type": "text/plain"})
        route.fulfill(status=200, body=json.dumps(body), headers={**cors, "content-type": "application/json"})


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as pw:
        b = pw.firefox.launch(headless=True)
        yield b
        b.close()


@pytest.fixture
def mock():
    return Mock()


@pytest.fixture
def errors():
    return []


@pytest.fixture
def ctx(browser, mock):
    c = browser.new_context(viewport={"width": 1400, "height": 850}, accept_downloads=True)
    c.route(re.compile(r"^https?://[^/]+/api/"), mock.handle)
    yield c
    c.close()


@pytest.fixture
def fpage(ctx, errors):
    """A fresh page exactly as a new visitor gets it: Focus on."""
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    p.goto(PAGE_URL)
    p.wait_for_function("window.__orion && window.__orion.renderer")
    return p


@pytest.fixture
def page(fpage):
    """The same page with Focus switched off, i.e. the cumulative whole-graph view most tests were written for."""
    fpage.uncheck("#focusOn")
    return fpage


def shot(page, name):
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / name))
