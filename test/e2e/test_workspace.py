"""End-to-end tests for public/workspace.html (Firefox, headless, API mocked from real chain fixtures)."""
import csv
import io
import json
import xml.etree.ElementTree as ET

import pytest

from conftest import ADDRESS, ADDR_TXS, COINBASE, NORMAL, OPRETURN, OUTSPENDS, SPENDERS, shot
from helpers import (canvas_has_ink, click_node, counts, idle, node_ids, open_query, selected, set_slider, toast_text, xy)

NORMAL_ID = "tx:" + NORMAL["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors, request):
    yield
    assert not errors, "browser reported errors: %s" % errors


def test_page_loads_clean_and_shows_the_empty_state(page):
    assert page.is_visible("#empty")
    assert page.locator("#layoutSeg button").count() == 3
    assert page.inner_text("#counts") == ""
    assert page.is_disabled("#tFrom")           # nothing to slide yet


def test_open_transaction_builds_the_graph_with_amounts_and_times(page, mock):
    open_query(page, NORMAL["txid"])
    c = counts(page)
    # tx + 1 input address + funding stub + 2 output addresses + 2 spender stubs
    assert c["nodes"] == 7 and c["edges"] == 6
    assert c["vnodes"] == 7 and c["vedges"] == 6
    assert canvas_has_ink(page) > 50
    node = page.evaluate("(id) => window.__orion.state.graph.nodes.get(id)", NORMAL_ID)
    assert node["loaded"] and node["confirmed"] and node["time"] == NORMAL["status"]["block_time"]
    assert [p for h, p in mock.requests] == ["/tx/" + NORMAL["txid"], "/tx/" + NORMAL["txid"] + "/outspends"]
    assert "2 requests" in toast_text(page)


def test_coinbase_and_op_return_transactions_do_not_crash(page):
    # the original page threw on both of these
    open_query(page, COINBASE["txid"])
    assert counts(page)["nodes"] > 3
    assert node_ids(page, "coinbase") == ["cb:" + COINBASE["txid"]]
    open_query(page, OPRETURN["txid"])
    data = node_ids(page, "data")
    assert data, "OP_RETURN output should become a data vertex"
    click_node(page, data[0])
    assert selected(page) == [data[0]]
    assert "OP_RETURN" in page.inner_text("#inspBody")
    assert canvas_has_ink(page) > 50


def test_edge_width_follows_amount_and_is_deterministic(page):
    open_query(page, NORMAL["txid"])
    widths = page.evaluate("""() => { const r = window.__orion.renderer.data, g = window.__orion.state.graph;
        return [...r.visible.edges].map(id => [g.edges.get(id).amount, r.style.edgeWidth(g.edges.get(id))]); }""")
    widths.sort()
    assert widths[0][0] < widths[-1][0] and widths[0][1] < widths[-1][1]
    again = page.evaluate("""() => { const r = window.__orion.renderer.data, g = window.__orion.state.graph;
        return [...r.visible.edges].map(id => [g.edges.get(id).amount, r.style.edgeWidth(g.edges.get(id))]); }""")
    assert sorted(again) == widths


def test_double_click_expands_a_transaction(page):
    open_query(page, NORMAL["txid"])
    spender_ids = ["tx:" + t["txid"] for t in SPENDERS]
    assert all(not page.evaluate("(id) => window.__orion.state.graph.nodes.get(id).loaded", i) for i in spender_ids)
    click_node(page, NORMAL_ID, dbl=True)
    idle(page)
    page.wait_for_function("(ids) => ids.every(id => window.__orion.state.graph.nodes.get(id).loaded)", arg=spender_ids)
    assert counts(page)["nodes"] > 7


def test_time_range_slider_filters_vertices_and_edges(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    full = counts(page)
    assert page.is_enabled("#tFrom") and page.is_enabled("#tTo")
    set_slider(page, "#tTo", 10)                         # end of range right after the first transaction
    page.wait_for_timeout(100)
    cut = counts(page)
    assert cut["vedges"] < full["vedges"] and cut["vnodes"] < full["vnodes"]
    assert cut["nodes"] == full["nodes"], "filtering hides, it must not delete"
    assert page.inner_text("#tbTo") != page.inner_text("#tbFrom")
    set_slider(page, "#tFrom", 1000)                     # from may not pass to: the handles never cross
    assert int(page.input_value("#tFrom")) <= int(page.input_value("#tTo"))
    page.click("#tbReset")
    assert counts(page)["vedges"] == full["vedges"]
    assert page.input_value("#tTo") == "1000" and page.input_value("#tFrom") == "0"


def test_replay_grows_the_graph_through_time(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    full = counts(page)["vedges"]
    page.evaluate("() => { window.__orion.state.playMs = 5; }")
    page.click("#tbPlay")
    page.wait_for_function("() => window.__orion.state.filter.timeTo !== null || !window.__orion.state.playTimer")
    page.wait_for_function("() => !window.__orion.state.playTimer", timeout=8000)
    assert counts(page)["vedges"] == full
    assert page.evaluate("() => window.__orion.state.filter.timeTo") is None
    assert "Replay" in page.inner_text("#tbPlay")


def test_timeline_layout_places_transactions_by_time(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    page.click("#layoutSeg [data-layout=timeline]"); idle(page)
    assert page.get_attribute("#layoutSeg [data-layout=timeline]", "aria-checked") == "true"
    rows = page.evaluate("""() => { const s = window.__orion.state, r = window.__orion.renderer;
        return [...s.graph.nodes.values()].filter(n => n.type === 'tx' && n.time != null).map(n => [n.time, r.positionOf(n.id).x]); }""")
    assert len(rows) >= 3
    rows.sort()
    xs = [x for _, x in rows]
    assert xs == sorted(xs) and xs[0] < xs[-1]
    assert page.evaluate("() => !!window.__orion.renderer.data.axis")
    shot(page, "timeline.png")


def test_time_scale_control_compacts_long_gaps(page):
    open_query(page, ADDRESS)                                # a history spread over several months
    open_query(page, COINBASE["txid"]); idle(page)          # ... and one transaction years later
    assert page.is_hidden("#scaleRow")
    page.click("#layoutSeg [data-layout=timeline]"); idle(page)
    assert page.is_visible("#scaleRow")
    xs = lambda: page.evaluate("""() => { const s = window.__orion.state, r = window.__orion.renderer;
        return [...s.graph.nodes.values()].filter(n => n.type === 'tx' && n.time != null).sort((a, b) => a.time - b.time).map(n => r.positionOf(n.id).x); }""")
    compact = xs()
    assert page.evaluate("() => window.__orion.renderer.data.axis.mode") == "compact"
    assert page.evaluate("() => window.__orion.renderer.data.axis.breaks.length") >= 1
    shot(page, "timeline_compact.png")
    page.click("#scaleSeg [data-scale=proportional]"); idle(page)
    assert page.evaluate("() => window.__orion.renderer.data.axis.mode") == "proportional"
    prop = xs()
    # the same ordering either way; proportional squeezes the early transactions together
    assert compact == sorted(compact) and prop == sorted(prop)
    first_gaps = lambda a: sorted(set(round(x) for x in a))[1] - sorted(set(round(x) for x in a))[0]
    assert first_gaps(compact) > first_gaps(prop), "the long gap is squeezed so the busy part gets the room"
    assert counts(page)["vnodes"] == counts(page)["nodes"]
    shot(page, "timeline_proportional.png")
    page.click("#layoutSeg [data-layout=flow]"); idle(page)
    assert page.is_hidden("#scaleRow")


def test_force_layout_and_dragging_pins_a_vertex(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    page.click("#layoutSeg [data-layout=force]"); idle(page)
    before = xy(page, NORMAL_ID)
    page.mouse.move(before["x"], before["y"]); page.mouse.down(); page.mouse.move(before["x"] + 120, before["y"] + 60, steps=6); page.mouse.up()
    after = xy(page, NORMAL_ID)
    assert abs(after["x"] - before["x"] - 120) < 3 and abs(after["y"] - before["y"] - 60) < 3
    assert page.evaluate("(id) => window.__orion.state.pinned.has(id)", NORMAL_ID)
    page.click("#btnRelayout"); idle(page)
    assert page.evaluate("() => window.__orion.state.pinned.size") == 0
    shot(page, "force.png")


def test_dust_filter_hides_small_edges_and_the_vertices_only_they_touch(page):
    open_query(page, COINBASE["txid"])
    before = counts(page)
    page.click("[data-min='1000']")
    page.wait_for_timeout(100)
    after = counts(page)
    zero = page.evaluate("() => [...window.__orion.state.graph.edges.values()].filter(e => e.amount < 1000).length")
    assert zero > 0, "fixture should contain sub-1000-sat edges (OP_RETURN outputs carry 0)"
    assert after["vedges"] == before["vedges"] - zero
    assert after["nodes"] == before["nodes"]
    assert "1,000" in page.inner_text("#minAmountOut")
    page.click("[data-min='0']")
    assert counts(page)["vedges"] == before["vedges"]


def test_hiding_op_return_and_script_types(page):
    open_query(page, OPRETURN["txid"])
    full = counts(page)
    page.uncheck("#showData"); page.wait_for_timeout(100)
    assert counts(page)["vnodes"] < full["vnodes"]
    page.check("#showData")
    chips = page.locator("#scriptTypes input")
    assert chips.count() >= 1
    chips.first.uncheck(); page.wait_for_timeout(100)
    assert counts(page)["vnodes"] < full["vnodes"] or chips.count() == 0


def test_colour_modes_change_the_legend_and_colours(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    kind = page.evaluate("() => window.__orion.renderer.data.style.nodeColor(window.__orion.state.graph.nodes.get([...window.__orion.state.graph.nodes.keys()].find(k => k.startsWith('addr:'))))")
    assert "transaction" in page.inner_text("#legend")
    page.click("#colorSeg [data-color=age]"); page.wait_for_timeout(100)
    assert "older" in page.inner_text("#legend")
    colours = page.evaluate("() => { const r = window.__orion.renderer.data, g = window.__orion.state.graph; return [...new Set([...g.nodes.values()].filter(n => n.type === 'tx').map(n => r.style.nodeColor(n)))]; }")
    assert len(colours) >= 2, "different ages must get different colours"
    shot(page, "age.png")
    page.click("#colorSeg [data-color=script]"); page.wait_for_timeout(100)
    assert "v0_p2wpkh" in page.inner_text("#legend")
    page.click("#colorSeg [data-color=type]")
    assert page.evaluate("() => window.__orion.renderer.data.style.nodeColor(window.__orion.state.graph.nodes.get([...window.__orion.state.graph.nodes.keys()].find(k => k.startsWith('addr:'))))") == kind


def test_labels_and_notes_survive_export_clear_and_import(page, tmp_path):
    open_query(page, NORMAL["txid"])
    addr = [i for i in node_ids(page, "addr")][0]
    click_node(page, addr)
    page.fill("#fLabel", "Suspect wallet #1")
    page.fill("#fNote", "seen paying the broker, twice")
    page.wait_for_timeout(100)
    assert page.evaluate("(id) => window.__orion.state.graph.nodes.get(id).label", addr) == "Suspect wallet #1"

    page.click("#exportMenu summary")
    with page.expect_download() as dl:
        page.click("[data-export=json]")
    path = tmp_path / "ws.json"; dl.value.save_as(path)
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["format"] == "orion-workspace" and doc["version"] == 1
    saved = {n["id"]: n for n in doc["nodes"]}
    assert saved[addr]["label"] == "Suspect wallet #1" and saved[addr]["note"] == "seen paying the broker, twice"
    total = counts(page)

    page.click("#btnClear"); page.click("#btnClear")      # two-step confirmation
    assert counts(page)["nodes"] == 0 and page.is_visible("#empty")

    page.set_input_files("#fileImport", str(path))
    page.wait_for_function("() => window.__orion.state.graph.nodes.size > 0")
    idle(page)
    assert counts(page)["nodes"] == total["nodes"] and counts(page)["edges"] == total["edges"]
    assert page.evaluate("(id) => window.__orion.state.graph.nodes.get(id).note", addr) == "seen paying the broker, twice"
    assert "Imported" in toast_text(page)
    shot(page, "imported.png")


def test_csv_and_graphml_exports(page, tmp_path):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    c = counts(page)

    def export(kind, name):
        page.click("#exportMenu summary")
        with page.expect_download() as dl:
            page.click("[data-export=%s]" % kind)
        p = tmp_path / name; dl.value.save_as(p); return p

    rows = list(csv.reader(io.StringIO(export("csv-edges", "e.csv").read_text(encoding="utf-8-sig"), newline="")))
    assert len(rows) == c["edges"] + 1 and rows[0][0] == "edge_id"
    amounts = {r[0]: int(r[rows[0].index("amount_sat")]) for r in rows[1:]}
    assert amounts["out:%s:0" % NORMAL["txid"]] == NORMAL["vout"][0]["value"]

    rows = list(csv.reader(io.StringIO(export("csv-nodes", "n.csv").read_text(encoding="utf-8-sig"), newline="")))
    assert len(rows) == c["nodes"] + 1

    root = ET.parse(export("graphml", "g.graphml")).getroot()
    ns = "{http://graphml.graphdrawing.org/xmlns}"
    assert len(list(root.iter(ns + "node"))) == c["nodes"] and len(list(root.iter(ns + "edge"))) == c["edges"]

    page.click("[data-min='100000']"); page.wait_for_timeout(100)
    vis = counts(page)
    page.click("#exportMenu summary"); page.check("#exportVisible"); page.click("#exportMenu summary")
    root = ET.parse(export("graphml", "g2.graphml")).getroot()
    assert len(list(root.iter(ns + "edge"))) == vis["vedges"] < c["edges"]


def test_untrusted_text_in_labels_and_imports_is_inert(page, tmp_path):
    evil = '<img src=x onerror="window.__pwned=1">'
    doc = {"format": "orion-workspace", "version": 1,
           "nodes": [{"id": "addr:evil", "type": "addr", "address": "evil", "label": evil, "note": '=HYPERLINK("http://x","y")' + evil},
                     {"id": "tx:" + "a" * 64, "type": "tx", "txid": "a" * 64, "loaded": False}],
           "edges": [{"id": "in:" + "a" * 64 + ":0", "source": "addr:evil", "target": "tx:" + "a" * 64, "kind": "in", "amount": 5, "txid": "a" * 64}]}
    f = tmp_path / "evil.json"; f.write_text(json.dumps(doc), encoding="utf-8")
    page.set_input_files("#fileImport", str(f))
    page.wait_for_function("() => window.__orion.state.graph.nodes.size === 2"); idle(page)
    click_node(page, "addr:evil")
    assert page.input_value("#fLabel") == evil
    assert page.locator("#inspBody img").count() == 0, "label must be text, never markup"
    page.hover("body", position={"x": 5, "y": 5})
    p = xy(page, "addr:evil"); page.mouse.move(p["x"], p["y"]); page.wait_for_timeout(100)
    assert page.locator("#tooltip img").count() == 0
    assert page.evaluate("() => window.__pwned") is None
    page.click("#exportMenu summary")
    with page.expect_download() as dl:
        page.click("[data-export=csv-nodes]")
    p = tmp_path / "n.csv"; dl.value.save_as(p)
    rows = list(csv.reader(io.StringIO(p.read_text(encoding="utf-8-sig"), newline="")))
    note = rows[1][rows[0].index("note")]
    assert note.startswith("'="), "spreadsheet formulas must be defused: %r" % note


def test_tor_source_uses_the_onion_service_with_gentler_limits(page, mock):
    page.select_option("#source", "tor")
    assert "Tor Browser" in page.inner_text("#sourceHint")
    page.click("#testSource")
    page.wait_for_function("() => document.getElementById('testResult').className === 'ok'")
    assert "971,587" in page.inner_text("#testResult")
    open_query(page, NORMAL["txid"])
    hosts = {h for h, _ in mock.requests}
    assert hosts and all(h.endswith(".onion") for h in hosts), hosts
    assert page.evaluate("() => window.__orion.state.client.concurrency") == 2
    assert page.evaluate("() => window.__orion.state.client.timeoutMs") == 60000
    page.reload(); page.wait_for_function("window.__orion && window.__orion.renderer")
    assert page.input_value("#source") == "tor", "the choice is remembered"
    page.select_option("#source", "clearnet")


def open_limits(page):
    page.click("summary:has-text('Expansion limits')")


def test_request_cap_stops_an_action_and_says_so(page):
    open_limits(page)
    page.fill("#capReq", "1"); page.dispatch_event("#capReq", "change")
    open_query(page, NORMAL["txid"])
    msg = toast_text(page)
    assert "request limit" in msg, msg
    assert counts(page)["nodes"] > 0, "what was loaded is kept"


def test_per_expand_cap_reports_truncation(page):
    open_query(page, NORMAL["txid"])
    open_limits(page)
    page.fill("#capTx", "1"); page.dispatch_event("#capTx", "change")
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    assert "per-expand limit" in toast_text(page)
    loaded = page.evaluate("(ids) => ids.filter(id => window.__orion.state.graph.nodes.get(id).loaded).length", ["tx:" + t["txid"] for t in SPENDERS])
    assert loaded == 1


def test_unknown_transaction_is_reported_and_leaves_the_graph_empty(page):
    open_query(page, "f" * 64)
    assert "failed" in toast_text(page) or "not found" in toast_text(page).lower()
    assert counts(page)["nodes"] == 0
    page.fill("#q", "not a valid thing!"); page.press("#q", "Enter")
    assert "does not look like" in toast_text(page)


def test_server_errors_are_retried_then_reported(page, mock):
    mock.fail["/tx/" + NORMAL["txid"]] = 503
    page.evaluate("() => { window.__orion.state.client.backoffMs = 5; }")
    open_query(page, NORMAL["txid"])
    assert counts(page)["nodes"] == 0
    assert sum(1 for _, p in mock.requests if p == "/tx/" + NORMAL["txid"]) == 4      # first try + 3 retries
    assert "503" in toast_text(page)


def test_address_history_loads_and_continues(page):
    open_query(page, ADDRESS)
    assert len(node_ids(page, "tx")) >= len(ADDR_TXS)
    node = page.evaluate("(id) => window.__orion.state.graph.nodes.get(id)", "addr:" + ADDRESS)
    assert node["txCount"] == ADDR_STATS_COUNT()
    click_node(page, "addr:" + ADDRESS)
    assert ADDRESS in page.inner_text("#inspBody")


def ADDR_STATS_COUNT():
    from conftest import ADDR_STATS
    return ADDR_STATS["chain_stats"]["tx_count"] + ADDR_STATS["mempool_stats"]["tx_count"]


def test_known_address_is_labelled_in_the_tooltip(page):
    open_query(page, NORMAL["txid"])
    known = page.evaluate("() => [...window.__orion.state.graph.nodes.values()].filter(n => n.type === 'addr' && window.ORION_KNOWN[n.address]).map(n => n.id)")
    assert known, "the fixture pays a labelled exchange address"
    p = xy(page, known[0]); page.mouse.move(p["x"], p["y"]); page.wait_for_timeout(100)
    assert page.is_visible("#tooltip") and "Known" in page.inner_text("#tooltip")


def test_delete_key_removes_the_selection(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID)
    page.keyboard.press("Delete")
    assert counts(page)["nodes"] == 0
    assert page.is_hidden("#inspector")


def test_session_is_saved_and_can_be_restored(ctx, errors):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    from conftest import PAGE_URL
    p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
    open_query(p, NORMAL["txid"])
    click_node(p, "addr:" + NORMAL["vout"][0]["scriptpubkey_address"])
    p.fill("#fLabel", "kept across reload"); p.wait_for_timeout(1200)       # autosave is debounced
    n = counts(p)["nodes"]
    p.reload(); p.wait_for_function("window.__orion && window.__orion.renderer")
    assert p.is_visible("#restore") and counts(p)["nodes"] == 0
    p.click("#restoreYes"); p.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); idle(p)
    assert counts(p)["nodes"] == n
    assert p.evaluate("(id) => window.__orion.state.graph.nodes.get(id).label", "addr:" + NORMAL["vout"][0]["scriptpubkey_address"]) == "kept across reload"
    p.reload(); p.wait_for_function("window.__orion && window.__orion.renderer")
    assert p.is_visible("#restore"), "the URL names a vertex now, but the saved session still wins until you decide"
    p.wait_for_timeout(1200)
    assert counts(p)["nodes"] == 0 and "kept across reload" in p.evaluate("() => localStorage.getItem('orion.workspace.v1')"), "nothing overwrote it meanwhile"
    p.click("#restoreNo")
    p.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); idle(p)          # the vertex from the URL is opened instead
    assert p.evaluate("(id) => window.__orion.state.graph.nodes.get(id).label", "addr:" + NORMAL["vout"][0]["scriptpubkey_address"]) is None, "discarded labels are gone"
    p.wait_for_timeout(1200)
    assert "kept across reload" not in (p.evaluate("() => localStorage.getItem('orion.workspace.v1')") or "")
    p.close()


def test_url_parameter_opens_a_transaction(ctx, errors):
    from conftest import PAGE_URL
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL + "?q=" + NORMAL["txid"])
    p.wait_for_function("() => window.__orion && window.__orion.state.graph.nodes.size > 0"); idle(p)
    assert counts(p)["nodes"] == 7
    p.close()


def test_narrow_screen_has_no_horizontal_scroll(browser, mock, errors):
    c = browser.new_context(viewport={"width": 420, "height": 800})
    import re
    c.route(re.compile(r"^https?://[^/]+/api/"), mock.handle)
    p = c.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    from conftest import PAGE_URL
    p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
    assert p.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
    p.click("#btnSide"); assert p.evaluate("() => document.body.classList.contains('side-open')")
    shot(p, "narrow.png")
    c.close()


def test_rich_graph_screenshots(page):
    """Not an assertion test: renders a richer graph in each layout so the pictures can be reviewed."""
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)
    open_query(page, COINBASE["txid"]); open_query(page, OPRETURN["txid"]); open_query(page, ADDRESS)
    page.click("#inspClose") if page.is_visible("#inspClose") else None
    for name in ("flow", "timeline", "force"):
        page.click("#layoutSeg [data-layout=%s]" % name); idle(page); page.wait_for_timeout(150)
        shot(page, "rich_%s.png" % name)
    assert canvas_has_ink(page) > 100


def test_session_saving_can_be_switched_off(page):
    page.click("summary:has-text('Privacy')")
    open_query(page, NORMAL["txid"])
    page.wait_for_timeout(1100)
    assert page.evaluate("() => localStorage.getItem('orion.workspace.v1') !== null")
    page.uncheck("#persist")
    assert page.evaluate("() => localStorage.getItem('orion.workspace.v1')") is None
    click_node(page, NORMAL_ID); page.fill("#fLabel", "not saved"); page.wait_for_timeout(1100)
    assert page.evaluate("() => localStorage.getItem('orion.workspace.v1')") is None, "nothing is written while it is off"
    page.reload(); page.wait_for_function("window.__orion && window.__orion.renderer")
    assert page.is_hidden("#restore")
    page.click("summary:has-text('Privacy')")
    assert not page.is_checked("#persist"), "the choice is remembered"


def test_background_loading_does_not_steal_focus_from_the_label_box(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID)
    page.click("#fLabel"); page.keyboard.type("half a thought")
    # a background action finishing re-renders the app through this same path
    page.evaluate("() => window.__orion.afterGraphChange()")
    assert page.evaluate("() => document.activeElement.id") == "fLabel", "typing position is kept"
    page.keyboard.type(" ...and the rest")
    assert page.input_value("#fLabel") == "half a thought ...and the rest"
    page.evaluate("() => document.activeElement.blur()")
    page.evaluate("() => window.__orion.afterGraphChange()")
    assert page.input_value("#fLabel") == "half a thought ...and the rest", "and a re-render shows the stored label"



def test_unsafe_custom_url_never_becomes_a_link(page):
    page.select_option("#source", "custom")
    page.fill("#customBase", "javascript:alert(1)"); page.dispatch_event("#customBase", "change")
    page.select_option("#source", "clearnet")
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID)
    hrefs = page.evaluate("() => [...document.querySelectorAll('#inspBody a')].map(a => a.href)")
    assert hrefs and all(h.startswith("https://mempool.space/") for h in hrefs), hrefs
    page.select_option("#source", "custom")
    click_node(page, NORMAL_ID)
    hrefs = page.evaluate("() => [...document.querySelectorAll('#inspBody a')].map(a => a.href)")
    assert all(h.startswith("https://") for h in hrefs), hrefs
    page.select_option("#source", "clearnet")


def test_mixed_case_bech32_address_is_accepted(page, mock):
    typed = ADDRESS[0].upper() + ADDRESS[1:]                    # what autocorrect does: "Bc1q..."
    assert typed != ADDRESS
    open_query(page, typed)
    assert counts(page)["nodes"] > 0, toast_text(page)
    assert page.input_value("#q") == ADDRESS, "the box shows what was actually looked up"
    assert all(p == p.lower() for _, p in mock.requests if p.startswith("/address/")), mock.requests
    assert "failed" not in toast_text(page)


def test_a_mistyped_address_is_caught_locally_before_any_request(page, mock):
    typo = ADDRESS[:-1] + ("p" if ADDRESS[-1] != "p" else "q")
    open_query(page, typo)
    msg = toast_text(page)
    assert "checksum does not match" in msg, msg
    assert not [r for r in mock.requests if r[1].startswith("/address/")], "nothing was sent"
    assert counts(page)["nodes"] == 0


def test_an_address_the_server_rejects_gives_one_clear_message(page, mock):
    valid = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"        # passes the local check; the (mock) server says no
    mock.fail["/address/" + valid] = 400
    open_query(page, valid)
    msg = toast_text(page)
    assert "not a valid Bitcoin address" in msg, msg
    assert sum(1 for _, p in mock.requests if p.startswith("/address/")) == 1
    assert counts(page)["nodes"] == 0
