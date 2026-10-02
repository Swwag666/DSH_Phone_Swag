"""
dsh-phone gateway: exposes the local DSH bridge (raw TCP JSON-RPC) to a phone
over plain HTTP + long-poll JSON, auth'd by a gateway token. Runs with stdlib only.

Transport to the phone is Tailscale (WireGuard already encrypts), so plain HTTP on
the tailnet/bound interface is fine; the gateway token gates every mutating call.

Run:  python gateway.py            (config auto-created next to this file)
URLs (phone, over Tailscale):
  GET  /                     PWA shell (open, no token needed)
  GET  /api/health           liveness + bridge status
  POST /api/rpc              {token,method,params} -> whitelisted bridge call
  GET  /api/events?since=..  long-poll: {ts, events:[...]} (token required)

Auth: the token rides in the JSON body (/api/rpc, /api/watch, /api/upload) or,
preferred, in the X-Dsh-Token header on any endpoint - the header form keeps
the key out of query strings, proxies and browser history.

The connection layer speaks HTTP/1.1 keep-alive (honouring Connection headers),
Content-Length and chunked request bodies, and `Expect: 100-continue`.
"""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
import uuid
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
WEB = os.path.join(HERE, "web")

DEFAULT_CONFIG = {
    "listenHost": "0.0.0.0",
    "listenPort": 8460,
    "gatewayToken": "",
    "bridgeEndpointPath": os.path.expanduser(
        "~/.dsh/agents-anywhere/bridge/endpoint.json"
    ),
    "connectorId": "dsh-phone-gateway",
    "pollSeconds": 1.0,
    "eventBufferMax": 400,
    "attachmentStagingPath": os.path.expanduser(
        "~/.dsh/agents-anywhere/bridge/attachments/staging"
    ),
    "maxAttachmentBytes": 50 * 1024 * 1024,
    "stagingRetentionSecs": 7 * 86400,
    "allowedIps": [],
}

# Request guard rails: header count/size and body size caps so a single
# connection cannot balloon the process. 80 MiB mirrors the Rust node's
# DefaultBodyLimit (base64 of a 50 MiB upload is ~67 MiB).
MAX_HEADER_LINES = 100
MAX_HEADER_BYTES = 64 * 1024
MAX_BODY_BYTES = 80 * 1024 * 1024
# Keep-alive guard rails: cap requests per connection (re-cycle), and close
# the connection after too many failed token attempts (anti-hammering).
MAX_REQS_PER_CONN = 1000
AUTH_FAILURES_LIMIT = 10
# Preferred auth header; the JSON body / query form stays as a fallback.
TOKEN_HEADER = "x-dsh-token"


def token_ok(got, want):
    """Constant-time token check; empty stored token never matches."""
    if not want or not isinstance(got, str):
        return False
    return hmac.compare_digest(got.encode("utf-8"), want.encode("utf-8"))


def allow_ip(allowed, ip):
    """Empty allowlist = allow all. Loopback is always allowed.
    Entries: exact IPv4/IPv6 or CIDR (e.g. "100.75.97.90", "100.64.0.0/10")."""
    if ip is None or ip.is_loopback:
        return True
    if not allowed:
        return True
    for entry in allowed:
        e = str(entry).strip()
        if not e:
            continue
        try:
            if "/" in e:
                if ip in ipaddress.ip_network(e, strict=False):
                    return True
            elif ip == ipaddress.ip_address(e):
                return True
        except ValueError:
            continue
    return False


class BadHttpRequest(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


RPC_WHITELIST = {
    "ping",
    "workspace.list",
    "session.list",
    "session.getSnapshot",
    "session.getState",
    "session.getNotices",
    "session.startTurn",
    "session.createAndStart",
    "session.interrupt",
    "session.updateSelections",
    "session.respondInteraction",
    "catalog.listModels",
    "catalog.listPermissions",
    "catalog.listAgentPresets",
    "runtime.getCapabilities",
    "runtime.getConfig",
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}


class Bridge:
    """One authenticated connection to the DSH bridge (newline-delimited JSON-RPC)."""

    def __init__(self, endpoint_path, connector_id):
        self.endpoint_path = endpoint_path
        self.connector_id = connector_id
        self.reader = None
        self.writer = None
        self._pending = {}
        self._req = 0
        self._loop = asyncio.get_running_loop()
        self.connected = False
        self.on_notify = None

    async def _send(self, obj):
        self.writer.write(
            json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            + b"\n"
        )
        await self.writer.drain()

    async def request(self, method, params=None, timeout=30.0):
        if not self.connected:
            raise RuntimeError("bridge_disconnected")
        self._req += 1
        rid = f"gw-{self._req}"
        fut = self._loop.create_future()
        self._pending[rid] = fut
        await self._send(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        )
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def connect(self):
        for _ in range(2):
            try:
                ep = json.load(open(self.endpoint_path, encoding="utf-8"))
                # Bridge allows frames up to ~8 MiB, but asyncio's default
                # StreamReader limit is 64 KiB — a large getSnapshot would
                # raise LimitOverrun and silently kill the whole connection.
                # Raise the read buffer to 32 MiB so fat frames read cleanly.
                self.reader, self.writer = await asyncio.open_connection(
                    ep["host"], ep["port"], limit=32 * 1024 * 1024
                )
                # Start the reader BEFORE initialize: responses resolve futures here.
                self._reader_task = asyncio.create_task(self.read_loop())
                init = await self.request_raw_initialize(ep["token"])
                ident = init.get("identity", {})
                if ident.get("runtime") != "dsh":
                    raise RuntimeError("bad identity")
                self.connected = True
                return True
            except Exception as exc:
                await self._close()
                await asyncio.sleep(1.0)
                last = exc
        raise last

    async def request_raw_initialize(self, token):
        self._req += 1
        rid = f"init-{self._req}"
        fut = self._loop.create_future()
        self._pending[rid] = fut
        await self._send(
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "initialize",
                "params": {
                    "authToken": token,
                    "protocolVersion": "1.0",
                    "runtime": "dsh",
                    "connectorId": self.connector_id,
                    "sessionNamespace": self.connector_id,
                    "clientInfo": {"name": "dsh-phone-gateway", "version": "0.1.0"},
                },
            }
        )
        try:
            return await asyncio.wait_for(fut, 15)
        finally:
            self._pending.pop(rid, None)

    async def read_loop(self):
        rdr = self.reader
        try:
            while True:
                line = await rdr.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8"))
                except Exception:
                    continue
                if msg.get("jsonrpc") != "2.0":
                    continue
                if "id" in msg and ("result" in msg or "error" in msg):
                    fut = self._pending.get(msg["id"])
                    if fut and not fut.done():
                        if "error" in msg:
                            fut.set_exception(RuntimeError(json.dumps(msg["error"])))
                        else:
                            fut.set_result(msg["result"])
                    continue
                # JSON-RPC notification: route to the sync-feed handler.
                if "method" in msg and "id" not in msg and self.on_notify:
                    try:
                        self.on_notify(msg)
                    except Exception:
                        pass
        except Exception:
            pass
        finally:
            if self.reader is rdr:
                self.connected = False
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(RuntimeError("bridge_closed"))
                self._pending.clear()

    async def _close(self):
        self.connected = False
        w = self.writer
        if w:
            self.writer = None
            try:
                w.close()
            except Exception:
                pass
        r = getattr(self, "reader", None)
        if r:
            self.reader = None
            try:
                r.feed_eof()
            except Exception:
                pass
        t = getattr(self, "_reader_task", None)
        if t and t is not asyncio.current_task():
            t.cancel()


class Gateway:
    def __init__(self, cfg):
        self.cfg = cfg
        self.bridge = Bridge(cfg["bridgeEndpointPath"], cfg["connectorId"])
        self.bridge.on_notify = self._on_bridge_notify
        self.events = []  # [{ts, type, data}]
        self.events_ts = time.time()
        self.sessions = []
        self.sessions_hash = None
        self.watched = {}  # sessionId -> {"known_ids": set, "lastState": dict}
        self.clients = set()  # long-poll waiters: {future}
        self._refresh_pending = False
        self._cand = {}  # sessionId -> candidate from sync inventory.complete

    def push_event(self, type_, data):
        self.events.append({"ts": time.time(), "type": type_, "data": data})
        if len(self.events) > self.cfg["eventBufferMax"]:
            self.events = self.events[-self.cfg["eventBufferMax"] :]
        # wake long-pollers
        for fut in list(self.clients):
            if not fut.done():
                fut.set_result(None)

    # ---------------- sync feed (live notifications from the bridge) ----------------
    def _on_bridge_notify(self, msg):
        try:
            params = msg.get("params") or {}
            ops = params.get("operations")
            if ops is not None and params.get("streamId") and params.get("batchSeq") is not None:
                asyncio.create_task(self._ack_sync(params["streamId"], params["batchSeq"]))
                refresh = False
                for op in ops:
                    kind = op.get("kind")
                    if kind == "notifications":
                        for n in op.get("notifications") or []:
                            m = n.get("method")
                            p = n.get("params") or {}
                            if m == "session.inventory.complete":
                                for c in p.get("sessions") or []:
                                    if c.get("sessionId"):
                                        self._cand[c["sessionId"]] = c
                                refresh = True
                            elif m == "timeline.itemUpsert":
                                sid = p.get("sessionId")
                                it = p.get("item")
                                if sid and it:
                                    self.push_event("items", {"sessionId": sid, "items": [it]})
                            elif m in ("session.turnEnded", "session.state", "session.meta.upsert", "session.capability.updated"):
                                refresh = True
                    elif kind == "timeline.upsert":
                        sid = op.get("sessionId")
                        its = op.get("items") or []
                        if sid and its:
                            self.push_event("items", {"sessionId": sid, "items": its})
                if refresh:
                    asyncio.create_task(self._debounced_refresh_sessions())
        except Exception:
            pass

    async def _ack_sync(self, stream_id, batch_seq):
        try:
            await self.bridge.request(
                "runtime.sync.ack", {"streamId": stream_id, "batchSeq": batch_seq}, timeout=15
            )
        except Exception:
            pass

    async def _debounced_refresh_sessions(self):
        if self._refresh_pending:
            return
        self._refresh_pending = True
        try:
            await asyncio.sleep(0.8)
        finally:
            self._refresh_pending = False
        await self._refresh_sessions()

    # ---------------- bridge supervision ----------------
    async def bridge_loop(self):
        while True:
            try:
                await self.bridge.connect()
                self.push_event("bridge", {"status": "connected"})
                # Subscribe to the live sync feed: gives us session.inventory.complete
                # (full list incl. the actively-working session) and timeline.itemUpsert
                # (live item stream). Polling stays as a fallback.
                try:
                    await self.bridge.request("runtime.sync.subscribe", {}, timeout=15)
                except Exception:
                    pass
                while self.bridge.connected:
                    await asyncio.sleep(1.0)
                self.push_event("bridge", {"status": "disconnected"})
            except Exception as exc:
                self.push_event("bridge", {"status": "disconnected", "error": str(exc)})
            await asyncio.sleep(3.0)

    async def _once_connected(self):
        # wait until first successful connect
        while not self.bridge.connected:
            await asyncio.sleep(0.2)

    # ---------------- polling ----------------
    async def poll_loop(self):
        last_bridge = None
        while True:
            await asyncio.sleep(self.cfg["pollSeconds"])
            if not self.bridge.connected:
                continue
            if last_bridge is not True:
                last_bridge = True
                await self._refresh_sessions()
            else:
                await self._refresh_sessions()
            for sid in list(self.watched):
                if not self.bridge.connected:
                    break
                try:
                    await self._refresh_watched(sid)
                except Exception:
                    pass

    async def _refresh_sessions(self):
        try:
            r = await self.bridge.request("session.list", {"limit": 1000}, timeout=20)
            sessions = list(r.get("sessions", []))
            have = {s.get("sessionId") for s in sessions if s.get("sessionId")}
            # Merge in live candidates the sync feed reported. session.list can
            # omit the session that is actively working right now (it is not
            # persisted yet); inventory.complete sees it via native.candidates().
            for sid, c in self._cand.items():
                if sid in have:
                    continue
                ss = c.get("sourceState") or {}
                sessions.append({
                    "sessionId": sid,
                    "externalSessionId": c.get("externalSessionId"),
                    "title": None,
                    "cwd": ss.get("cwd"),
                    "orderingTime": None,
                    "metadata": {"live": bool(ss.get("live", True)), "candidate": True},
                })
            h = json.dumps(
                [
                    [s.get("sessionId"), s.get("title"), s.get("cwd"), s.get("orderingTime"), s.get("metadata", {}).get("live")]
                    for s in sessions
                ],
                ensure_ascii=False,
            )
            if h != self.sessions_hash:
                self.sessions = sessions
                self.sessions_hash = h
                self.push_event("sessions", {"sessions": sessions})
        except Exception:
            pass

    async def _refresh_watched(self, sid):
        if not self.bridge.connected:
            return
        st = await self.bridge.request("session.getState", {"sessionId": sid}, timeout=15)
        w = self.watched[sid]
        sel = st.get("selections") if isinstance(st.get("selections"), dict) else {}
        key = json.dumps(
            [
                st.get("status"),
                (sel.get("model") or {}).get("id") if isinstance(sel.get("model"), dict) else None,
                (sel.get("permission") or {}).get("id") if isinstance(sel.get("permission"), dict) else None,
            ],
            ensure_ascii=False,
        )
        if key != w.get("lastStateKey"):
            w["lastStateKey"] = key
            self.push_event("state", {"sessionId": sid, "state": st})
        # stream tail while working, and once after any state event
        status = st.get("status")
        if status in ("working", "waiting_approval"):
            snap = await self.bridge.request(
                "session.getSnapshot", {"sessionId": sid, "limit": 150}, timeout=20
            )
            fresh = []
            for it in snap.get("items", []):
                iid = it.get("id")
                if iid and iid not in w["known_ids"]:
                    w["known_ids"].add(iid)
                    fresh.append(it)
            if len(w["known_ids"]) > 2000:
                w["known_ids"] = set(
                    sorted(w["known_ids"])[-1000:]
                )  # crude retention
            if fresh:
                self.push_event("items", {"sessionId": sid, "items": fresh})

    def watch(self, sid):
        if sid not in self.watched:
            self.watched[sid] = {"known_ids": set(), "lastStateKey": None}

    def unwatch(self, sid):
        self.watched.pop(sid, None)


def _http_response(status, body_bytes, ctype="application/json; charset=utf-8", extra=None, keep=False):
    headers = {
        "Content-Type": ctype,
        "Content-Length": str(len(body_bytes)),
        "Connection": "keep-alive" if keep else "close",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
    }
    if extra:
        headers.update(extra)
    head = f"HTTP/1.1 {status}\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n"
    return head.encode("latin-1") + body_bytes


def _json(status, obj, keep=False):
    return _http_response(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), keep=keep)


async def read_chunked(reader):
    """Decode a chunked request body, enforcing the global body-size cap."""
    body = bytearray()
    while True:
        line = await asyncio.wait_for(reader.readline(), 15)
        if not line:
            raise BadHttpRequest("400 Bad Request", "truncated chunked body")
        raw = line.split(b";")[0].strip()
        if not raw:
            raise BadHttpRequest("400 Bad Request", "bad chunk size")
        try:
            size = int(raw, 16)
        except ValueError:
            raise BadHttpRequest("400 Bad Request", "bad chunk size")
        if size == 0:
            # trailers until the blank line (we read and discard them)
            while True:
                t = await asyncio.wait_for(reader.readline(), 15)
                if not t or t in (b"\r\n", b"\n"):
                    break
            return bytes(body)
        if len(body) + size > MAX_BODY_BYTES:
            raise BadHttpRequest("413 Payload Too Large", "body too large")
        body += await asyncio.wait_for(reader.readexactly(size), 60)
        # chunk data is followed by CRLF (lenient about a lone LF)
        term = await asyncio.wait_for(reader.readexactly(1), 15)
        if term == b"\r":
            term2 = await asyncio.wait_for(reader.readexactly(1), 15)
            if term2 != b"\n":
                raise BadHttpRequest("400 Bad Request", "bad chunk terminator")
        elif term != b"\n":
            raise BadHttpRequest("400 Bad Request", "bad chunk terminator")


async def read_request_head(reader, writer=None):
    """Parse one request off the wire.

    Returns (method, path, query, headers, body, keep_alive) or None on a clean
    EOF. Raises BadHttpRequest (status + message) on protocol garbage.
    keep_alive follows HTTP/1.1 semantics plus the Connection header.
    """
    first = await asyncio.wait_for(reader.readline(), 15)
    if not first:
        return None
    if len(first) > MAX_HEADER_BYTES:
        raise BadHttpRequest("431 Request Header Fields Too Large", "request line too large")
    parts = first.decode("latin-1").split()
    if len(parts) < 2:
        return None
    method, target = parts[0], parts[1]
    version = parts[2] if len(parts) > 2 else "HTTP/1.0"
    headers = {}
    total_header_bytes = 0
    header_count = 0
    last_key = None
    while True:
        line = await asyncio.wait_for(reader.readline(), 15)
        if not line or line in (b"\r\n", b"\n"):
            break
        header_count += 1
        total_header_bytes += len(line)
        if header_count > MAX_HEADER_LINES or total_header_bytes > MAX_HEADER_BYTES:
            raise BadHttpRequest("431 Request Header Fields Too Large", "too many headers")
        text = line.decode("latin-1").rstrip("\r\n")
        if text[:1] in (" ", "\t") and last_key:
            # obs-fold continuation: append to the previous header value
            headers[last_key] = headers[last_key] + " " + text.strip()
            continue
        k, _, v = text.partition(":")
        k = k.strip().lower()
        if not k:
            continue
        headers[k] = v.strip()
        last_key = k
    te = headers.get("transfer-encoding", "").lower()
    te_tokens = [t.strip() for t in te.split(",") if t.strip()]
    if te_tokens and te_tokens != ["chunked"]:
        raise BadHttpRequest("501 Not Implemented", "unsupported transfer-encoding")
    if te_tokens:
        # Transfer-Encoding wins over Content-Length per RFC 7230
        body = await read_chunked(reader)
    else:
        try:
            length = int(headers.get("content-length", "0") or "0")
        except ValueError:
            raise BadHttpRequest("400 Bad Request", "bad content-length")
        if length < 0:
            raise BadHttpRequest("400 Bad Request", "bad content-length")
        if length > MAX_BODY_BYTES:
            raise BadHttpRequest("413 Payload Too Large", "body too large")
        if (
            length
            and writer is not None
            and headers.get("expect", "").lower() == "100-continue"
        ):
            writer.write(b"HTTP/1.1 100 Continue\r\n\r\n")
            await writer.drain()
        body = b""
        if length:
            body = await asyncio.wait_for(reader.readexactly(length), 60)
    conn = headers.get("connection", "").lower()
    if "close" in conn:
        keep = False
    elif version >= "HTTP/1.1":
        keep = True
    elif "keep-alive" in conn:
        keep = True
    else:
        keep = False
    parsed = urlparse(target)
    return method, parsed.path, {k: v[0] for k, v in parse_qs(parsed.query).items()}, headers, body, keep


def serve_static(path, keep=False):
    full = os.path.normpath(os.path.join(WEB, path.lstrip("/") or "index.html"))
    if not full.startswith(WEB + os.sep):
        return _http_response("403 Forbidden", b"forbidden")
    if not os.path.isfile(full):
        full = os.path.join(WEB, "index.html")
    data = open(full, "rb").read()
    ext = os.path.splitext(full)[1].lower()
    ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
    return _http_response("200 OK", data, ctype, keep=keep)


def _token_from(headers, q, j):
    """Header first, then JSON body, then query string."""
    t = headers.get(TOKEN_HEADER)
    if isinstance(t, str) and t:
        return t
    if isinstance(j, dict):
        t = j.get("token")
        if isinstance(t, str):
            return t
    t = q.get("token")
    return t if isinstance(t, str) else None


async def route(gw, method, path, q, headers, body, keep, conn):
    """Dispatch one parsed request. Returns (response_bytes, keep_alive)."""

    def fail(status, obj):
        return _json(status, obj, keep=keep), keep

    def auth_fail(status="401 Unauthorized", err="unauthorized"):
        conn["auth_failures"] = conn.get("auth_failures", 0) + 1
        forced_close = conn["auth_failures"] >= AUTH_FAILURES_LIMIT
        alive = keep and not forced_close
        return _json(status, {"ok": False, "error": err}, keep=alive), alive

    if method == "GET" and not path.startswith("/api"):
        return serve_static(path, keep=keep), keep
    if method == "GET" and path == "/api/health":
        return _json(
            "200 OK",
            {
                "ok": True,
                "bridge": "connected" if gw.bridge.connected else "disconnected",
                "tailscale": os.environ.get("TS_IP", ""),
                "time": time.time(),
            },
            keep=keep,
        ), keep
    if method == "POST" and path == "/api/rpc":
        try:
            j = json.loads(body.decode("utf-8"))
        except Exception:
            return fail("400 Bad Request", {"ok": False, "error": "bad json"})
        if not isinstance(j, dict):
            return fail("400 Bad Request", {"ok": False, "error": "bad json"})
        if not token_ok(_token_from(headers, q, j), gw.cfg["gatewayToken"]):
            return auth_fail()
        m = j.get("method")
        if m not in RPC_WHITELIST:
            return fail("403 Forbidden", {"ok": False, "error": "method_not_allowed"})
        params = j.get("params") or {}
        if m in ("session.startTurn", "session.createAndStart"):
            params = dict(params)
        if m == "session.startTurn" and "clientMessageId" not in params:
            params["clientMessageId"] = uuid.uuid4().hex
        try:
            result = await gw.bridge.request(m, params, timeout=120)
            return _json("200 OK", {"ok": True, "result": result}, keep=keep), keep
        except Exception as exc:
            return _json("502 Bad Gateway", {"ok": False, "error": str(exc)}, keep=keep), keep
    if method == "GET" and path == "/api/events":
        j = {}
        if body:
            try:
                j = json.loads(body.decode("utf-8"))
            except Exception:
                j = {}
        if not token_ok(_token_from(headers, q, j), gw.cfg["gatewayToken"]):
            return auth_fail()
        since = 0.0
        try:
            since = float(q.get("since", "0"))
        except Exception:
            pass
        had = bool(q.get("had", ""))
        out = [e for e in gw.events if e["ts"] > since]
        if not out and had:
            # long-poll only when there is nothing newer than `since`;
            # a first-time client (no `had`) gets its snapshot immediately.
            fut = asyncio.get_running_loop().create_future()
            gw.clients.add(fut)
            try:
                try:
                    await asyncio.wait_for(fut, 20)
                except asyncio.TimeoutError:
                    pass
            finally:
                gw.clients.discard(fut)
            out = [e for e in gw.events if e["ts"] > since]
        # ensure a first-time client gets the current sessions snapshot
        if not had:
            out.insert(0, {"ts": time.time(), "type": "sessions", "data": {"sessions": gw.sessions}})
        return _json("200 OK", {"ts": time.time(), "events": out}, keep=keep), keep
    if method == "POST" and path == "/api/watch":
        try:
            j = json.loads(body.decode("utf-8"))
        except Exception:
            j = {}
        if not isinstance(j, dict):
            j = {}
        if not token_ok(_token_from(headers, q, j), gw.cfg["gatewayToken"]):
            return auth_fail()
        sid = j.get("sessionId")
        if not sid:
            return fail("400 Bad Request", {"ok": False, "error": "no sessionId"})
        if j.get("unwatch"):
            gw.unwatch(sid)
        else:
            gw.watch(sid)
        return _json("200 OK", {"ok": True}, keep=keep), keep
    if method == "POST" and path == "/api/upload":
        try:
            j = json.loads(body.decode("utf-8"))
        except Exception:
            j = {}
        if not isinstance(j, dict):
            return fail("400 Bad Request", {"ok": False, "error": "bad json"})
        if not token_ok(_token_from(headers, q, j), gw.cfg["gatewayToken"]):
            return auth_fail()
        try:
            name = str(j.get("name") or "file")[:255]
            media = str(j.get("mediaType") or "application/octet-stream")
            data = j.get("data")
            if not isinstance(data, str):
                raise ValueError("data (base64) is required")
            raw = base64.b64decode(data)
            size = len(raw)
            if size < 1 or size > gw.cfg.get("maxAttachmentBytes", 50 * 1024 * 1024):
                raise ValueError("file size out of bounds")
            upload_id = secrets.token_hex(16)
            file_id = "file_" + uuid.uuid4().hex
            sha = hashlib.sha256(raw).hexdigest()
            stage = gw.cfg.get("attachmentStagingPath") or os.path.expanduser(
                "~/.dsh/agents-anywhere/bridge/attachments/staging"
            )
            os.makedirs(stage, exist_ok=True)
            dst = os.path.join(stage, upload_id)
            with open(dst, "wb") as fh:
                fh.write(raw)
            return _json(
                "200 OK",
                {
                    "ok": True,
                    "attachment": {
                        "fileId": file_id,
                        "uploadId": upload_id,
                        "name": name,
                        "mediaType": media,
                        "size": size,
                        "sha256": sha,
                    },
                },
                keep=keep,
            ), keep
        except Exception as exc:
            return fail("400 Bad Request", {"ok": False, "error": str(exc)})
    return _http_response("404 Not Found", b"not found", keep=keep), keep


async def handle_http(reader, writer, gw):
    conn = {"auth_failures": 0}
    try:
        peer = writer.get_extra_info("peername")
        peer_ip = None
        try:
            peer_ip = ipaddress.ip_address(peer[0]) if peer else None
        except ValueError:
            peer_ip = None
        if not allow_ip(gw.cfg.get("allowedIps") or [], peer_ip):
            writer.write(_json("403 Forbidden", {"ok": False, "error": "ip_not_allowed"}))
            await writer.drain()
            return
        served = 0
        while True:
            try:
                req = await read_request_head(reader, writer)
            except BadHttpRequest as exc:
                writer.write(_json(exc.status, {"ok": False, "error": exc.message}))
                await writer.drain()
                return
            if req is None:
                return
            method, path, q, headers, body, keep = req
            try:
                resp, keep = await route(gw, method, path, q, headers, body, keep, conn)
            except Exception as exc:
                resp = _json("500 Internal Server Error", {"ok": False, "error": str(exc)})
                keep = False
            writer.write(resp)
            await writer.drain()
            served += 1
            if not keep or served >= MAX_REQS_PER_CONN:
                return
    except Exception as exc:
        try:
            writer.write(_json("500 Internal Server Error", {"ok": False, "error": str(exc)}))
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def cleanup_staging(stage, retention_secs):
    """Delete staged uploads older than retention_secs. Returns removed count."""
    if not stage or not os.path.isdir(stage):
        return 0
    cutoff = time.time() - max(0, retention_secs)
    removed = 0
    for name in os.listdir(stage):
        p = os.path.join(stage, name)
        try:
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
                removed += 1
        except OSError:
            pass
    return removed


async def staging_cleanup_loop(cfg):
    stage = cfg.get("attachmentStagingPath")
    retention = cfg.get("stagingRetentionSecs", 7 * 86400)
    while True:
        try:
            n = cleanup_staging(stage, retention)
            if n:
                print(f"staging: purged {n} stale attachment(s)")
        except Exception:
            pass
        await asyncio.sleep(3600)


async def main():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        saved = json.load(open(CONFIG_PATH, encoding="utf-8"))
        cfg.update(saved)
    if not cfg.get("gatewayToken"):
        cfg["gatewayToken"] = secrets.token_urlsafe(24)
        json.dump(cfg, open(CONFIG_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    else:
        json.dump(cfg, open(CONFIG_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    if cfg.get("listenHost") in ("0.0.0.0", "::") and not cfg.get("allowedIps"):
        print("WARNING: listening on ALL interfaces with an empty IP allowlist.")
        print("         Any device on any network this PC joins can reach this port.")
        print('         Set allowedIps (e.g. ["100.64.0.0/10"]) in config.json to restrict.')

    gw = Gateway(cfg)
    server = await asyncio.start_server(
        lambda r, w: handle_http(r, w, gw), cfg["listenHost"], cfg["listenPort"]
    )
    print(f"dsh-phone gateway listening on {cfg['listenHost']}:{cfg['listenPort']}")
    print(f"gateway token: {cfg['gatewayToken']}")
    print(f"open in phone browser (over Tailscale): http://<pc-tailscale-ip>:{cfg['listenPort']}/")

    tasks = [
        asyncio.create_task(gw.bridge_loop()),
        asyncio.create_task(gw.poll_loop()),
        asyncio.create_task(staging_cleanup_loop(cfg)),
    ]
    async with server:
        await server.serve_forever()
    for t in tasks:
        t.cancel()


if __name__ == "__main__":
    asyncio.run(main())
