# ORION
![logo](public/logo.png)
## Transaction Visualizer

A serverless tool to visualize the path of bitcoin transaction and outputs. This is demo software powered by mempool.space API and sigma.js charting library. 

![screenshot](screenshot.png)

Run `orion.html` located in the `public` directory to visualize a single transaction and nearest relations.

Run `link.html` located in the `public` directory to visualize and link multiple transactions using the memory add (M+) and memory remove (M-) buttons. Clicking (M+) will save the current transaction data to the clients local memory, and will be loaded up with all future transactions queried. You can use the (M+) button multiple times to expand the visualize. Clicking (M-) will remove the saved data from local memory.

## Workspace

Open `workspace.html` in the `public` directory for an investigation workspace that keeps what the older pages throw away: when each transaction confirmed, how much moved, and what kind of script each address uses. It is a separate page; the three pages above are unchanged.

* **Focus and Back/Forward** - start from one transaction or address and see only what is around it (*Depth* = how many steps away: 1 is the vertex and its direct neighbours, 2 also shows the neighbouring transactions, 3 goes one further). Double-click a neighbour, or click a row under *Funded by* / *Spent by* / *Transactions* in the details panel, to move there; it is loaded on the way. The trail above the graph shows where you have been, and the **◀ ▶** buttons (or the browser's own Back/Forward, or Alt+←/→) step through it. The address bar keeps a link such as `workspace.html#f2/tx:<txid>` that reopens that place. Everything you load stays in the workspace; untick *Focus* to see it all at once.
* **Previous / Next** - the two buttons under the graph step along the money from wherever you are: from a transaction to the wallets it paid (Next) or that paid into it (Previous), from a wallet to the transactions that spent from it (Next) or that paid it (Previous). One way to go and it goes; several and a list opens, largest amount first, with spent/unspent and the amount. Coinbase, OP_RETURN and unspent coins are listed as information, and a disabled button says why. Untick *via wallets* to jump straight from transaction to transaction. Stepping onto a wallet shows what is already known about it and does not download its whole history (*Load history* does). The keys are `[` and `]`, and every step is on the Back/Forward trail.
* **Bitcoin, fiat or both** - once a currency is chosen under *Fiat value*, *Show amounts as* switches every amount (details, tooltips, lists, the Previous/Next list and the amounts drawn along the edges) between Bitcoin, both, and fiat only; the button in the top bar cycles it. Edge amounts can be switched off under *View*.
* **Tags** - give a wallet or transaction a tag (EXCH, THREAT, VICTIM, PAYMENT, MIXER, MARKET, SERVICE, GAMBLING, WATCH, or your own text) with a colour and a shape of its own, next to the label in the details. A preset sets a colour and shape that you can then change separately; the tag is drawn as a badge above the vertex, listed in the legend (click an entry to select everything carrying it) and written to the exports. Several selected vertices can be tagged at once.
* **Right-click menu** - right-click a wallet or transaction (or press `Shift+F10`) for its actions: focus, load history or spenders, tag, copy, open in the explorer, remove, and look a wallet up externally.
* **Collapsible panels** - both side panels fold away (`«` / `»`, or the `C` and `D` keys) to a small tab, leaving just the graph and the Previous/Next buttons. The graph refits the room unless you have zoomed or panned yourself, and the choice is remembered.
* **Time range** - a slider under the graph filters vertices and edges to a time window, with a histogram of activity and a replay button that grows the graph through time. All times are UTC.
* **Layouts** - *Flow* (left to right in the direction money moves), *Timeline* (transactions placed by confirmation time, with an axis; *Compact* shortens long quiet gaps and marks them, *Proportional* keeps true distances) and *Force*.
* **Encoding** - edge width follows the amount (log scale); colour by kind, by age or by script type; dashed edges are outputs not spent yet; hollow squares are transactions not loaded yet; a gold ring marks addresses from the built-in label list.
* **Filters** - minimum amount (hide dust), OP_RETURN and non-standard outputs, unconfirmed transactions, address types.
* **Expanding** - double-click a transaction or address (or use the buttons in the details panel) to load spenders, funding transactions or address history. Per-action limits on transactions, requests and history pages keep it polite to public APIs; when a limit stops an action the page says so and keeps what it loaded.
* **Your own labels and notes** on any vertex, kept in the exported file.
* **Export** the workspace as JSON (the only format that imports back), nodes and edges as CSV, GraphML (Gephi, Maltego, yEd, Cytoscape) or PNG, optionally only the visible part. The last session is also kept in the browser's local storage and offered back on the next visit.
* **Coinbase and OP_RETURN** transactions are handled (the OP_RETURN payload is shown as text or hex).

**Addresses** can be typed or pasted in any form: `bc1…` addresses are lower-cased whatever the case they arrive in (`Bc1q…` from an autocorrecting keyboard, `BC1Q…` from a QR code), explorer links and `bitcoin:` URIs are understood, and the checksum is verified before anything is sent, so a typo is reported at once instead of as an HTTP 400. Legacy `1…`/`3…` addresses are case-sensitive and cannot be repaired, so a wrong case is reported with advice rather than guessed at.

**Fiat values.** *Fiat value* in the left panel shows amounts in USD, EUR, GBP, CAD, CHF, AUD or JPY beside the Bitcoin amounts (details panel, tooltips, and the `fiat_*` columns of the CSV and GraphML exports). Price at *each transaction's own time*, at *one transaction's time* (every amount at the moment of the transaction you choose, e.g. a ransom payment), or at *today's* price; unconfirmed transactions use today's price. The price history is one download of the whole series, interpolated between points. **Treat it as indicative:** the resolution of mempool.space's series varies. When I measured it, it had one point a week before March 2023, one a day until January 2024 and hourly points after, but the server has also returned a denser series (the same 2022 transaction was then priced about right, without a `≈`). The page marks a price with `≈` whenever it had to interpolate across more than two days; in spot checks against well-known market levels two of five such weekly-era values were several percent off. A report should quote an exchange's price for the exact time. Hourly-era values were not checked this way.

**Data sources.** *mempool.space*, *mempool.space over Tor*, *Blockstream.info* (the same Esplora API) or your own Esplora URL. Blockstream.info has no price API, so fiat prices still come from mempool.space (only the currency and the dates are sent there); with Tor selected prices are fetched over Tor as well. Other providers that are not Esplora-compatible (Blockchair, BlockCypher, and attribution services such as Arkham) would each need their own adapter and, for most, an API key.

**External lookups (Arkham Intelligence).** On request and for one wallet at a time (right-click it, or the button in its details; never for the whole graph), the workspace can ask Arkham Intelligence who a wallet belongs to. A web page cannot call Arkham's API: it sends no CORS headers (checked with a real browser), and an API key does not belong in a page anyway. So the call goes through `tools/arkham_proxy.py`, a small program you run on your own machine: it keeps the key in the `ARKHAM_API_KEY` environment variable, listens on `127.0.0.1` only, forwards nothing but `GET /intelligence/address/<address>`, requires a token that the page sends (so no other website can use your key), caches answers and limits its own request rate to protect your quota. Run it, then enter its URL and token under *Controls > External sources*. The first look-up asks for confirmation, because the address is sent to Arkham; look-ups are switched off while the data source is Tor, since they would leave Tor. The result is shown on the wallet with its raw reply and is never applied automatically: *Use as label* and *Tag as …* are buttons. **Not verified against a live key:** Arkham's reference could not be read and no key was available, so the reply is parsed from the field names Arkham documents (`arkhamEntity`, `arkhamLabel`, `populatedTags`) tolerantly and the raw reply is always kept; if your account's reply looks different, the raw text is what you read. The proxy is covered by tests against a fake Arkham, including the key never being returned, logged or sent to the page.

**Limits.** mempool.space publishes no rate limit (a maintainer has said the limits are deliberately undisclosed) and sends no rate-limit headers; when it throttles it answers HTTP 429, and it may stop answering an IP that keeps asking. Blockstream.info publishes none either. Address history is paged 25 transactions at a time. The page therefore keeps its own limits (default: 4 requests in parallel with 150 ms spacing, 80 requests per action, 25 transactions per expand, 5-minute response cache), honours `Retry-After`, retries 429/5xx/timeouts with growing pauses, and shows the running request totals under *Data source*. For heavy use, run your own mempool/electrs instance and point *My own Esplora URL* at it.

**Data source.** By default the page asks mempool.space directly from your browser, which lets mempool.space see your IP address and what you look up. *mempool.space over Tor (.onion)* sends the same requests to the mempool.space onion service instead (fewer parallel requests, more spacing, longer timeout): open the page in Tor Browser for this, since an ordinary browser cannot reach `.onion` addresses, and note that a browser may refuse a request from an `https://` page to an `http://` onion address, so open the file from disk or from `http://localhost`. You can also point it at your own Esplora-compatible API (it must allow cross-origin requests). The page makes no other network requests: no fonts, analytics or CDNs.

Labels and notes you type, and anything you import, are only ever shown as text. CSV exports are protected against spreadsheet formula injection.

Maintenance:

* `python tools/extract_known.py` rebuilds `public/data/known-addresses.js` from the label list in `orion.html` (duplicates merged, conflicting labels shown as "also listed as").
* `python tools/fetch_fixtures.py` refreshes the public-chain fixtures in `test/fixtures` used by the tests.
* Unit tests: `node --test "test/*.test.js"` (Node 20+). Browser tests: `pip install pytest playwright && playwright install firefox`, then `python -m pytest test/e2e` (the API is mocked from the fixtures, so no network is needed). Lookup proxy tests: `python -m pytest test/proxy`.

Donations accepted (BIP352): sp1qqgyfdwfg3quxngctw4w7z0xh9hntfkf3tdzrts5cjgqxdvycnv05cqul76mhtrp3k497hqxxeh247qczuy624yw4s24tn5j2zsztdvyntuwq5jcz

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>
