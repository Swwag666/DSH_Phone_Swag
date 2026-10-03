"""Tests for the dsh-phone gateway: auth, IP filter, HTTP parser, routing,
staging cleanup. Runs on stdlib only: python -m unittest -v
"""

import asyncio
import ipaddress
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gateway as gw


def ip(s):
    return ipaddress.ip_address(s)


class FakeWriter:
    def __init__(self):
        self.chunks = []

    def write(self, b):
        self.chunks.append(bytes(b))

    async def drain(self):
        pass

    def all_bytes(self):
        return b"".join(self.chunks)


def feed(reader, raw):
    reader.feed_data(raw)


def stream_reader():
    return asyncio.StreamReader(limit=2**16)


async def parse(raw):
    return await gw.read_request_head(feed_reader_with(raw))


def feed_reader_with(raw):
    r = stream_reader()
    r.feed_data(raw)
    return r


class TestTokenOk(unittest.TestCase):
    def test_match(self):
        self.assertTrue(gw.token_ok("abc123", "abc123"))

    def test_mismatch(self):
        self.assertFalse(gw.token_ok("abc123", "abc124"))

    def test_length_diff(self):
        self.assertFalse(gw.token_ok("short", "short-but-longer"))

    def test_empty_stored_never_matches(self):
        self.assertFalse(gw.token_ok("", ""))
        self.assertFalse(gw.token_ok("x", ""))
        self.assertFalse(gw.token_ok("x", None))

    def test_non_string(self):
        self.assertFalse(gw.token_ok(None, "x"))
        self.assertFalse(gw.token_ok(123, "x"))


class TestAllowIp(unittest.TestCase):
    def test_none_always_allowed(self):
        self.assertTrue(gw.allow_ip(["1.2.3.4"], None))

    def test_loopback_overrides_allowlist(self):
        self.assertTrue(gw.allow_ip(["1.2.3.4"], ip("127.0.0.1")))

    def test_empty_allowlist_allows_all(self):
        self.assertTrue(gw.allow_ip([], ip("8.8.8.8")))

    def test_exact_v4(self):
        self.assertTrue(gw.allow_ip(["100.75.97.90"], ip("100.75.97.90")))
        self.assertFalse(gw.allow_ip(["100.75.97.90"], ip("100.75.97.91")))

    def test_cidr(self):
        self.assertTrue(gw.allow_ip(["100.64.0.0/10"], ip("100.100.1.2")))
        self.assertFalse(gw.allow_ip(["100.64.0.0/10"], ip("100.128.0.1")))
        self.assertFalse(gw.allow_ip(["100.64.0.0/10"], ip("101.0.0.1")))

    def test_invalid_entries_skipped(self):
        self.assertTrue(gw.allow_ip(["not-an-ip", "", "100.64.0.0/10"], ip("100.80.0.1")))
        self.assertFalse(gw.allow_ip(["not-an-ip", ""], ip("100.80.0.1")))

    def test_v6_exact(self):
        self.assertTrue(gw.allow_ip(["fe80::1"], ip("fe80::1")))
        self.assertFalse(gw.allow_ip(["fe80::1"], ip("fe80::2")))


class TestReadRequestHead(unittest.IsolatedAsyncioTestCase):
    async def test_simple_get(self):
        r = feed_reader_with(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        req = await gw.read_request_head(r)
        method, path, q, headers, body, keep = req
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/")
        self.assertEqual(body, b"")
        self.assertTrue(keep)
        self.assertEqual(headers.get("host"), "x")

    async def test_http10_default_close(self):
        r = feed_reader_with(b"GET / HTTP/1.0\r\nHost: x\r\n\r\n")
        req = await gw.read_request_head(r)
        self.assertFalse(req[5])

    async def test_http10_keep_alive_header(self):
        r = feed_reader_with(b"GET / HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\n\r\n")
        req = await gw.read_request_head(r)
        self.assertTrue(req[5])

    async def test_http11_connection_close(self):
        r = feed_reader_with(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        req = await gw.read_request_head(r)
        self.assertFalse(req[5])

    async def test_query_string(self):
        r = feed_reader_with(b"GET /api/events?since=12.5&had=1 HTTP/1.1\r\n\r\n")
        method, path, q, headers, body, keep = await gw.read_request_head(r)
        self.assertEqual(path, "/api/events")
        self.assertEqual(q.get("since"), "12.5")
        self.assertEqual(q.get("had"), "1")

    async def test_content_length_body(self):
        raw = b"POST /api/rpc HTTP/1.1\r\nContent-Length: 11\r\n\r\nhello world"
        r = feed_reader_with(raw)
        req = await gw.read_request_head(r)
        self.assertEqual(req[4], b"hello world")

    async def test_bad_content_length(self):
        raw = b"POST /api/rpc HTTP/1.1\r\nContent-Length: abc\r\n\r\n"
        r = feed_reader_with(raw)
        with self.assertRaises(gw.BadHttpRequest) as ctx:
            await gw.read_request_head(r)
        self.assertIn("400", ctx.exception.status)

    async def test_body_too_large(self):
        raw = b"POST /api/upload HTTP/1.1\r\nContent-Length: 999999999999\r\n\r\n"
        r = feed_reader_with(raw)
        with self.assertRaises(gw.BadHttpRequest) as ctx:
            await gw.read_request_head(r)
        self.assertIn("413", ctx.exception.status)

    async def test_too_many_headers(self):
        head = b"GET / HTTP/1.1\r\n" + b"".join(
            b"X-H%d: v\r\n" % i for i in range(gw.MAX_HEADER_LINES + 5)
        ) + b"\r\n"
        r = feed_reader_with(head)
        with self.assertRaises(gw.BadHttpRequest) as ctx:
            await gw.read_request_head(r)
        self.assertIn("431", ctx.exception.status)

    async def test_chunked_body(self):
        # "hello world" in two chunks
        raw = (
            b"POST /api/rpc HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"
            b"5\r\nhello\r\n"
            b"6\r\n world\r\n"
            b"0\r\n\r\n"
        )
        r = feed_reader_with(raw)
        req = await gw.read_request_head(r)
        self.assertEqual(req[4], b"hello world")
        self.assertTrue(req[5])

    async def test_chunked_with_trailers(self):
        raw = (
            b"POST /api/rpc HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"
            b"3\r\nabc\r\n"
            b"0\r\n"
            b"X-Trailer: v\r\n"
            b"\r\n"
        )
        r = feed_reader_with(raw)
        req = await gw.read_request_head(r)
        self.assertEqual(req[4], b"abc")

    async def test_chunked_bad_size(self):
        raw = (
            b"POST /api/rpc HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"
            b"zz\r\nabc\r\n"
            b"0\r\n\r\n"
        )
        r = feed_reader_with(raw)
        with self.assertRaises(gw.BadHttpRequest) as ctx:
            await gw.read_request_head(r)
        self.assertIn("400", ctx.exception.status)

    async def test_unsupported_transfer_encoding(self):
        raw = b"POST /api/rpc HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n"
        r = feed_reader_with(raw)
        with self.assertRaises(gw.BadHttpRequest) as ctx:
            await gw.read_request_head(r)
        self.assertIn("501", ctx.exception.status)

    async def test_header_folding(self):
        raw = b"GET / HTTP/1.1\r\nX-Long: first\r\n  second\r\n\r\n"
        r = feed_reader_with(raw)
        req = await gw.read_request_head(r)
        self.assertEqual(req[3].get("x-long"), "first second")

    async def test_expect_100_continue(self):
        raw = (
            b"POST /api/rpc HTTP/1.1\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n"
            b"hello"
        )
        r = feed_reader_with(raw)
        fw = FakeWriter()
        req = await gw.read_request_head(r, fw)
        self.assertEqual(req[4], b"hello")
        self.assertIn(b"HTTP/1.1 100 Continue\r\n\r\n", fw.all_bytes())

    async def test_clean_eof_returns_none(self):
        r = stream_reader()
        r.feed_eof()
        self.assertIsNone(await gw.read_request_head(r))


class TestServeStatic(unittest.TestCase):
    def test_index(self):
        resp = gw.serve_static("/")
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        self.assertIn(b"text/html", resp)

    def test_app_js(self):
        resp = gw.serve_static("/app.js")
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        self.assertIn(b"text/javascript", resp)

    def test_traversal_blocked(self):
        resp = gw.serve_static("/../gateway.py")
        self.assertIn(b"403 Forbidden", resp.split(b"\r\n")[0])

    def test_windows_drive_blocked(self):
        resp = gw.serve_static("/C:/Windows/notepad.exe")
        # absolute path outside WEB -> refused (403) or SPA fallback, never the file
        body_start = resp.split(b"\r\n\r\n", 1)[1]
        self.assertNotIn(b"MZ", body_start[:2])

    def test_missing_falls_back_to_index(self):
        resp = gw.serve_static("/no-such-page")
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        self.assertIn(b"text/html", resp)

    def test_keep_alive_header(self):
        resp = gw.serve_static("/index.html", keep=True)
        self.assertIn(b"Connection: keep-alive", resp.split(b"\r\n\r\n")[0])
        resp = gw.serve_static("/index.html", keep=False)
        self.assertIn(b"Connection: close", resp.split(b"\r\n\r\n")[0])


class TestCleanupStaging(unittest.TestCase):
    def test_removes_only_stale(self):
        with tempfile.TemporaryDirectory() as d:
            stale = os.path.join(d, "stale.bin")
            fresh = os.path.join(d, "fresh.bin")
            for p in (stale, fresh):
                with open(p, "wb") as fh:
                    fh.write(b"x")
            os.utime(stale, (1, 1))  # mtime = epoch
            removed = gw.cleanup_staging(d, 3600)
            self.assertEqual(removed, 1)
            self.assertFalse(os.path.exists(stale))
            self.assertTrue(os.path.exists(fresh))

    def test_missing_dir_noop(self):
        self.assertEqual(gw.cleanup_staging(os.path.join(tempfile.gettempdir(), "nope-xyz"), 60), 0)

    def test_empty_retention_deletes_all(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.bin")
            with open(p, "wb") as fh:
                fh.write(b"x")
            self.assertEqual(gw.cleanup_staging(d, 0), 1)
            self.assertFalse(os.path.exists(p))


def make_gateway():
    cfg = dict(gw.DEFAULT_CONFIG)
    cfg["gatewayToken"] = "test-token-0123456789abcdef"
    cfg["attachmentStagingPath"] = tempfile.mkdtemp(prefix="dsh-test-stage-")
    cfg["bridgeEndpointPath"] = os.path.join(cfg["attachmentStagingPath"], "endpoint.json")
    return gw.Gateway(cfg)


class TestServerIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gw = make_gateway()
        self.server = await asyncio.start_server(
            lambda r, w: gw.handle_http(r, w, self.gw), "127.0.0.1", 0
        )
        self.port = self.server.sockets[0].getsockname()[1]
        self.addr = ("127.0.0.1", self.port)

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def raw_roundtrip(self, raw, read_until_close=False):
        reader, writer = await asyncio.open_connection(*self.addr)
        writer.write(raw)
        await writer.drain()
        if read_until_close:
            data = await reader.read(-1)
            writer.close()
            return data
        data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        head, _, rest = data.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1].strip())
        while len(rest) < length:
            rest += await asyncio.wait_for(reader.readexactly(length - len(rest)), 10)
        writer.close()
        return head + b"\r\n\r\n" + rest

    async def test_health_open(self):
        resp = await self.raw_roundtrip(b"GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        body = json.loads(resp.split(b"\r\n\r\n", 1)[1])
        self.assertTrue(body["ok"])
        self.assertEqual(body["bridge"], "disconnected")

    async def test_rpc_wrong_token_401(self):
        body = json.dumps({"token": "wrong", "method": "ping"}).encode()
        raw = b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body
        resp = await self.raw_roundtrip(raw)
        self.assertIn(b"401 Unauthorized", resp.split(b"\r\n")[0])

    async def test_rpc_whitelisted_method_reaches_bridge_502(self):
        body = json.dumps({"token": self.gw.cfg["gatewayToken"], "method": "ping"}).encode()
        raw = b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body
        resp = await self.raw_roundtrip(raw)
        # auth + whitelist passed; bridge is down -> 502 (not 401/403)
        self.assertIn(b"502 Bad Gateway", resp.split(b"\r\n")[0])

    async def test_rpc_non_whitelisted_method_403(self):
        body = json.dumps({"token": self.gw.cfg["gatewayToken"], "method": "evil.method"}).encode()
        raw = b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body
        resp = await self.raw_roundtrip(raw)
        self.assertIn(b"403 Forbidden", resp.split(b"\r\n")[0])

    async def test_rpc_token_in_header(self):
        body = json.dumps({"method": "ping"}).encode()
        raw = (
            b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\nX-Dsh-Token: %s\r\n\r\n"
            % (len(body), self.gw.cfg["gatewayToken"].encode())
            + body
        )
        resp = await self.raw_roundtrip(raw)
        self.assertIn(b"502 Bad Gateway", resp.split(b"\r\n")[0])

    async def test_events_token_in_header(self):
        self.gw.push_event("bridge", {"status": "connected"})
        raw = (
            b"GET /api/events?since=0&had=1 HTTP/1.1\r\nX-Dsh-Token: %s\r\n\r\n"
            % self.gw.cfg["gatewayToken"].encode()
        )
        resp = await self.raw_roundtrip(raw)
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        body = json.loads(resp.split(b"\r\n\r\n", 1)[1])
        self.assertIn("ts", body)
        self.assertTrue(any(e["type"] == "bridge" for e in body["events"]))

    async def test_events_wrong_token_401(self):
        raw = b"GET /api/events?since=0 HTTP/1.1\r\nX-Dsh-Token: nope\r\n\r\n"
        resp = await self.raw_roundtrip(raw)
        self.assertIn(b"401 Unauthorized", resp.split(b"\r\n")[0])

    async def test_keep_alive_two_requests_one_connection(self):
        reader, writer = await asyncio.open_connection(*self.addr)

        async def one(raw):
            writer.write(raw)
            await writer.drain()
            data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            head, _, rest = data.partition(b"\r\n\r\n")
            length = 0
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":")[1].strip())
            if length:
                rest += await asyncio.wait_for(reader.readexactly(length - len(rest)), 10)
            return head, rest

        body = json.dumps({"token": "wrong", "method": "ping"}).encode()
        head1, _ = await one(
            b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body
        )
        self.assertIn(b"keep-alive", head1.lower())
        head2, body2 = await one(b"GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"200 OK", head2.split(b"\r\n")[0])
        self.assertTrue(json.loads(body2)["ok"])
        writer.close()

    async def test_chunked_upload_end_to_end(self):
        payload = json.dumps({"token": "wrong", "method": "ping"}).encode()
        chunked = b"%x\r\n%s\r\n0\r\n\r\n" % (len(payload), payload)
        raw = (
            b"POST /api/rpc HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n" + chunked
        )
        resp = await self.raw_roundtrip(raw)
        self.assertIn(b"401 Unauthorized", resp.split(b"\r\n")[0])

    async def test_bad_request_closes_connection(self):
        resp = await self.raw_roundtrip(
            b"POST /api/rpc HTTP/1.1\r\nContent-Length: abc\r\n\r\n",
            read_until_close=True,
        )
        self.assertIn(b"400 Bad Request", resp.split(b"\r\n")[0])
        self.assertIn(b"Connection: close", resp)

    async def test_hammering_auth_closes_connection(self):
        reader, writer = await asyncio.open_connection(*self.addr)
        body = json.dumps({"token": "wrong", "method": "ping"}).encode()
        req = b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body
        saw_close = False
        for _ in range(gw.AUTH_FAILURES_LIMIT + 2):
            writer.write(req)
            await writer.drain()
            try:
                data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            except asyncio.IncompleteReadError:
                saw_close = True
                break
            head = data.split(b"\r\n\r\n")[0]
            length = 0
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":")[1].strip())
            if length:
                await asyncio.wait_for(reader.readexactly(length), 10)
            if b"Connection: close" in head:
                saw_close = True
                break
        writer.close()
        self.assertTrue(saw_close)

    async def test_static_index_served(self):
        resp = await self.raw_roundtrip(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        self.assertIn(b"text/html", resp)

    async def test_unknown_path_404(self):
        resp = await self.raw_roundtrip(b"GET /api/nope HTTP/1.1\r\n\r\n")
        self.assertIn(b"404 Not Found", resp.split(b"\r\n")[0])


class TestDraftSync(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gw = make_gateway()
        self.server = await asyncio.start_server(
            lambda r, w: gw.handle_http(r, w, self.gw), "127.0.0.1", 0
        )
        self.port = self.server.sockets[0].getsockname()[1]
        self.addr = ("127.0.0.1", self.port)
        self.tok = self.gw.cfg["gatewayToken"]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def rpc(self, method, params, token=None):
        body = json.dumps({"token": token or self.tok, "method": method, "params": params}).encode()
        raw = b"POST /api/rpc HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body
        reader, writer = await asyncio.open_connection(*self.addr)
        writer.write(raw)
        await writer.drain()
        data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        head, _, rest = data.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1].strip())
        while len(rest) < length:
            rest += await asyncio.wait_for(reader.readexactly(length - len(rest)), 10)
        writer.close()
        return head, json.loads(rest)

    def draft_events(self):
        return [e for e in self.gw.events if e["type"] == "draft"]

    async def test_update_then_get_roundtrip(self):
        head, body = await self.rpc("session.updateDraft", {
            "sessionId": "s1", "text": "привет из поля", "deviceId": "dev-1",
        })
        self.assertIn(b"200 OK", head.split(b"\r\n")[0])
        self.assertTrue(body["ok"])
        self.assertTrue(body["result"]["saved"])

        head, body = await self.rpc("session.getDraft", {"sessionId": "s1"})
        self.assertIn(b"200 OK", head.split(b"\r\n")[0])
        self.assertEqual(body["result"]["text"], "привет из поля")
        self.assertEqual(body["result"]["origin"], "dev-1")
        self.assertGreater(body["result"]["ts"], 0)

    async def test_get_unknown_session_is_empty(self):
        head, body = await self.rpc("session.getDraft", {"sessionId": "nope"})
        self.assertIn(b"200 OK", head.split(b"\r\n")[0])
        self.assertEqual(body["result"]["text"], "")

    async def test_update_without_session_400(self):
        head, body = await self.rpc("session.updateDraft", {"text": "x"})
        self.assertIn(b"400 Bad Request", head.split(b"\r\n")[0])
        self.assertFalse(body["ok"])

    async def test_update_wrong_token_401(self):
        head, body = await self.rpc("session.updateDraft",
                                    {"sessionId": "s1", "text": "x"}, token="wrong-token-000000")
        self.assertIn(b"401 Unauthorized", head.split(b"\r\n")[0])

    async def test_update_pushes_draft_event(self):
        await self.rpc("session.updateDraft", {
            "sessionId": "s1", "text": "текст", "deviceId": "dev-9",
        })
        evs = self.draft_events()
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["data"]["sessionId"], "s1")
        self.assertEqual(evs[0]["data"]["text"], "текст")
        self.assertEqual(evs[0]["data"]["origin"], "dev-9")

    async def test_non_string_text_becomes_empty(self):
        await self.rpc("session.updateDraft", {"sessionId": "s2", "text": None})
        head, body = await self.rpc("session.getDraft", {"sessionId": "s2"})
        self.assertEqual(body["result"]["text"], "")

    async def test_text_capped_at_10000(self):
        await self.rpc("session.updateDraft", {"sessionId": "s3", "text": "x" * 20000})
        head, body = await self.rpc("session.getDraft", {"sessionId": "s3"})
        self.assertEqual(len(body["result"]["text"]), 10000)

    async def test_drafts_map_stays_bounded(self):
        for i in range(80):
            await self.rpc("session.updateDraft", {"sessionId": "s%d" % i, "text": "t"})
        self.assertLessEqual(len(self.gw.drafts), 64)

    async def test_startturn_failure_keeps_draft(self):
        # bridge is down -> startTurn fails -> the draft must survive
        await self.rpc("session.updateDraft", {"sessionId": "s1", "text": "черновик"})
        head, _ = await self.rpc("session.startTurn", {"sessionId": "s1", "content": "го"})
        self.assertIn(b"502 Bad Gateway", head.split(b"\r\n")[0])
        head, body = await self.rpc("session.getDraft", {"sessionId": "s1"})
        self.assertEqual(body["result"]["text"], "черновик")

    async def test_clear_draft_unit(self):
        g = make_gateway()
        g.set_draft("s1", "abc", "dev")
        self.assertEqual(g.get_draft("s1")["text"], "abc")
        g.clear_draft("s1")
        self.assertEqual(g.get_draft("s1")["text"], "")
        # clearing absent draft: no crash, no duplicate events
        g.clear_draft("s1")
        clears = [e for e in g.events if e["type"] == "draft" and e["data"]["text"] == ""]
        self.assertEqual(len(clears), 1)


if __name__ == "__main__":
    unittest.main()
