#!/usr/bin/env python3
"""Fetch the public-blockchain fixtures used by test/ (unit and end-to-end).

Everything saved here is public chain data from the mempool.space (Esplora) API.
Re-run to refresh:  python tools/fetch_fixtures.py [--base https://mempool.space/api]
"""
import argparse, json, pathlib, sys, time, urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures"
NORMAL = "0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d"   # the page's own default sample
OPRETURN_BLOCK_SCAN_PAGES = 8


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", default="https://mempool.space/api")
    base = ap.parse_args().base.rstrip("/")

    def get(path):
        time.sleep(0.6)                                    # be polite to a public API
        req = urllib.request.Request(base + path, headers={"User-Agent": "orion-fixtures/1.0"})
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read().decode("utf-8")
        try: return json.loads(raw)
        except ValueError: return raw.strip()

    def save(name, obj):
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / name).write_text(json.dumps(obj, indent=1, sort_keys=True), encoding="utf-8")
        print(f"  saved {name}")

    print("normal transaction, its outspends and up to 3 spending transactions")
    tx = get(f"/tx/{NORMAL}"); save("tx_normal.json", tx)
    outs = get(f"/tx/{NORMAL}/outspends"); save("outspends_normal.json", outs)
    for i, sp in enumerate([o for o in outs if o.get("spent")][:3]):
        save(f"tx_spender_{i}.json", get(f"/tx/{sp['txid']}"))

    print("an address from that transaction with a short history")
    for o in tx["vout"]:
        a = o.get("scriptpubkey_address")
        if not a: continue
        stats = get(f"/address/{a}")
        if 2 <= stats["chain_stats"]["tx_count"] <= 20:
            save("address_stats.json", stats); save("address_txs.json", get(f"/address/{a}/txs"))
            print(f"  address: {a}")
            break

    print("a coinbase transaction and a non-coinbase transaction with an OP_RETURN output (from the chain tip)")
    tip = get("/blocks/tip/hash")
    first = get(f"/block/{tip}/txs/0")
    save("tx_coinbase.json", first[0])
    found = None
    for start in range(0, 25 * OPRETURN_BLOCK_SCAN_PAGES, 25):
        for t in get(f"/block/{tip}/txs/{start}"):
            if (not t["vin"][0].get("is_coinbase") and len(t["vin"]) < 6
                    and any(o["scriptpubkey_type"] == "op_return" for o in t["vout"])):
                found = t; break
        if found: break
    if not found:
        sys.exit("no OP_RETURN transaction found in the scanned part of the tip block; re-run later")
    save("tx_opreturn.json", found)


if __name__ == "__main__":
    main()
