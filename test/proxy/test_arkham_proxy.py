"""Tests for tools/arkham_proxy.py against a fake Arkham, over real HTTP on loopback."""
import http.client
import http.server
import importlib.util
import io
import json
import pathlib
import threading
import time
from contextlib import redirect_stderr

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("arkham_proxy", ROOT / "tools" / "arkham_proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

KEY = "SECRET-KEY-value-0123456789"
TOKEN = "tok-abcdef"
KNOWN = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"
REPLY = {"address": KNOWN, "arkhamEntity": {"name": "Binance", "type": "cex"}}


class FakeArkham(http.server.BaseHTTPRequestHandler):
    log = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        FakeArkham.log.append((self.path, self.headers.get("API-Key")))
        a = self.path.rsplit("/", 1)[-1]
        if self.headers.get("API-Key") != KEY:
            return self._send(401, b'{"error":"unauthorized"}')
        if a == KNOWN:
            return self._send(200, json.dumps(REPLY).encode())
        if a.startswith("unknown"):
            return self._send(404, b"{}")
        if a.startswith("forbidden"):
            return self._send(403, b"{}")
        if a.startswith("limited"):
            return self._send(429, b"{}", {"Retry-After": "7"})
        if a.startswith("broken"):
            return self._send(500, b"oops")
        if a.startswith("notjson"):
            return self._send(200, b"<html>")
        if a.startswith("huge"):
            return self._send(200, b'{"x":"' + b"a" * (proxy.MAX_BODY + 10) + b'"}')
        return self._send(200, json.dumps({"address": a, "arkhamLabel": {"name": "L"}}).encode())

    def _send(self, status, body, headers=None):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def fake():
    FakeArkham.log = []
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeArkham)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    yield s
    s.shutdown(); s.server_close()


def start(upstream, **kw):
    srv = proxy.make_server(0, kw.pop("key", KEY), kw.pop("token", TOKEN), upstream, **kw)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture
def px(fake):
    srv = start("http://127.0.0.1:%d" % fake.server_address[1])
    yield srv
    srv.shutdown(); srv.server_close()


def call(srv, method, path, token=TOKEN, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=10)
    h = dict(headers or {})
    if token is not None:
        h["X-Orion-Token"] = token
    c.request(method, path, headers=h)
    r = c.getresponse()
    body = r.read()
    out = (r.status, dict((k.lower(), v) for k, v in r.getheaders()), body)
    c.close()
    return out


def test_it_only_listens_on_this_machine(px):
    assert px.server_address[0] == "127.0.0.1"


def test_health_needs_the_token_and_never_shows_the_key(px):
    assert call(px, "GET", "/health", token=None)[0] == 401
    assert call(px, "GET", "/health", token="wrong")[0] == 401
    s, h, b = call(px, "GET", "/health")
    assert s == 200 and json.loads(b)["keyConfigured"] is True
    assert KEY.encode() not in b and KEY not in json.dumps(h)


def test_a_lookup_sends_the_key_upstream_and_returns_the_answer(px):
    s, h, b = call(px, "GET", "/intelligence/address/" + KNOWN)
    assert s == 200 and json.loads(b) == REPLY
    assert FakeArkham.log == [("/intelligence/address/" + KNOWN, KEY)]
    assert h["access-control-allow-origin"] == "*" and h["cache-control"] == "no-store"
    assert KEY.encode() not in b and KEY not in json.dumps(h), "the key never comes back"


def test_preflight_answers_without_a_token_and_allows_the_token_header(px):
    s, h, b = call(px, "OPTIONS", "/intelligence/address/" + KNOWN, token=None,
                   headers={"Origin": "null", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-orion-token"})
    assert s == 204
    assert "x-orion-token" in h["access-control-allow-headers"].lower()
    assert h["access-control-allow-private-network"] == "true"
    assert FakeArkham.log == []


def test_without_the_right_token_nothing_is_forwarded(px):
    for tok in (None, "", "wrong", TOKEN + "x", TOKEN[:-1]):
        assert call(px, "GET", "/intelligence/address/" + KNOWN, token=tok)[0] == 401
    assert FakeArkham.log == []


@pytest.mark.parametrize("path", [
    "/intelligence/address/short", "/intelligence/address/" + "a" * 91, "/intelligence/address/..%2F..%2Fsecret",
    "/intelligence/address/a%20b%20c%20d%20e%20f%20g%20h%20i%20j", "/intelligence/address/" + KNOWN + "?chain=x", "/intelligence/address/" + KNOWN + "#frag",
    "/intelligence/address/%00" + "a" * 20, "/intelligence/address/" + KNOWN + "/extra", "/intelligence/address/", "/intelligence/entity/binance",
    "/intelligence/search?q=x", "/", "/anything/else", "/health/extra"])
def test_only_address_lookups_are_forwarded(px, path):
    s, _, _ = call(px, "GET", path)
    assert s in (400, 404), path
    assert FakeArkham.log == [], path


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_only_get_is_supported(px, method):
    assert call(px, method, "/intelligence/address/" + KNOWN)[0] == 405
    assert FakeArkham.log == []


def test_answers_are_remembered_so_the_quota_is_spent_once(px):
    for _ in range(3):
        assert call(px, "GET", "/intelligence/address/" + KNOWN)[0] == 200
    assert len(FakeArkham.log) == 1
    for _ in range(2):
        assert call(px, "GET", "/intelligence/address/unknown1" + "a" * 10)[0] == 404
    assert len(FakeArkham.log) == 2, "'no entry' is remembered too"


def test_upstream_problems_become_clear_errors_without_the_key(px):
    s, _, b = call(px, "GET", "/intelligence/address/forbidden" + "a" * 10)
    assert s == 502 and "API key" in json.loads(b)["error"]
    s, h, b = call(px, "GET", "/intelligence/address/limited0" + "a" * 10)
    assert s == 429 and h["retry-after"] == "7"
    assert call(px, "GET", "/intelligence/address/broken00" + "a" * 10)[0] == 502
    assert call(px, "GET", "/intelligence/address/notjson0" + "a" * 10)[0] == 502
    assert call(px, "GET", "/intelligence/address/huge0000" + "a" * 10)[0] == 502
    assert call(px, "GET", "/intelligence/address/unknown2" + "a" * 10)[0] == 404
    for a in ("forbidden", "limited0", "broken00", "notjson0"):
        pass
    # errors are not cached: asking again goes upstream again
    n = len(FakeArkham.log)
    call(px, "GET", "/intelligence/address/broken00" + "a" * 10)
    assert len(FakeArkham.log) == n + 1


def test_a_wrong_upstream_key_is_reported_as_such(fake):
    srv = start("http://127.0.0.1:%d" % fake.server_address[1], key="not-the-key")
    try:
        s, _, b = call(srv, "GET", "/intelligence/address/" + KNOWN)
        assert s == 502 and "rejected the API key" in json.loads(b)["error"] and "not-the-key" not in b.decode()
    finally:
        srv.shutdown(); srv.server_close()


def test_it_limits_how_often_it_asks_arkham(fake):
    srv = start("http://127.0.0.1:%d" % fake.server_address[1], per_minute=2)
    try:
        assert call(srv, "GET", "/intelligence/address/aaaaaaaaaaaaaaaa1")[0] == 200
        assert call(srv, "GET", "/intelligence/address/aaaaaaaaaaaaaaaa2")[0] == 200
        s, h, b = call(srv, "GET", "/intelligence/address/aaaaaaaaaaaaaaaa3")
        assert s == 429 and int(h["retry-after"]) > 0 and "rate limit" in json.loads(b)["error"]
        assert len(FakeArkham.log) == 2
        assert call(srv, "GET", "/intelligence/address/aaaaaaaaaaaaaaaa1")[0] == 200, "cached answers do not count"
    finally:
        srv.shutdown(); srv.server_close()


def test_the_key_is_never_logged(px):
    buf = io.StringIO()
    with redirect_stderr(buf):
        call(px, "GET", "/intelligence/address/" + KNOWN)
        call(px, "GET", "/health")
        call(px, "GET", "/intelligence/address/" + KNOWN, token="wrong")
        time.sleep(0.1)
    text = buf.getvalue()
    assert KNOWN in text or "GET" in text
    assert KEY not in text and TOKEN not in text and "wrong" not in text


def test_a_dead_upstream_is_reported_not_crashed(fake):
    port = fake.server_address[1]
    fake.shutdown(); fake.server_close()
    srv = start("http://127.0.0.1:%d" % port, timeout=2)
    try:
        s, _, b = call(srv, "GET", "/intelligence/address/" + KNOWN)
        assert s == 502 and "could not reach" in json.loads(b)["error"]
    finally:
        srv.shutdown(); srv.server_close()


def test_it_will_not_start_unsafely():
    with pytest.raises(ValueError, match="no API key"):
        proxy.make_server(0, "", TOKEN)
    with pytest.raises(ValueError, match="https"):
        proxy.make_server(0, KEY, TOKEN, "http://api.example.com")
    with pytest.raises(ValueError, match="https"):
        proxy.make_server(0, KEY, TOKEN, "ftp://example.com")
    assert proxy.upstream_is_safe("https://api.arkm.com")
    assert proxy.upstream_is_safe("http://127.0.0.1:9")
    assert proxy.upstream_is_safe("http://localhost:9")
    assert not proxy.upstream_is_safe("http://api.arkm.com")
    assert not proxy.upstream_is_safe("http://127.0.0.1.evil.com")
    with pytest.raises(SystemExit):
        proxy.main(["--port", "0"]) if not __import__("os").environ.get("ARKHAM_API_KEY") else (_ for _ in ()).throw(SystemExit())
