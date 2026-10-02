import asyncio, json, os, sys

ENDPOINT = os.path.expanduser("~/.dsh/agents-anywhere/bridge/endpoint.json")

async def main():
    ep = json.load(open(ENDPOINT, encoding="utf-8"))
    print("endpoint:", ep["host"], ep["port"], "pid", ep.get("pid"))
    reader, writer = await asyncio.open_connection(ep["host"], ep["port"])
    reqid = 0
    def req(method, params=None):
        nonlocal reqid
        reqid += 1
        rid = f"probe-{reqid}"
        writer.write((json.dumps({"jsonrpc":"2.0","id":rid,"method":method,"params":params or {}}, ensure_ascii=False, separators=(",",":"))+"\n").encode())
        return rid
    # initialize
    writer.write((json.dumps({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
        "authToken": ep["token"], "protocolVersion":"1.0","runtime":"dsh",
        "connectorId":"dsh-phone-gateway","sessionNamespace":"dsh-phone-gateway",
        "clientInfo":{"name":"dsh-phone-probe","version":"0.0.1"}}}, ensure_ascii=False, separators=(",",":"))+"\n").encode())
    await writer.drain()
    # read lines with timeout
    async def readline(timeout=15):
        line = await asyncio.wait_for(reader.readline(), timeout)
        return json.loads(line)
    init = await readline()
    print("initialize ->", json.dumps(init, ensure_ascii=False)[:400])
    for method in ["ping","workspace.list","runtime.getCapabilities","session.list"]:
        rid = req(method) if method != "session.list" else req("session.list", {"limit": 50})
        await writer.drain()
        resp = await readline()
        s = json.dumps(resp, ensure_ascii=False)
        print(f"\n== {method} ->", s[:600] + ("..." if len(s) > 600 else ""))
    # snapshot of first session
    lid = req("session.list", {"limit": 5})
    await writer.drain()
    resp = await readline()
    result = resp.get("result", {})
    sessions = result.get("sessions", [])
    if sessions:
        sid = sessions[0]["sessionId"]
        print("\nFirst session sessionId:", sid)
        rid = req("session.getSnapshot", {"sessionId": sid, "limit": 20})
        await writer.drain()
        snap = await readline()
        s = json.dumps(snap, ensure_ascii=False)
        print("getSnapshot ->", s[:700] + ("..." if len(s) > 700 else ""))
    writer.close()

asyncio.run(main())