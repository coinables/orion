"""Collapsible panels, the Bitcoin / both / fiat display, and the on-screen Previous / Next buttons."""
import pytest

from conftest import COINBASE, NORMAL, OUTSPENDS, PAGE_URL, SPENDERS, shot
from helpers import click_node, counts, idle, open_query, toast_text

NORMAL_ID = "tx:" + NORMAL["txid"]
BIG = max(range(len(NORMAL["vout"])), key=lambda i: NORMAL["vout"][i]["value"])          # the larger output and who spent it
SMALL = 1 - BIG
BIG_ADDR = "addr:" + NORMAL["vout"][BIG]["scriptpubkey_address"]
SMALL_ADDR = "addr:" + NORMAL["vout"][SMALL]["scriptpubkey_address"]
BIG_SPENDER = "tx:" + OUTSPENDS[BIG]["txid"]
INPUT_ADDR = "addr:" + NORMAL["vin"][0]["prevout"]["scriptpubkey_address"]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def focus(page):
    return page.evaluate("() => window.__orion.state.focus")


def canvas_width(page):
    return page.locator("#cv").bounding_box()["width"]


def all_nodes_inside_canvas(page):
    return page.evaluate("""() => { const r = window.__orion.renderer, b = r.canvas.getBoundingClientRect(), bar = document.getElementById('stepbar');
        const barTop = bar.hidden ? Infinity : bar.getBoundingClientRect().top;
        return [...r.data.visible.nodes].every(id => { const p = r.positionOf(id), x = b.left + p.x * r.view.k + r.view.x, y = b.top + p.y * r.view.k + r.view.y;
          return x > b.left && x < b.right && y > b.top && y < Math.min(b.bottom, barTop); }); }""")


# ---------------------------------------------------------------- collapsible panels
def test_the_controls_panel_collapses_and_comes_back(fpage):
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_visible("#side") and fpage.is_hidden("#sideTab")
    before = canvas_width(fpage)
    fpage.click("#sideCollapse")
    fpage.wait_for_function("() => document.body.classList.contains('side-collapsed')")
    assert fpage.is_hidden("#side") and fpage.is_visible("#sideTab")
    assert fpage.get_attribute("#sideCollapse", "aria-expanded") == "false"
    fpage.wait_for_function("(w) => document.getElementById('cv').getBoundingClientRect().width > w + 200", arg=before)
    idle(fpage)
    assert all_nodes_inside_canvas(fpage), "the graph was refitted to the larger canvas"
    fpage.click("#sideTab")
    assert fpage.is_visible("#side") and fpage.is_hidden("#sideTab")
    fpage.wait_for_function("(w) => Math.abs(document.getElementById('cv').getBoundingClientRect().width - w) < 2", arg=before)
    assert all_nodes_inside_canvas(fpage)


def test_the_details_panel_collapses_to_a_tab_that_names_the_selection(fpage):
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_visible("#inspector") and fpage.is_hidden("#inspTab")
    fpage.click("#inspCollapse")
    assert fpage.is_hidden("#inspector") and fpage.is_visible("#inspTab")
    assert "0f58c" in fpage.inner_text("#inspTab")
    # a new selection keeps it collapsed and updates the tab: the user asked for room
    click_node(fpage, "tx:" + SPENDERS[0]["txid"])
    assert fpage.is_hidden("#inspector") and "d3e65" in fpage.inner_text("#inspTab")
    fpage.click("#inspTab")
    assert fpage.is_visible("#inspector") and fpage.is_hidden("#inspTab")
    assert "d3e65" in fpage.inner_text("#inspBody")
    # nothing selected: no tab at all
    fpage.click("#inspCollapse"); fpage.click("#inspClose") if fpage.is_visible("#inspClose") else fpage.keyboard.press("Escape")
    fpage.keyboard.press("Escape")
    assert fpage.is_hidden("#inspTab")


def test_keyboard_toggles_and_the_choice_is_remembered(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.locator("#cv").focus()
    fpage.keyboard.press("c")
    assert fpage.evaluate("() => document.body.classList.contains('side-collapsed')")
    fpage.keyboard.press("d")
    assert fpage.evaluate("() => document.body.classList.contains('insp-collapsed')")
    prefs = fpage.evaluate("() => JSON.parse(localStorage.getItem('orion.prefs.v1'))")
    assert prefs["sideCollapsed"] is True and prefs["inspCollapsed"] is True
    fpage.reload(); fpage.wait_for_function("window.__orion && window.__orion.renderer")
    assert fpage.evaluate("() => document.body.classList.contains('side-collapsed') && document.body.classList.contains('insp-collapsed')")
    assert fpage.is_visible("#sideTab")
    fpage.keyboard.press("c"); fpage.keyboard.press("d")
    assert fpage.is_visible("#side")


def test_typing_in_a_box_does_not_trigger_the_shortcuts(fpage):
    fpage.click("#q"); fpage.keyboard.type("cd[]")
    assert fpage.input_value("#q") == "cd[]"
    assert not fpage.evaluate("() => document.body.classList.contains('side-collapsed')")


def test_a_user_who_zoomed_is_not_refitted_when_a_panel_moves(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.evaluate("() => window.__orion.renderer.zoomBy(1.5)")
    assert fpage.evaluate("() => window.__orion.renderer.autoFit") is False
    k = fpage.evaluate("() => window.__orion.renderer.view.k")
    fpage.click("#sideCollapse"); fpage.wait_for_timeout(300)
    assert fpage.evaluate("() => window.__orion.renderer.view.k") == k


# ---------------------------------------------------------------- Bitcoin / both / fiat
def use_usd(page):
    page.select_option("#fiatCur", "USD")
    page.wait_for_function("() => /history to/.test(document.getElementById('fiatStatus').textContent)")
    idle(page)


def value_out_dd(page):
    return page.locator("#inspBody dd").filter(has_text="0.0211").first


def test_display_choice_is_off_until_a_currency_is_chosen(page):
    assert page.is_disabled("#showSeg button[data-show=fiat]")
    assert page.is_hidden("#btnAmounts")
    open_query(page, NORMAL["txid"])
    use_usd(page)
    assert page.is_enabled("#showSeg button[data-show=fiat]") and page.is_visible("#btnAmounts")
    assert page.get_attribute("#showSeg button[data-show=both]", "aria-checked") == "true"
    assert "USD" in page.inner_text("#btnAmounts")


def test_both_bitcoin_only_and_fiat_only_in_the_details(page):
    open_query(page, NORMAL["txid"])
    use_usd(page)
    dd = value_out_dd(page)
    assert "BTC" in dd.inner_text() and "$" in dd.inner_text(), "both"
    page.click("#showSeg button[data-show=btc]")
    dd = value_out_dd(page)
    assert "BTC" in dd.inner_text() and "$" not in dd.inner_text() and dd.locator(".fiat").count() == 0
    page.click("#showSeg button[data-show=fiat]")
    dd = page.locator("#inspBody dd .fiat.primary").first.locator("xpath=..")
    assert "BTC" not in dd.inner_text() and "$" in dd.inner_text()
    assert "0.02115000 BTC" in page.locator("#inspBody dd .fiat.primary").first.get_attribute("title"), "the Bitcoin amount stays one hover away"


def test_the_header_button_cycles_through_the_three_displays(page):
    open_query(page, NORMAL["txid"])
    use_usd(page)
    seen = []
    for _ in range(3):
        page.click("#btnAmounts")
        seen.append(page.evaluate("() => window.__orion.state.fiat.show"))
    assert seen == ["fiat", "btc", "both"]
    assert page.get_attribute("#showSeg button[data-show=both]", "aria-checked") == "true"


def test_lists_and_edge_labels_follow_the_display(fpage):
    open_query(fpage, NORMAL["txid"])
    use_usd(fpage)
    row = fpage.locator("#inspBody .linkrow .amt").first
    assert "BTC" in row.inner_text() and "$" in row.inner_text()
    edge = fpage.evaluate("() => { const g = window.__orion.state.graph; return [...g.edges.values()].find(e => e.kind === 'out' && e.amount > 1e6).id; }")
    label = lambda: fpage.evaluate("(id) => window.__orion.renderer.data.edgeLabel(window.__orion.state.graph.edges.get(id))", edge)
    assert " BTC" in label() and "·" in label() and "$" in label()
    fpage.click("#showSeg button[data-show=btc]")
    assert label().endswith(" BTC") and "$" not in label()
    assert "$" not in fpage.locator("#inspBody .linkrow .amt").first.inner_text()
    fpage.click("#showSeg button[data-show=fiat]")
    assert label().startswith(("≈ $", "$")) and "BTC" not in label()
    assert "BTC" not in fpage.locator("#inspBody .linkrow .amt").first.inner_text()


def test_amounts_are_really_drawn_on_the_edges_and_can_be_switched_off(fpage):
    open_query(fpage, NORMAL["txid"])
    spy = """() => { const r = window.__orion.renderer, ctx = r.ctx, orig = ctx.fillText.bind(ctx), seen = [];
        ctx.fillText = (t, ...a) => { seen.push(String(t)); return orig(t, ...a); }; r.draw(); ctx.fillText = orig; return seen; }"""
    texts = fpage.evaluate(spy)
    assert any(t.endswith(" BTC") or t.endswith(" sat") for t in texts), texts
    fpage.uncheck("#edgeLabels")
    texts = fpage.evaluate(spy)
    assert not any(t.endswith(" BTC") or t.endswith(" sat") for t in texts), texts
    assert fpage.evaluate("() => JSON.parse(localStorage.getItem('orion.prefs.v1')).edgeLabels") is False
    shot(fpage, "edge_labels_off.png")


def test_the_display_choice_is_remembered(page):
    open_query(page, NORMAL["txid"])
    use_usd(page)
    page.click("#showSeg button[data-show=fiat]")
    page.reload(); page.wait_for_function("window.__orion && window.__orion.renderer")
    page.wait_for_function("() => /history to|today/.test(document.getElementById('fiatStatus').textContent)")
    assert page.get_attribute("#showSeg button[data-show=fiat]", "aria-checked") == "true"
    assert "USD only" in page.inner_text("#btnAmounts")


# ---------------------------------------------------------------- Previous / Next
def bar_text(page):
    return page.inner_text("#stepbar")


def test_the_step_bar_appears_with_the_first_vertex_and_counts_the_ways(fpage):
    assert fpage.is_hidden("#stepbar")
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_visible("#stepbar")
    assert fpage.inner_text("#stepPrevN") == "1" and fpage.inner_text("#stepNextN") == "2"
    assert fpage.text_content("#stepKind") == "Transaction" and "0f58c" in fpage.inner_text("#stepName")
    assert "0.02115" in fpage.inner_text("#stepAmt") and "2022-04-05" in fpage.inner_text("#stepAmt")
    assert all_nodes_inside_canvas(fpage), "no vertex hides under the step bar"
    shot(fpage, "stepbar.png")


def test_next_with_several_choices_opens_a_list_and_choosing_moves_there(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#stepNext")
    assert fpage.is_visible("#stepMenu")
    rows = fpage.locator("#stepMenu button.steprow")
    assert rows.count() == 2
    assert rows.first.get_attribute("title") == BIG_ADDR, "largest amount first"
    assert fpage.get_attribute("#stepNext", "aria-expanded") == "true"
    rows.first.click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=BIG_ADDR); idle(fpage)
    assert fpage.is_hidden("#stepMenu")
    assert fpage.text_content("#stepKind") == "Wallet"
    assert not [r for r in mock.requests if r[1].startswith("/address/")], "stepping onto a wallet does not download its whole history"
    assert fpage.is_visible("#stepLoad"), "but its history is one click away"
    assert fpage.evaluate("() => window.__orion.state.nav.entries.length") == 2, "the step is on the Back/Forward trail"


def test_a_single_choice_moves_without_a_list(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#stepNext"); fpage.locator("#stepMenu button.steprow").first.click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=BIG_ADDR); idle(fpage)
    assert fpage.inner_text("#stepNextN") == "1"
    fpage.click("#stepNext")                                          # the wallet was spent by exactly one transaction
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=BIG_SPENDER); idle(fpage)
    assert fpage.is_hidden("#stepMenu") and fpage.text_content("#stepKind") == "Transaction"
    assert fpage.evaluate("(id) => window.__orion.state.graph.nodes.get(id).loaded", BIG_SPENDER)
    fpage.click("#stepPrev")                                          # and back up: the wallet, then the first transaction
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg="addr:" + SPENDERS_INPUT_FOR_BIG()); idle(fpage)


def SPENDERS_INPUT_FOR_BIG():
    sp = next(t for t in SPENDERS if t["txid"] == OUTSPENDS[BIG]["txid"])
    return next(v["prevout"]["scriptpubkey_address"] for v in sp["vin"] if v["txid"] == NORMAL["txid"] and v["vout"] == BIG)


def test_previous_from_a_wallet_goes_to_the_transaction_that_paid_it(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#stepNext"); fpage.locator("#stepMenu button.steprow").first.click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=BIG_ADDR); idle(fpage)
    assert fpage.inner_text("#stepPrevN") == "1"
    fpage.click("#stepPrev")
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=NORMAL_ID); idle(fpage)


def test_transactions_only_mode_jumps_from_transaction_to_transaction(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.uncheck("#viaWallets")
    assert fpage.inner_text("#stepNextN") == "2" and fpage.inner_text("#stepPrevN") == "1"
    fpage.click("#stepNext")
    rows = fpage.locator("#stepMenu button.steprow")
    assert rows.count() == 2 and all(t.startswith("tx:") for t in rows.evaluate_all("els => els.map(e => e.title)"))
    assert "via" in rows.first.inner_text()
    rows.first.click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=BIG_SPENDER); idle(fpage)
    assert fpage.text_content("#stepKind") == "Transaction"
    assert fpage.evaluate("() => JSON.parse(localStorage.getItem('orion.prefs.v1')).viaWallets") is False


def test_buttons_are_disabled_with_a_reason_at_the_ends_of_the_chain(fpage):
    open_query(fpage, COINBASE["txid"])
    assert fpage.is_disabled("#stepPrev")
    assert "Coinbase" in fpage.get_attribute("#stepPrev", "title")
    fpage.locator("#cv").focus(); fpage.keyboard.press("[")
    assert "Coinbase" in toast_text(fpage), "the shortcut explains instead of doing nothing"
    # a wallet whose coins have not moved
    wallet = next(o["scriptpubkey_address"] for o in COINBASE["vout"] if o.get("scriptpubkey_address"))
    fpage.click("#stepNext")                                             # one wallet is paid: straight there
    if fpage.is_visible("#stepMenu"):
        fpage.locator("#stepMenu button.steprow").first.click()
    fpage.wait_for_function("() => window.__orion.state.focus.startsWith('addr:')"); idle(fpage)
    assert fpage.is_disabled("#stepNext")
    assert "Unspent" in fpage.get_attribute("#stepNext", "title")
    assert wallet


def test_the_load_history_button_loads_it_and_goes_away(fpage, mock):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#stepNext"); fpage.locator("#stepMenu button.steprow").first.click()
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=BIG_ADDR); idle(fpage)
    addr = BIG_ADDR[len("addr:"):]
    mock.routes["/address/" + addr] = {"address": addr, "chain_stats": {"tx_count": 2}, "mempool_stats": {"tx_count": 0}}
    mock.routes["/address/" + addr + "/txs"] = [NORMAL, SPENDERS[1] if BIG_SPENDER.endswith(SPENDERS[1]["txid"]) else SPENDERS[0]]
    fpage.click("#stepLoad"); idle(fpage)
    assert fpage.is_hidden("#stepLoad")
    assert "2 txs on chain" in fpage.inner_text("#stepAmt")
    assert [r for r in mock.requests if r[1].startswith("/address/" + addr)]


def test_keyboard_steps_and_escape_closes_the_list(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.locator("#cv").focus()
    fpage.keyboard.press("]")
    assert fpage.is_visible("#stepMenu")
    fpage.keyboard.press("Escape")
    assert fpage.is_hidden("#stepMenu")
    assert focus(fpage) == NORMAL_ID, "Escape only closed the list"
    fpage.keyboard.press("[")                                            # one way back: goes straight there
    fpage.wait_for_function("(id) => window.__orion.state.focus === id", arg=INPUT_ADDR); idle(fpage)


def test_clicking_elsewhere_closes_the_list(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#stepNext"); assert fpage.is_visible("#stepMenu")
    fpage.mouse.click(400, 300)
    assert fpage.is_hidden("#stepMenu")
    fpage.click("#stepNext"); fpage.click("#stepNext")                   # a second click on the same button closes it
    assert fpage.is_hidden("#stepMenu")


def test_amounts_in_the_list_follow_the_display_choice(fpage):
    open_query(fpage, NORMAL["txid"])
    use_usd(fpage)
    fpage.click("#stepNext")
    first = fpage.locator("#stepMenu .steprow .amt").first.inner_text()
    assert "BTC" in first and "$" in first
    fpage.keyboard.press("Escape")
    fpage.click("#showSeg button[data-show=fiat]")
    fpage.click("#stepNext")
    assert "BTC" not in fpage.locator("#stepMenu .steprow .amt").first.inner_text()


def test_the_step_bar_disappears_when_the_graph_is_cleared(fpage):
    open_query(fpage, NORMAL["txid"])
    fpage.click("#btnClear"); fpage.click("#btnClear")
    assert fpage.is_hidden("#stepbar")
    assert fpage.evaluate("() => window.__orion.renderer.insets.bottom") == 0


def test_an_edge_of_a_transaction_not_loaded_yet_is_priced_when_it_was_spent_not_at_todays_price(fpage):
    from test_fiat_sources import price_at, money
    open_query(fpage, NORMAL["txid"])
    use_usd(fpage)
    fund = "out:%s:%d" % (NORMAL["vin"][0]["txid"], NORMAL["vin"][0]["vout"])
    label = fpage.evaluate("(id) => window.__orion.renderer.data.edgeLabel(window.__orion.state.graph.edges.get(id))", fund)
    amount = NORMAL["vin"][0]["prevout"]["value"]
    assert label.startswith("0.0212") and "≈ $" in label, label
    expected = amount / 1e8 * price_at(NORMAL["status"]["block_time"])
    assert abs(money(label.split("·")[1]) - expected) < 0.01, (label, expected)
    from conftest import PRICES_NOW
    assert abs(money(label.split("·")[1]) - amount / 1e8 * PRICES_NOW["USD"]) > 1, "not today's price"


def test_the_list_does_not_repeat_a_known_wallet_name_and_clears_the_toast(fpage):
    open_query(fpage, NORMAL["txid"])
    assert fpage.is_visible("#toast")
    fpage.click("#stepNext")
    assert fpage.is_hidden("#toast"), "the list is not covered by the message"
    text = fpage.locator("#stepMenu .steprow .what").first.inner_text()
    assert text.count("Robinhood") == 1, text
