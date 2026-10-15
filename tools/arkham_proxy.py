#!/usr/bin/env python3
"""Local lookup proxy: lets the Orion workspace ask Arkham Intelligence about ONE wallet at a time.

Why it exists: Arkham's API sends no CORS headers, so a web page cannot call it, and an API key must not be placed in a
web page anyway. This small program runs on your own machine, keeps the key in an environment variable and forwards
exactly one kind of request.

    set ARKHAM_API_KEY=...            (Windows cmd)     export ARKHAM_API_KEY=...   (Linux, macOS)
    python tools/arkham_proxy.py

It prints a proxy URL and a token. In the workspace open Controls > External sources and enter both.

What it will and will not do
  * listens on 127.0.0.1 only (no option to listen elsewhere);
  * answers only  GET /health  and  GET /intelligence/address/<address>  and only with the right X-Orion-Token header,
    so a web page you happen to visit cannot use your key or learn anything from it;
  * sends the key to the upstream only, never logs it, never returns it, refuses a plain-http upstream (except loopback,
    for tests) so the key cannot travel in the clear;
  * caches answers, and limits how many requests it makes to Arkham per minute, to protect your quota.

Standard library only. Python 3.8 or newer.
"""
import argparse
import collections
import hmac
import http.server
import json
import os
import re
import secrets
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_UPSTREAM = "https://api.arkm.com"
ADDRESS = re.compile(r"^[A-Za-z0-9]{14,90}$")
MAX_BODY = 1024 * 1024                      # largest upstream answer accepted
LOOPBACK = ("127.0.0.1", "localhost", "[::1]", "::1")


def upstream_is_safe(url):
    """The key may only be sent over https, or to this machine."""
    p = urllib.parse.urlparse(url)
    if p.scheme == "https" and p.hostname:
        return True
    return p.scheme == "http" and (p.hostname or "") in LOOPBACK


class Config:
    def __init__(self, key, token, upstream, cache_seconds=3600, per_minute=30, timeout=20):
        self.key, self.token, self.upstream = key, token, upstream.rstrip("/")
        self.cache_seconds, self.per_minute, self.timeout = cache_seconds, per_minute, timeout
        self.cache = {}                                 # address -> (stored_at, status, body bytes)
        self.calls = collections.deque()                # times of recent upstream requests
        self.lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "orion-arkham-proxy/1"
    protocol_version = "HTTP/1.1"

    # -- plumbing -------------------------------------------------------------------------------
    @property
    def cfg(self):
        return self.server.cfg

    def log_message(self, fmt, *args):                  # method, path and status only: never headers (the token) or bodies
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")           # the token, not the origin, is what protects it
        self.send_header("Access-Control-Allow-Headers", "X-Orion-Token, Accept, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Cache-Control", "no-store")

    def reply(self, status, obj=None, raw=None, extra=None):
        body = raw if raw is not None else json.dumps(obj if obj is not None else {}).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def token_ok(self):
        given = self.headers.get("X-Orion-Token", "")
        return hmac.compare_digest(given.encode("utf-8"), self.cfg.token.encode("utf-8"))

    # -- methods --------------------------------------------------------------------------------
    def do_OPTIONS(self):                               # CORS preflight carries no token: it only says what is allowed
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _no(self):
        self.reply(405, {"error": "only GET is supported"}, extra={"Allow": "GET, OPTIONS"})

    do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _no

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        if parts.query or parts.fragment:
            return self.reply(400, {"error": "no query string expected"})
        path = parts.path
        if path == "/health":
            if not self.token_ok():
                return self.reply(401, {"error": "missing or wrong token"})
            return self.reply(200, {"ok": True, "keyConfigured": bool(self.cfg.key), "upstream": self.cfg.upstream})
        m = re.match(r"^/intelligence/address/([^/]+)$", path)
        if not m:
            return self.reply(404, {"error": "unknown path"})
        if not self.token_ok():
            return self.reply(401, {"error": "missing or wrong token"})
        address = urllib.parse.unquote(m.group(1))
        if not ADDRESS.match(address):
            return self.reply(400, {"error": "that is not an address"})
        self.lookup(address)

    # -- the one thing it does ------------------------------------------------------------------
    def lookup(self, address):
        cfg = self.cfg
        now = time.time()
        with cfg.lock:
            hit = cfg.cache.get(address)
            if hit and now - hit[0] < cfg.cache_seconds:
                return self.reply(hit[1], raw=hit[2])
            while cfg.calls and now - cfg.calls[0] > 60:
                cfg.calls.popleft()
            if len(cfg.calls) >= cfg.per_minute:
                wait = int(60 - (now - cfg.calls[0])) + 1
                return self.reply(429, {"error": "proxy rate limit (%d requests a minute to protect your Arkham quota): wait %d s" % (cfg.per_minute, wait)},
                                  extra={"Retry-After": str(wait)})
            cfg.calls.append(now)
        status, body, extra = self.ask_upstream(address)
        if status in (200, 404):
            with cfg.lock:
                cfg.cache[address] = (time.time(), status, body)
        self.reply(status, raw=body, extra=extra)

    def ask_upstream(self, address):
        cfg = self.cfg
        req = urllib.request.Request(cfg.upstream + "/intelligence/address/" + urllib.parse.quote(address, safe=""),
                                     headers={"API-Key": cfg.key, "Accept": "application/json", "User-Agent": "orion-arkham-proxy/1"})

        def err(status, message, extra=None):
            return status, json.dumps({"error": message}).encode("utf-8"), extra or {}

        try:
            with urllib.request.urlopen(req, timeout=cfg.timeout) as res:
                body = res.read(MAX_BODY + 1)
                code = res.status
        except urllib.error.HTTPError as e:
            code, body = e.code, b""
            if code == 404:
                return err(404, "Arkham has no entry for this address")
            if code in (401, 403):
                return err(502, "Arkham rejected the API key (HTTP %d)" % code)
            if code == 429:
                retry = e.headers.get("Retry-After", "5") if e.headers else "5"
                return err(429, "Arkham rate limit reached", {"Retry-After": retry if retry.isdigit() else "5"})
            return err(502, "Arkham answered HTTP %d" % code)
        except Exception as e:                                           # network trouble: say what, without echoing request details
            return err(502, "could not reach Arkham (%s)" % type(e).__name__)
        if len(body) > MAX_BODY:
            return err(502, "Arkham's answer was larger than %d bytes" % MAX_BODY)
        if code != 200:
            return err(502, "Arkham answered HTTP %d" % code)
        try:
            json.loads(body.decode("utf-8"))
        except Exception:
            return err(502, "Arkham's answer was not JSON")
        return 200, body, {}


class ProxyServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(port, key, token, upstream=DEFAULT_UPSTREAM, cache_seconds=3600, per_minute=30, timeout=20):
    """Build the server (listening on 127.0.0.1 only). Raises ValueError for an unsafe upstream or a missing key."""
    if not key:
        raise ValueError("no API key: set the ARKHAM_API_KEY environment variable")
    if not upstream_is_safe(upstream):
        raise ValueError("refusing to send the API key to %s: the upstream must be https" % upstream)
    srv = ProxyServer(("127.0.0.1", port), Handler)
    srv.cfg = Config(key, token, upstream, cache_seconds, per_minute, timeout)
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description="Local lookup proxy for the Orion workspace (see the top of this file).")
    ap.add_argument("--port", type=int, default=8787, help="port on 127.0.0.1 (default 8787; 0 = pick a free one)")
    ap.add_argument("--token", default=os.environ.get("ORION_PROXY_TOKEN"), help="token the page must send (default: random each start; or env ORION_PROXY_TOKEN)")
    ap.add_argument("--upstream", default=DEFAULT_UPSTREAM, help="Arkham API base URL (default %(default)s)")
    ap.add_argument("--cache-minutes", type=float, default=60, help="how long to remember an answer (default 60)")
    ap.add_argument("--max-per-minute", type=int, default=30, help="most requests per minute sent to Arkham (default 30)")
    args = ap.parse_args(argv)
    key = os.environ.get("ARKHAM_API_KEY", "").strip()
    token = args.token or secrets.token_urlsafe(16)
    try:
        srv = make_server(args.port, key, token, args.upstream, args.cache_minutes * 60, args.max_per_minute)
    except ValueError as e:
        sys.exit("arkham_proxy: %s" % e)
    port = srv.server_address[1]
    print("Orion Arkham proxy is running. The API key is read from ARKHAM_API_KEY and is never shown or sent anywhere but %s." % srv.cfg.upstream)
    print("  Proxy URL : http://127.0.0.1:%d" % port)
    print("  Token     : %s" % token)
    print("Enter both in the workspace under Controls > External sources. Ctrl+C stops it.", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
