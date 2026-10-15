"""Tags (colour, shape, badge), the right-click menu, and the optional Arkham lookup."""
import csv
import http.server
import importlib.util
import io
import json
import pathlib
import re
import threading

import pytest

from conftest import NORMAL, OUTSPENDS, PAGE_URL, ROOT, shot
from helpers import click_node, counts, idle, open_query, settle, toast_text, xy

NORMAL_ID = "tx:" + NORMAL["txid"]
BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])
BIG_ADDR = "addr:" + NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = "addr:" + NORMAL["vout"][1 - BIG]["scriptpubkey_address"]
INPUT_ADDR = "addr:" + NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]

ARKHAM_REPLY = {"address": BIG_ADDR[5:], "chain": "bitcoin",
                "arkhamEntity": {"name": "Binance", "id": "binance", "type": "cex", "website": "https://binance.com"},
                "arkhamLabel": {"name": "Hot Wallet"}, "populatedTags": [{"id": "cex", "label": "CEX"}]}


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def node(page, id_):
    return page.evaluate("(id) => window.__orion.state.graph.nodes.get(id)", id_)


def rclick(page, id_):
    p = xy(page, id_)
    page.mouse.click(p["x"], p["y"], button="right")


def drawn_texts(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }""")


def select_only(page, id_):
    click_node(page, id_)
    assert page.evaluate("() => [...window.__orion.state.selected]") == [id_]


# ---------------------------------------------------------------- tags
def test_choosing_a_tag_sets_colour_shape_and_a_badge_on_the_graph(fpage):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, BIG_ADDR)
    fpage.select_option("#fTag", "EXCH")
    n = node(fpage, BIG_ADDR)
    assert (n["tag"], n["color"], n["shape"]) == ("EXCH", "#2ecc71", "hexagon")
    assert fpage.evaluate("(id) => window.__orion.renderer.data.style.nodeColor(window.__orion.state.graph.nodes.get(id))", BIG_ADDR) == "#2ecc71"
    assert "EXCH" in drawn_texts(fpage), "the badge is drawn above the vertex"
    assert "EXCH 1" in fpage.inner_text("#legend")
    assert fpage.input_value("#fColor") == "#2ecc71" and fpage.input_value("#fShape") == "hexagon"
    shot(fpage, "tagged.png")


def test_colour_and_shape_can_be_changed_independently_and_reset(fpage):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, BIG_ADDR)
    fpage.select_option("#fTag", "THREAT")
    fpage.evaluate("() => { const c = document.getElementById('fColor'); c.value = '#123abc'; c.dispatchEvent(new Event('input', { bubbles: true })); }")
    fpage.select_option("#fShape", "star")
    n = node(fpage, BIG_ADDR)
    assert (n["tag"], n["color"], n["shape"]) == ("THREAT", "#123abc", "star")
    fpage.click("button.swatch[data-color='#ffd23f']")
    assert node(fpage, BIG_ADDR)["color"] == "#ffd23f"
    fpage.click("text=Reset look")
    n = node(fpage, BIG_ADDR)
    assert n["tag"] == "THREAT" and "color" not in n and "shape" not in n, "the tag stays, the look is the usual one"
    fpage.select_option("#fTag", "")
    assert "tag" not in node(fpage, BIG_ADDR)


def test_a_custom_tag_is_just_text_and_leaves_the_look_alone(fpage):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, BIG_ADDR)
    fpage.select_option("#fTag", "__custom")
    assert fpage.is_visible("#fTagCustom")
    fpage.fill("#fTagCustom", "Lazarus <b>group</b>")
    n = node(fpage, BIG_ADDR)
    assert n["tag"] == "Lazarus bgroupb" and "color" not in n
    assert "Lazarus bgroupb" in drawn_texts(fpage)
    assert fpage.locator("#inspBody b").count() == 0


def test_transactions_can_be_tagged_too(fpage):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, NORMAL_ID)
    fpage.select_option("#fTag", "PAYMENT")
    n = node(fpage, NORMAL_ID)
    assert (n["tag"], n["shape"]) == ("PAYMENT", "star")
    assert "PAYMENT" in drawn_texts(fpage)


def test_several_vertices_can_be_tagged_at_once_and_the_legend_selects_them(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, BIG_ADDR); fpage.keyboard.down("Shift"); click_node(fpage, SMALL_ADDR); fpage.keyboard.up("Shift")
    # shift-click is handled as additive selection by the renderer
    assert len(fpage.evaluate("() => [...window.__orion.state.selected]")) == 2
    assert "tag all 2" in fpage.inner_text("#inspBody").lower()
    fpage.select_option("#fTag", "EXCH")
    assert node(fpage, BIG_ADDR)["tag"] == node(fpage, SMALL_ADDR)["tag"] == "EXCH"
    assert "EXCH 2" in fpage.inner_text("#legend")
    fpage.keyboard.press("Escape")
    fpage.locator("#legend .tagitem").first.click()
    assert sorted(fpage.evaluate("() => [...window.__orion.state.selected]")) == sorted([BIG_ADDR, SMALL_ADDR])


def test_tags_survive_reload_export_and_import(fpage, tmp_path):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, BIG_ADDR)
    fpage.select_option("#fTag", "EXCH")
    fpage.evaluate("() => { const c = document.getElementById('fColor'); c.value = '#abcdef'; c.dispatchEvent(new Event('input', { bubbles: true })); }")
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=json]")
    p = tmp_path / "t.json"; dl.value.save_as(p)
    saved = {x["id"]: x for x in json.loads(p.read_text(encoding="utf-8"))["nodes"]}[BIG_ADDR]
    assert (saved["tag"], saved["color"], saved["shape"]) == ("EXCH", "#abcdef", "hexagon")
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl2:
        fpage.click("[data-export=csv-nodes]")
    c = tmp_path / "n.csv"; dl2.value.save_as(c)
    rows = list(csv.reader(io.StringIO(c.read_text(encoding="utf-8-sig"), newline="")))
    row = next(r for r in rows[1:] if r[0] == BIG_ADDR)
    assert [row[rows[0].index(k)] for k in ("tag", "color", "shape")] == ["EXCH", "#abcdef", "hexagon"]
    fpage.wait_for_timeout(1000)
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    fpage.click("#restoreYes"); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); idle(fpage)
    assert node(fpage, BIG_ADDR)["tag"] == "EXCH" and node(fpage, BIG_ADDR)["color"] == "#abcdef"
    fpage.click("#btnClear"); fpage.click("#btnClear")
    fpage.set_input_files("#fileImport", str(p)); fpage.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); idle(fpage)
    assert node(fpage, BIG_ADDR)["shape"] == "hexagon"


def test_the_tag_colour_wins_in_every_colour_mode(fpage):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, BIG_ADDR)
    fpage.select_option("#fTag", "THREAT")
    for mode in ("age", "script", "type"):
        fpage.click("#colorSeg [data-color=%s]" % mode)
        assert fpage.evaluate("(id) => window.__orion.renderer.data.style.nodeColor(window.__orion.state.graph.nodes.get(id))", BIG_ADDR) == "#ff4d4d", mode


# ---------------------------------------------------------------- right-click menu
def test_right_click_a_wallet_opens_its_menu_and_selects_it(fpage):
    open_query(fpage, NORMAL["txid"])
    rclick(fpage, BIG_ADDR)
    assert fpage.is_visible("#ctxMenu")
    assert fpage.evaluate("() => [...window.__orion.state.selected]") == [BIG_ADDR]
    items = fpage.locator("#ctxMenu [role=menuitem]").all_inner_texts()
    joined = " | ".join(items)
    for want in ("Focus here", "Load history", "Look up in Arkham", "Tag as", "Copy address", "Open in explorer", "Remove from view"):
        assert want in joined, (want, joined)
    shot(fpage, "context_menu.png")


def test_tagging_from_the_menu(fpage):
    open_query(fpage, NORMAL["txid"])
    rclick(fpage, BIG_ADDR)
    fpage.click("#ctxMenu >> text=Tag as")
    assert "EXCH" in fpage.inner_text("#ctxMenu") and "THREAT" in fpage.inner_text("#ctxMenu")
    fpage.click("#ctxMenu >> text=THREAT")
    assert fpage.is_hidden("#ctxMenu")
    assert node(fpage, BIG_ADDR)["tag"] == "THREAT"
    rclick(fpage, BIG_ADDR)
    assert "Tag: THREAT" in fpage.inner_text("#ctxMenu")
    fpage.click("#ctxMenu >> text=change")
    fpage.click("#ctxMenu >> text=No tag")
    assert "tag" not in node(fpage, BIG_ADDR)


def test_menu_for_a_transaction_and_for_several_vertices_and_for_the_background(fpage):
    open_query(fpage, NORMAL["txid"])
    rclick(fpage, NORMAL_ID)
    t = fpage.inner_text("#ctxMenu")
    assert "Spenders" in t and "Funding" in t and "Copy txid" in t and "Look up in Arkham" not in t, "lookups are for wallets"
    fpage.keyboard.press("Escape")
    assert fpage.is_hidden("#ctxMenu")
    settle(fpage)                                                          # Escape also hid the details panel: the canvas widens and refits
    click_node(fpage, BIG_ADDR); settle(fpage)                             # ... and the first click opens it again
    fpage.keyboard.down("Shift"); click_node(fpage, SMALL_ADDR); fpage.keyboard.up("Shift")
    assert len(fpage.evaluate("() => [...window.__orion.state.selected]")) == 2
    rclick(fpage, SMALL_ADDR)
    t = fpage.inner_text("#ctxMenu")
    assert "2 selected" in t.lower() and "Remove 2 from view" in t and "Look up" not in t and "Load history" not in t, "no look-up for a group"
    fpage.keyboard.press("Escape")
    settle(fpage)
    b = fpage.locator("#cv").bounding_box()
    fpage.mouse.click(b["x"] + 40, b["y"] + 60, button="right")
    assert "Fit view" in fpage.inner_text("#ctxMenu") and "Re-layout" in fpage.inner_text("#ctxMenu")


def test_the_menu_closes_and_stays_on_screen(fpage):
    open_query(fpage, NORMAL["txid"])
    b = fpage.locator("#cv").bounding_box()
    fpage.mouse.click(b["x"] + b["width"] - 3, b["y"] + b["height"] - 3, button="right")      # the far corner of the canvas, near the corner of the window
    box = fpage.locator("#ctxMenu").bounding_box()
    assert box["x"] >= 0 and box["y"] >= 0 and box["x"] + box["width"] <= 1400 and box["y"] + box["height"] <= 850
    fpage.mouse.click(b["x"] + 5, b["y"] + 5)
    assert fpage.is_hidden("#ctxMenu")


def test_the_menu_works_from_the_keyboard(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.locator("#cv").focus()
    fpage.keyboard.press("Shift+F10")
    assert fpage.is_visible("#ctxMenu")
    first = fpage.evaluate("() => document.activeElement.textContent")
    fpage.keyboard.press("ArrowDown")
    assert fpage.evaluate("() => document.activeElement.textContent") != first
    fpage.keyboard.press("Escape")
    assert fpage.is_hidden("#ctxMenu")


def test_removing_from_the_menu(fpage):
    open_query(fpage, NORMAL["txid"])
    before = counts(fpage)["nodes"]
    rclick(fpage, SMALL_ADDR)
    fpage.click("#ctxMenu >> text=Remove from view")
    assert counts(fpage)["nodes"] < before


# ---------------------------------------------------------------- Arkham lookup (page against a mocked proxy)
class Proxy:
    def __init__(self):
        self.requests = []
        self.status = 200
        self.body = ARKHAM_REPLY

    def handle(self, route):
        req = route.request
        cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "X-Orion-Token, Accept", "access-control-allow-methods": "GET, OPTIONS",
                "access-control-allow-private-network": "true"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        self.requests.append((req.url, req.headers.get("x-orion-token")))
        if req.url.endswith("/health"):
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({"ok": True, "keyConfigured": True, "upstream": "https://api.arkm.com"}))
        route.fulfill(status=self.status, headers=cors, content_type="application/json", body=json.dumps(self.body))


@pytest.fixture
def arkham(ctx):
    p = Proxy()
    ctx.route(re.compile(r"^http://127\.0\.0\.1:8787/"), p.handle)
    return p


def set_up_proxy(page, token="tok123"):
    page.click("summary:has-text('External sources')") if page.evaluate("() => !document.getElementById('extSection').open") else None
    page.fill("#arkToken", token)


def test_nothing_is_ever_looked_up_unless_you_ask(fpage, arkham):
    open_query(fpage, NORMAL["txid"])
    set_up_proxy(fpage)
    fpage.wait_for_timeout(500)
    assert arkham.requests == []
    assert fpage.evaluate("() => [...window.__orion.state.graph.nodes.values()].some(n => n.ext)") is False


def test_the_lookup_needs_the_proxy_to_be_set_up_and_says_how(fpage, arkham):
    open_query(fpage, NORMAL["txid"])
    select_only(fpage, BIG_ADDR)
    fpage.click("#btnArkham")
    assert "arkham_proxy" in toast_text(fpage)
    assert fpage.evaluate("() => document.getElementById('extSection').open")
    assert arkham.requests == []


def test_lookup_asks_once_for_consent_sends_the_token_and_shows_the_result(fpage, arkham):
    open_query(fpage, NORMAL["txid"])
    set_up_proxy(fpage)
    select_only(fpage, BIG_ADDR)
    dialogs = []
    fpage.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    fpage.click("#btnArkham")
    assert len(dialogs) == 1 and BIG_ADDR[5:] in dialogs[0] and "Arkham" in dialogs[0]
    assert arkham.requests == [], "declining sends nothing"
    assert node(fpage, BIG_ADDR).get("ext") is None


def test_a_lookup_result_is_shown_and_can_be_applied_by_choice(ctx, errors, arkham):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept())
    p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
    open_query(p, NORMAL["txid"])
    set_up_proxy(p, "tok123")
    select_only(p, BIG_ADDR)
    p.click("#btnArkham")
    p.wait_for_function("(id) => !!window.__orion.state.graph.nodes.get(id).ext", arg=BIG_ADDR)
    assert arkham.requests == [("http://127.0.0.1:8787/intelligence/address/" + BIG_ADDR[5:], "tok123")]
    card = p.inner_text("#inspBody .extcard")
    assert "Binance" in card and "cex" in card and "Hot Wallet" in card and "CEX" in card
    n = node(p, BIG_ADDR)
    assert "label" not in n and "tag" not in n, "nothing was applied automatically"
    p.click("text=Use as label")
    assert node(p, BIG_ADDR)["label"] == "Binance · Hot Wallet"
    p.click("button:has-text('Tag as EXCH')")
    assert node(p, BIG_ADDR)["tag"] == "EXCH"
    assert "Raw reply" in p.inner_text("#inspBody .extcard")
    assert p.evaluate("(id) => !!window.__orion.state.graph.nodes.get(id).ext.arkham.raw", BIG_ADDR)
    # the wallet is marked on the graph, a second lookup does not ask for consent again
    p.click("#btnArkham"); p.wait_for_function("() => true")
    p.click("text=Remove result")
    assert "ext" not in node(p, BIG_ADDR)
    p.close()


def test_lookup_errors_are_explained(ctx, errors, arkham):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept())
    p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
    open_query(p, NORMAL["txid"]); set_up_proxy(p); select_only(p, BIG_ADDR)
    for status, body, expect in [(401, {"error": "missing or wrong token"}, "token"), (502, {"error": "Arkham rejected the API key (HTTP 401)"}, "API key"),
                                 (429, {"error": "slow down"}, "slow down"), (500, {"error": "boom"}, "boom")]:
        arkham.status, arkham.body = status, body
        p.click("#btnArkham")
        p.wait_for_function("(e) => document.getElementById('toast').textContent.includes(e)", arg=expect)
        assert "ext" not in node(p, BIG_ADDR)
    arkham.status, arkham.body = 404, {"error": "none"}
    p.click("#btnArkham")
    p.wait_for_function("() => document.getElementById('toast').textContent.includes('no entry')")
    assert node(p, BIG_ADDR)["ext"]["arkham"]["found"] is False
    assert "no entry" in p.inner_text("#inspBody .extcard")
    p.close()


def test_a_proxy_that_is_not_running_is_explained(ctx, errors):
    ctx.route(re.compile(r"^http://127\.0\.0\.1:8787/"), lambda r: r.abort("connectionrefused"))
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept())
    p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
    open_query(p, NORMAL["txid"]); set_up_proxy(p); select_only(p, BIG_ADDR)
    p.click("#btnArkham")
    p.wait_for_function("() => /arkham_proxy/.test(document.getElementById('toast').textContent)")
    p.click("#arkTest")
    p.wait_for_function("() => document.getElementById('arkResult').className === 'bad'")
    p.close()


def test_lookups_are_switched_off_over_tor(fpage, arkham):
    open_query(fpage, NORMAL["txid"]); set_up_proxy(fpage); select_only(fpage, BIG_ADDR)
    fpage.select_option("#source", "tor")
    fpage.click("#btnArkham")
    assert "Tor" in toast_text(fpage)
    assert arkham.requests == []


def test_only_wallets_can_be_looked_up(fpage, arkham):
    open_query(fpage, NORMAL["txid"]); set_up_proxy(fpage)
    select_only(fpage, NORMAL_ID)
    assert fpage.locator("#btnArkham").count() == 0
    fpage.evaluate("(id) => window.__orion.lookupArkham(id)", NORMAL_ID)
    assert "wallet" in toast_text(fpage).lower() and arkham.requests == []


def test_proxy_settings_are_checked_and_the_token_is_only_kept_if_asked(fpage):
    fpage.click("summary:has-text('External sources')")
    fpage.fill("#arkUrl", "http://evil.example.com:8787"); fpage.dispatch_event("#arkUrl", "change")
    assert "this machine" in toast_text(fpage) and fpage.input_value("#arkUrl") == "http://127.0.0.1:8787"
    fpage.fill("#arkUrl", "https://proxy.example.org/"); fpage.dispatch_event("#arkUrl", "change")
    assert fpage.input_value("#arkUrl") == "https://proxy.example.org"
    fpage.fill("#arkUrl", "http://localhost:9000"); fpage.dispatch_event("#arkUrl", "change")
    assert fpage.input_value("#arkUrl") == "http://localhost:9000"
    fpage.fill("#arkToken", "secret-token")
    assert fpage.evaluate("() => localStorage.getItem('orion.ext.token')") is None, "session only by default"
    fpage.check("#arkRemember")
    assert fpage.evaluate("() => localStorage.getItem('orion.ext.token')") == "secret-token"
    fpage.uncheck("#arkRemember")
    assert fpage.evaluate("() => localStorage.getItem('orion.ext.token')") is None
    assert "secret-token" not in fpage.evaluate("() => JSON.stringify(Object.assign({}, localStorage))")


def test_lookup_results_are_exported_with_the_workspace(fpage, arkham, tmp_path):
    fpage.on("dialog", lambda d: d.accept())
    open_query(fpage, NORMAL["txid"]); set_up_proxy(fpage); select_only(fpage, BIG_ADDR)
    fpage.click("#btnArkham"); fpage.wait_for_function("(id) => !!window.__orion.state.graph.nodes.get(id).ext", arg=BIG_ADDR)
    fpage.click("#exportMenu summary")
    with fpage.expect_download() as dl:
        fpage.click("[data-export=csv-nodes]")
    c = tmp_path / "n.csv"; dl.value.save_as(c)
    rows = list(csv.reader(io.StringIO(c.read_text(encoding="utf-8-sig"), newline="")))
    row = next(r for r in rows[1:] if r[0] == BIG_ADDR)
    assert row[rows[0].index("ext_arkham_name")] == "Binance" and row[rows[0].index("ext_arkham_type")] == "cex"


# ---------------------------------------------------------------- the real proxy, the real page
def load_proxy_module():
    spec = importlib.util.spec_from_file_location("arkham_proxy_e2e", ROOT / "tools" / "arkham_proxy.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


class FakeUpstream(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        FakeUpstream.seen.append((self.path, self.headers.get("API-Key")))
        body = json.dumps(ARKHAM_REPLY).encode() if self.headers.get("API-Key") == "REAL-KEY-123" else b"{}"
        self.send_response(200 if self.headers.get("API-Key") == "REAL-KEY-123" else 401)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


def test_the_real_proxy_works_with_the_real_page_and_the_key_never_reaches_the_page(ctx, errors):
    mod = load_proxy_module()
    FakeUpstream.seen = []
    up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream); threading.Thread(target=up.serve_forever, daemon=True).start()
    srv = mod.make_server(0, "REAL-KEY-123", "page-token", "http://127.0.0.1:%d" % up.server_address[1]); threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept())
    try:
        p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
        open_query(p, NORMAL["txid"])
        p.click("summary:has-text('External sources')")
        p.fill("#arkUrl", "http://127.0.0.1:%d" % port); p.dispatch_event("#arkUrl", "change")
        p.fill("#arkToken", "wrong-token"); p.click("#arkTest")
        p.wait_for_function("() => document.getElementById('arkResult').className === 'bad'")
        assert "token" in p.inner_text("#arkResult").lower()
        assert FakeUpstream.seen == [], "a wrong token never reaches Arkham"
        p.fill("#arkToken", "page-token"); p.click("#arkTest")
        p.wait_for_function("() => document.getElementById('arkResult').className === 'ok'")
        assert "API key configured" in p.inner_text("#arkResult")
        select_only(p, BIG_ADDR)
        p.click("#btnArkham")
        p.wait_for_function("(id) => !!window.__orion.state.graph.nodes.get(id).ext", arg=BIG_ADDR)
        assert "Binance" in p.inner_text("#inspBody .extcard")
        assert FakeUpstream.seen == [("/intelligence/address/" + BIG_ADDR[5:], "REAL-KEY-123")]
        # the key lives in the proxy only
        page_state = p.evaluate("() => document.documentElement.outerHTML + JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(window.__orion.state.graph.toData())")
        assert "REAL-KEY-123" not in page_state
    finally:
        p.close(); srv.shutdown(); srv.server_close(); up.shutdown(); up.server_close()
