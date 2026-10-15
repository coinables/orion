"""Focus view and Back/Forward navigation: start from one transaction or address and walk along the chain."""
import pytest

from conftest import ADDRESS, ADDR_TXS, NORMAL, PAGE_URL, SPENDERS, shot
from helpers import click_node, counts, idle, open_query, toast_text, xy

NORMAL_ID = "tx:" + NORMAL["txid"]
SP0, SP1 = "tx:" + SPENDERS[0]["txid"], "tx:" + SPENDERS[1]["txid"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def focus(page):
    return page.evaluate("() => window.__orion.state.focus")


def trail(page):
    return page.evaluate("() => ({ entries: [...window.__orion.state.nav.entries], index: window.__orion.state.nav.index })")


def crumbs(page):
    return page.locator("#trail .crumb").all_inner_texts()


def visible_ids(page):
    return set(page.evaluate("() => [...window.__orion.renderer.data.visible.nodes]"))


def test_a_new_visitor_gets_focus_on_and_sees_the_trail_start(fpage):
    assert fpage.is_checked("#focusOn") and fpage.input_value("#depth") == "2"
    assert fpage.is_disabled("#navBack") and fpage.is_disabled("#navFwd") and fpage.is_hidden("#trail")
    open_query(fpage, NORMAL["txid"])
    assert focus(fpage) == NORMAL_ID
    assert trail(fpage) == {"entries": [NORMAL_ID], "index": 0}
    assert fpage.is_visible("#trail") and len(crumbs(fpage)) == 1
    assert "Focus:" in fpage.inner_text("#counts") and "depth 2" in fpage.inner_text("#counts")
    assert fpage.is_disabled("#navBack"), "nothing to go back to yet"
    assert NORMAL_ID in fpage.evaluate("() => location.hash")


def test_moving_to_a_neighbour_narrows_the_view_to_its_surroundings(fpage):
    open_query(fpage, NORMAL["txid"])
    start = counts(fpage)
    assert start["vnodes"] == start["nodes"] == 7, "at depth 2 the chain neighbours are in view"
    click_node(fpage, SP0, dbl=True); idle(fpage)
    assert focus(fpage) == SP0 and fpage.evaluate("(id) => window.__orion.state.graph.nodes.get(id).loaded", SP0)
    c = counts(fpage)
    assert c["vnodes"] < c["nodes"], "the graph grew, but only the neighbourhood of the new focus is shown"
    ids = visible_ids(fpage)
    assert SP0 in ids and NORMAL_ID in ids, "the transaction we came from is two steps away"
    assert "addr:" + NORMAL["vin"][0]["prevout"]["scriptpubkey_address"] not in ids, "its funder is three steps away"
    shot(fpage, "focus_neighbour.png")


def test_depth_control_changes_how_much_is_shown(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.select_option("#depth", "1"); idle(fpage)
    assert counts(fpage)["vnodes"] == 4, "the transaction and its three addresses"
    assert "depth 1" in fpage.inner_text("#counts")
    fpage.select_option("#depth", "3"); idle(fpage)
    assert counts(fpage)["vnodes"] == counts(fpage)["nodes"]
    assert fpage.evaluate("() => JSON.parse(localStorage.getItem('orion.prefs.v1')).hops") == 3, "remembered"


def test_back_and_forward_buttons_walk_the_trail(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)
    click_node(fpage, NORMAL_ID, dbl=True); idle(fpage)           # A -> B -> A is three stops, not two
    assert trail(fpage) == {"entries": [NORMAL_ID, SP0, NORMAL_ID], "index": 2}
    assert fpage.is_enabled("#navBack") and fpage.is_disabled("#navFwd")

    fpage.click("#navBack"); fpage.wait_for_function("() => window.__orion.state.nav.index === 1"); idle(fpage)
    assert focus(fpage) == SP0 and fpage.is_enabled("#navFwd")
    assert fpage.evaluate("() => location.hash").startswith("#f1/")
    fpage.click("#navBack"); fpage.wait_for_function("() => window.__orion.state.nav.index === 0"); idle(fpage)
    assert focus(fpage) == NORMAL_ID and fpage.is_disabled("#navBack")
    fpage.click("#navFwd"); fpage.wait_for_function("() => window.__orion.state.nav.index === 1"); idle(fpage)
    assert focus(fpage) == SP0
    assert fpage.locator("#trail .crumb.current").count() == 1
    assert "ahead" in fpage.locator("#trail .crumb").nth(2).get_attribute("class")


def test_the_browsers_own_back_and_forward_work_too(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)
    fpage.go_back(); fpage.wait_for_function("() => window.__orion.state.focus === '%s'" % NORMAL_ID); idle(fpage)
    assert trail(fpage)["index"] == 0
    fpage.go_forward(); fpage.wait_for_function("() => window.__orion.state.focus === '%s'" % SP0); idle(fpage)
    assert trail(fpage)["index"] == 1


def test_a_new_visit_after_going_back_drops_the_forward_trail(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)
    fpage.click("#navBack"); fpage.wait_for_function("() => window.__orion.state.nav.index === 0"); idle(fpage)
    click_node(fpage, SP1, dbl=True); idle(fpage)
    assert trail(fpage) == {"entries": [NORMAL_ID, SP1], "index": 1}
    assert fpage.is_disabled("#navFwd")


def test_clicking_a_crumb_jumps_there(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)
    click_node(fpage, NORMAL_ID, dbl=True); idle(fpage)
    fpage.locator("#trail .crumb").first.click()
    fpage.wait_for_function("() => window.__orion.state.nav.index === 0"); idle(fpage)
    assert focus(fpage) == NORMAL_ID and len(crumbs(fpage)) == 3


def test_details_panel_lists_neighbouring_transactions_and_clicking_one_moves_there(fpage):
    open_query(fpage, NORMAL["txid"])
    body = fpage.inner_text("#inspBody").lower()                # headings are styled upper-case
    assert "spent by (2)" in body and "funded by (1)" in body
    rows = fpage.locator("#inspBody .linkrow")
    assert rows.count() == 3
    fpage.locator("#inspBody .linkrow[title='%s']" % SP0).click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=SP0); idle(fpage)
    assert fpage.evaluate("(id) => window.__orion.state.graph.nodes.get(id).loaded", SP0)
    assert "funded by" in fpage.inner_text("#inspBody").lower(), "and the way back is listed"
    assert trail(fpage)["entries"] == [NORMAL_ID, SP0]
    fpage.locator("#inspBody .linkrow[title='%s']" % NORMAL_ID).click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=NORMAL_ID); idle(fpage)
    assert trail(fpage)["entries"] == [NORMAL_ID, SP0, NORMAL_ID]


def test_an_address_focus_lists_its_transactions(fpage):
    open_query(fpage, ADDRESS)
    assert focus(fpage) == "addr:" + ADDRESS
    assert ("transactions (%d)" % len(ADDR_TXS)) in fpage.inner_text("#inspBody").lower()
    fpage.select_option("#depth", "1"); idle(fpage)
    c = counts(fpage)
    assert c["vnodes"] == 1 + len(ADDR_TXS) and c["vnodes"] < c["nodes"], "the address and its transactions only"
    first = fpage.locator("#inspBody .linkrow").first
    title = first.get_attribute("title")
    first.click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=title); idle(fpage)
    assert focus(fpage) == title and trail(fpage)["index"] == 1


def test_focus_can_be_switched_off_and_on_without_losing_the_place(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)
    narrow = counts(fpage)["vnodes"]
    fpage.uncheck("#focusOn"); idle(fpage)
    assert counts(fpage)["vnodes"] == counts(fpage)["nodes"] > narrow
    assert focus(fpage) == SP0, "the place is remembered"
    fpage.check("#focusOn"); idle(fpage)
    assert counts(fpage)["vnodes"] == narrow
    assert fpage.evaluate("() => JSON.parse(localStorage.getItem('orion.prefs.v1')).focusOn") is True


def test_whole_graph_view_still_steps_through_the_trail(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)           # focus on: double-click navigates
    fpage.uncheck("#focusOn"); idle(fpage)
    fpage.click("#navBack"); fpage.wait_for_function("() => window.__orion.state.nav.index === 0"); idle(fpage)
    assert focus(fpage) == NORMAL_ID
    assert fpage.evaluate("() => [...window.__orion.state.selected]") == [NORMAL_ID], "the vertex is selected and brought to the middle"
    p = xy(fpage, NORMAL_ID)
    box = fpage.locator("#cv").bounding_box()
    inset = fpage.evaluate("() => window.__orion.renderer.insets.bottom")
    assert inset > 0, "the step bar is showing, so the middle of the free area is a little higher"
    assert abs(p["x"] - (box["x"] + box["width"] / 2)) < 3 and abs(p["y"] - (box["y"] + (box["height"] - inset) / 2)) < 3
    assert counts(fpage)["vnodes"] == counts(fpage)["nodes"]


def test_time_range_follows_the_focus(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.select_option("#depth", "1"); idle(fpage)
    assert fpage.is_disabled("#tFrom"), "one transaction in view: nothing to slide"
    assert "nothing to slide" in fpage.inner_text("#tbInfo")
    fpage.select_option("#depth", "2"); idle(fpage)
    assert fpage.is_enabled("#tFrom"), "the neighbouring transactions bring a time span"
    fpage.evaluate("() => { const el = document.getElementById('tTo'); el.value = 10; el.dispatchEvent(new Event('input', { bubbles: true })); }")
    assert fpage.evaluate("() => window.__orion.state.filter.timeTo") is not None
    fpage.locator("#inspBody .linkrow[title='%s']" % SP0).click(); idle(fpage)      # the window may hide that vertex on the canvas, the list still reaches it
    assert focus(fpage) == SP0
    assert fpage.evaluate("() => window.__orion.state.filter.timeTo") is None, "moving resets a window chosen for the old neighbourhood"
    assert counts(fpage)["vnodes"] > 0


def test_a_failed_move_leaves_you_where_you_were(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    mock.fail["/tx/" + SPENDERS[1]["txid"]] = 500
    fpage.evaluate("() => { window.__orion.state.client.backoffMs = 5; }")
    click_node(fpage, SP1, dbl=True); idle(fpage)
    assert "failed" in toast_text(fpage)
    assert focus(fpage) == NORMAL_ID
    assert trail(fpage) == {"entries": [NORMAL_ID], "index": 0}


def test_reload_offers_the_saved_session_and_keeps_the_focus(ctx, errors):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL); p.wait_for_function("window.__orion && window.__orion.renderer")
    open_query(p, NORMAL["txid"])
    click_node(p, SP0, dbl=True); idle(p)
    p.wait_for_timeout(1200)
    p.reload(); p.wait_for_function("window.__orion && window.__orion.renderer")
    assert p.is_visible("#restore"), "the hash in the URL does not bypass the saved session"
    p.click("#restoreYes"); p.wait_for_function("() => window.__orion.state.graph.nodes.size > 0"); idle(p)
    assert focus(p) == SP0
    assert trail(p)["entries"] == [SP0]
    p.close()


def test_a_shared_link_opens_that_vertex_and_hostile_links_do_nothing(ctx, errors):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL + "#f0/" + NORMAL_ID); p.wait_for_function("window.__orion && window.__orion.state.graph.nodes.size > 0"); idle(p)
    assert focus(p) == NORMAL_ID and trail(p)["entries"] == [NORMAL_ID]
    q = ctx.new_page(); q.on("pageerror", lambda e: errors.append(str(e)))
    for bad in ("#f0/javascript:alert(1)", "#f0/tx:<img src=x onerror=window.__pwned=1>", "#f5/tx:" + "z" * 300, "#nonsense"):
        q.goto(PAGE_URL + bad); q.wait_for_function("window.__orion && window.__orion.renderer"); q.wait_for_timeout(150)
        assert counts(q)["nodes"] == 0, bad
        assert q.evaluate("() => window.__pwned") is None
    p.close(); q.close()


def test_clear_resets_the_trail(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, SP0, dbl=True); idle(fpage)
    fpage.click("#btnClear"); fpage.click("#btnClear")
    assert counts(fpage)["nodes"] == 0 and trail(fpage)["entries"] == [] and fpage.is_hidden("#trail")
    assert fpage.is_disabled("#navBack") and fpage.is_disabled("#navFwd")
    assert focus(fpage) is None
    assert "#f" not in fpage.evaluate("() => location.hash")


def test_removing_the_focused_vertex_clears_the_focus(fpage):
    open_query(fpage, NORMAL["txid"])
    click_node(fpage, NORMAL_ID)
    fpage.keyboard.press("Delete")
    assert focus(fpage) is None and counts(fpage)["nodes"] == 0


def test_inspector_buttons_are_enabled_when_they_should_be(fpage, mock):
    """Regression: a null `disabled` used to be written as disabled="null", greying out buttons that were meant to work."""
    open_query(fpage, ADDRESS)
    txs = [i for i in fpage.evaluate("() => [...window.__orion.state.graph.nodes.keys()].filter(k => k.startsWith('tx:'))")]
    # an address that is not the focus: its Focus and history buttons must be live
    other = [i for i in fpage.evaluate("() => [...window.__orion.state.graph.nodes.keys()].filter(k => k.startsWith('addr:'))") if i != "addr:" + ADDRESS][0]
    fpage.evaluate("(id) => { const s = window.__orion.state; s.selected = new Set([id]); window.__orion.renderer.setSelection([id]); }", other)
    fpage.evaluate("() => window.__orion.afterGraphChange()")
    assert fpage.is_enabled("#inspBody button:has-text('Focus here')")
    assert fpage.is_enabled("#inspBody button:has-text('Load history')")
    addr = other[len("addr:"):]
    mock.routes["/address/" + addr] = {"address": addr, "chain_stats": {"tx_count": 0}, "mempool_stats": {"tx_count": 0}}
    mock.routes["/address/" + addr + "/txs"] = []
    fpage.click("#inspBody button:has-text('Focus here')")
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=other); idle(fpage)
    assert focus(fpage) == other
    assert fpage.locator("#trail .crumb.current[aria-current=true]").count() == 1
    assert fpage.locator("#trail .crumb:not(.current)").first.get_attribute("aria-current") is None, "no stray attribute"
    assert txs
