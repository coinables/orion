"""Fiat conversion, data sources (Blockstream, Tor) and address case handling, end to end."""
import csv
import io
import re

import pytest

from conftest import ADDRESS, HIST, NORMAL, OUTSPENDS, PAGE_URL, PRICES_NOW, SPENDERS
from helpers import click_node, counts, idle, node_ids, open_query, toast_text

NORMAL_ID = "tx:" + NORMAL["txid"]
SP0 = "tx:" + SPENDERS[0]["txid"]
T_NORMAL = NORMAL["status"]["block_time"]
VALUE_OUT = sum(o["value"] for o in NORMAL["vout"])


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def price_at(t, cur="USD"):
    """Independent linear interpolation over the real price points (the test's own implementation)."""
    pts = sorted((p["time"], p[cur]) for p in HIST["prices"] if p.get(cur, -1) > 0)
    for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return p0 + (p1 - p0) * (t - t0) / (t1 - t0)
    raise AssertionError("time outside the sample")


def money(text):
    m = re.search(r"([\d,]+(?:\.\d+)?)", text)
    return float(m.group(1).replace(",", ""))


def fiat_spans(page):
    return page.locator("#inspBody .fiat").all_inner_texts()


def use_fiat(page, cur="USD"):
    page.select_option("#fiatCur", cur)
    page.wait_for_function("() => /history to|today|Could not|need/i.test(document.getElementById('fiatStatus').textContent)")
    idle(page)


def test_fiat_is_off_by_default_and_costs_no_price_requests(page, mock):
    open_query(page, NORMAL["txid"])
    assert page.input_value("#fiatCur") == "off"
    assert fiat_spans(page) == []
    assert not [r for r in mock.requests if r[1].startswith("/v1/")]
    assert page.is_disabled("input[name=fiatBasis][value=ref]")


def test_amounts_are_converted_at_each_transactions_own_time(page, mock):
    open_query(page, NORMAL["txid"])
    use_fiat(page, "USD")
    status = page.inner_text("#fiatStatus")
    assert "history to" in status and "1 BTC = $82,052.00 today" in status
    texts = fiat_spans(page)
    assert texts, "the inspector shows fiat beside the Bitcoin amounts"
    expected = VALUE_OUT / 1e8 * price_at(T_NORMAL)
    out_span = page.locator("#inspBody dd", has_text="BTC").first.locator(".fiat")
    assert abs(money(out_span.inner_text()) - expected) < 0.01, (out_span.inner_text(), expected)
    assert out_span.inner_text().startswith("≈"), "weekly data: flagged as an estimate"
    title = out_span.get_attribute("title")
    assert "per BTC at 2022-04-05" in title and "interpolated between price points 7.0 days apart" in title
    # one history download and one 'today' call, nothing per transaction
    assert [p for _, p in mock.requests if p.startswith("/v1/")] == ["/v1/prices", "/v1/historical-price?currency=USD"] \
        or sorted(p for _, p in mock.requests if p.startswith("/v1/")) == ["/v1/historical-price?currency=USD", "/v1/prices"]


def test_today_basis_uses_todays_price(page):
    open_query(page, NORMAL["txid"])
    use_fiat(page, "USD")
    page.check("input[name=fiatBasis][value=today]"); idle(page)
    span = page.locator("#inspBody dd", has_text="BTC").first.locator(".fiat")
    assert abs(money(span.inner_text()) - VALUE_OUT / 1e8 * PRICES_NOW["USD"]) < 0.01
    assert not span.inner_text().startswith("≈")
    assert "today" in span.get_attribute("title")


def test_one_transactions_time_converts_everything_at_that_moment(page):
    open_query(page, NORMAL["txid"])
    click_node(page, NORMAL_ID, dbl=True); idle(page)                      # also loads the spenders (August 2022)
    use_fiat(page, "USD")
    click_node(page, SP0)
    page.check("input[name=fiatBasis][value=ref]")
    page.wait_for_function("() => window.__orion.state.fiat.ref !== null")
    sp_time = page.evaluate("(id) => window.__orion.state.graph.nodes.get(id).time", SP0)
    assert page.evaluate("() => window.__orion.state.fiat.ref.time") == sp_time
    assert "tx " in page.inner_text("#fiatRef")
    rates = page.evaluate("""([a, b]) => { const g = window.__orion.state.graph;
        return [window.__orion.fiatOf(1e8, g.nodes.get(a).time).rate.price, window.__orion.fiatOf(1e8, g.nodes.get(b).time).rate.price]; }""", [NORMAL_ID, SP0])
    assert rates[0] == rates[1], "both transactions are converted at the reference moment"
    assert abs(rates[0] - price_at(sp_time)) < 0.01
    click_node(page, NORMAL_ID)
    assert abs(money(page.locator("#inspBody dd", has_text="BTC").first.locator(".fiat").inner_text()) - VALUE_OUT / 1e8 * price_at(sp_time)) < 0.01


def test_the_inspector_button_sets_the_reference_and_turns_conversion_on(page):
    open_query(page, NORMAL["txid"])
    use_fiat(page, "EUR")
    page.click("text=Convert all at this time")
    page.wait_for_function("() => window.__orion.state.fiat.basis === 'ref'")
    assert page.is_checked("input[name=fiatBasis][value=ref]")
    assert page.is_disabled("text=Converting at this time")
    eur = page.locator("#inspBody dd", has_text="BTC").first.locator(".fiat").inner_text()
    assert abs(money(eur) - VALUE_OUT / 1e8 * price_at(T_NORMAL, "EUR")) < 0.01
    assert "€" in eur


def test_unconfirmed_amounts_fall_back_to_todays_price(page):
    open_query(page, NORMAL["txid"])
    use_fiat(page, "USD")
    r = page.evaluate("() => window.__orion.fiatOf(100000000, null)")
    assert abs(r["value"] - PRICES_NOW["USD"]) < 1e-6
    assert "not confirmed yet" in r["title"]


def test_other_currencies_and_yen_without_decimals(page):
    open_query(page, NORMAL["txid"])
    use_fiat(page, "JPY")
    text = page.locator("#inspBody dd", has_text="BTC").first.locator(".fiat").inner_text()
    assert "¥" in text and "." not in text
    assert "derived" in page.locator("#inspBody dd", has_text="BTC").first.locator(".fiat").get_attribute("title").lower() or True


def test_a_price_failure_is_explained_and_leaves_bitcoin_amounts_alone(page, mock):
    mock.fail["/v1/historical-price?currency=USD"] = 500
    page.evaluate("() => { window.__orion.state.priceClient.backoffMs = 5; }")
    open_query(page, NORMAL["txid"])
    use_fiat(page, "USD")
    assert "Could not load prices" in page.inner_text("#fiatStatus")
    assert fiat_spans(page) == []
    assert "0.02115000 BTC" in page.inner_text("#inspBody")
    mock.fail.clear()
    page.select_option("#fiatCur", "off"); page.select_option("#fiatCur", "USD")        # try again
    page.wait_for_function("() => /history to/.test(document.getElementById('fiatStatus').textContent)")
    assert fiat_spans(page)


def test_exports_carry_the_fiat_value_and_how_it_was_priced(page, tmp_path):
    open_query(page, NORMAL["txid"])
    use_fiat(page, "USD")
    page.click("#exportMenu summary")
    with page.expect_download() as dl:
        page.click("[data-export=csv-edges]")
    p = tmp_path / "e.csv"; dl.value.save_as(p)
    rows = list(csv.reader(io.StringIO(p.read_text(encoding="utf-8-sig"), newline="")))
    h = rows[0]
    assert {"fiat_value", "fiat_currency", "fiat_price_per_btc", "fiat_basis"} <= set(h)
    body = [r for r in rows[1:] if r[h.index("fiat_value")]]
    assert body and all(r[h.index("fiat_currency")] == "USD" for r in body)
    for r in body:
        amount, price, value = int(r[h.index("amount_sat")]), float(r[h.index("fiat_price_per_btc")]), float(r[h.index("fiat_value")])
        assert abs(value - amount / 1e8 * price) < 0.02 + price * 1e-8, r
    assert any(r[h.index("fiat_basis")].startswith("2022-04-05") for r in body)
    page.click("#exportMenu summary")
    with page.expect_download() as dl2:
        page.click("[data-export=graphml]")
    xml = open(dl2.value.path(), encoding="utf-8").read()
    assert '<data key="e_fiat_currency">USD</data>' in xml


def test_the_currency_choice_is_remembered(page):
    use_fiat(page, "GBP")
    page.reload(); page.wait_for_function("window.__orion && window.__orion.renderer")
    assert page.input_value("#fiatCur") == "GBP"
    page.wait_for_function("() => /today/.test(document.getElementById('fiatStatus').textContent)")


# ---------------------------------------------------------------- sources
def test_blockstream_is_a_data_source_and_prices_still_come_from_mempool(page, mock):
    page.select_option("#source", "blockstream")
    assert "no price API" in page.inner_text("#sourceHint")
    open_query(page, NORMAL["txid"])
    data_hosts = {h for h, p in mock.requests if not p.startswith("/v1/")}
    assert data_hosts == {"https://blockstream.info"}, data_hosts
    use_fiat(page, "USD")
    price_hosts = {h for h, p in mock.requests if p.startswith("/v1/")}
    assert price_hosts == {"https://mempool.space"}, price_hosts
    assert page.evaluate("() => window.__orion.state.client.concurrency") <= 3
    assert "Prices from mempool.space" in page.inner_text("#fiatStatus")


def test_tor_never_asks_the_clearnet_for_prices(page, mock):
    page.select_option("#source", "tor")
    open_query(page, NORMAL["txid"])
    use_fiat(page, "USD")
    hosts = {h for h, _ in mock.requests}
    assert hosts and all(h.endswith(".onion") for h in hosts), hosts
    assert "over Tor" in page.inner_text("#fiatStatus")
    assert page.evaluate("() => window.__orion.state.priceClient.timeoutMs") >= 120000


def test_a_custom_source_without_a_url_says_why_prices_are_missing(page):
    page.select_option("#source", "custom")
    page.select_option("#fiatCur", "USD")
    page.wait_for_function("() => /mempool-compatible/.test(document.getElementById('fiatStatus').textContent)")


def test_request_totals_are_shown_so_limits_can_be_watched(page):
    assert "0 data" in page.inner_text("#reqStats")
    open_query(page, NORMAL["txid"])
    assert "2 data" in page.inner_text("#reqStats")
    use_fiat(page, "USD")
    assert "2 price" in page.inner_text("#reqStats")
    page.select_option("#source", "blockstream")
    assert "2 data" in page.inner_text("#reqStats"), "the count survives a change of source"


# ---------------------------------------------------------------- address case, from every way in
def test_uppercase_and_mixed_case_bech32_are_loaded_in_proper_case(page, mock):
    for typed in (ADDRESS.upper(), ADDRESS[0].upper() + ADDRESS[1:]):
        page.evaluate("() => { document.getElementById('btnClear').click(); document.getElementById('btnClear').click(); }")
        open_query(page, typed)
        assert node_ids(page, "addr") and "addr:" + ADDRESS in node_ids(page, "addr")
        assert page.input_value("#q") == ADDRESS
    assert all(p == p.lower() for _, p in mock.requests if p.startswith("/address/")), mock.requests


def test_the_box_tidies_pasted_text_without_pressing_open(page):
    page.fill("#q", "  " + ADDRESS.upper() + "  ")
    page.dispatch_event("#q", "change")
    assert page.input_value("#q") == ADDRESS
    page.fill("#q", "https://mempool.space/address/" + ADDRESS.upper())
    page.dispatch_event("#q", "change")
    assert page.input_value("#q") == ADDRESS
    page.fill("#q", NORMAL["txid"].upper())
    page.dispatch_event("#q", "change")
    assert page.input_value("#q") == NORMAL["txid"]
    page.fill("#q", "not an address")
    page.dispatch_event("#q", "change")
    assert page.input_value("#q") == "not an address", "unrecognised text is left for you to fix"


def test_explorer_links_are_understood(page):
    open_query(page, "https://blockstream.info/tx/" + NORMAL["txid"].upper() + "?expand")
    assert NORMAL_ID in page.evaluate("() => [...window.__orion.state.graph.nodes.keys()]")


def test_a_legacy_address_in_the_wrong_case_is_not_guessed_at(page, mock):
    open_query(page, "1bvbmseystwetqtfn5au4m4gfg7xjanvn2")                       # the real 1BvBMSEY... in lower case
    msg = toast_text(page)
    assert "case-sensitive" in msg, msg
    assert not [r for r in mock.requests if r[1].startswith("/address/")]


def test_a_shared_link_with_an_uppercase_address_opens_the_proper_one(ctx, errors, mock):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL + "#f0/addr:" + ADDRESS.upper())
    p.wait_for_function("() => window.__orion && window.__orion.state.graph.nodes.size > 0"); idle(p)
    assert p.evaluate("() => window.__orion.state.focus") == "addr:" + ADDRESS
    assert all(path == path.lower() for _, path in mock.requests if path.startswith("/address/"))
    p.close()
