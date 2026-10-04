#!/usr/bin/env node
/**
 * Сквозной смоук HTTP-канала нативного плагина (dsh-phone-bridge web-half).
 *
 * Проверяет ровно тот путь, которым телефон живёт без моста Agents Anywhere:
 *   hello -> health(bridgeChannel=plugin) -> long-poll команд -> ответ через
 *   ingest(type=result) -> данные видны в event-feed -> RPC телефона
 *   (session.getState) уходит в плагин и возвращается обратно.
 *
 * Запуск: node smoke_plugin_channel.cjs
 * Окружение: SMOKE_BASE (http://127.0.0.1:8460), SMOKE_TOKEN (токен узла).
 * Выход: 0 - всё совпало, 1 - провал (сообщение в stderr).
 */
"use strict";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8460";
const TOKEN = process.env.SMOKE_TOKEN || "";

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("ok   - " + name);
  } else {
    failures++;
    console.log("FAIL - " + name + (extra === undefined ? "" : " | " + JSON.stringify(extra)));
  }
}

async function jfetch(path, opts) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* не-json ответ */ }
  return { status: res.status, body };
}

async function get(path) {
  return jfetch(path, { method: "GET", headers: { "x-dsh-token": TOKEN } });
}

async function post(path, payload) {
  return jfetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-token": TOKEN },
    body: JSON.stringify(payload),
  });
}

async function ingest(type, data) {
  return post("/api/bridge/ingest", { token: TOKEN, type, data });
}

async function poll(wait) {
  return post("/api/bridge/poll", { token: TOKEN, pluginId: "smoke", wait });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!TOKEN) {
    console.error("SMOKE_TOKEN не задан");
    process.exit(1);
  }

  // 0. Узел жив и отвечает на health.
  const h0 = await get("/api/health");
  check("health отвечает", h0.status === 200 && h0.body && h0.body.ok !== false, h0.body);

  // 1. Чужой токен не проходит: ingest обязан отдать 401.
  const bad = await post("/api/bridge/ingest", { token: "неверный", type: "hello", data: {} });
  check("ingest с чужим токеном отклонён (401)", bad.status === 401, { status: bad.status });

  // 2. Рукопожатие плагина.
  const hello = await ingest("hello", {
    version: 2,
    source: "smoke-test",
    transport: "http-push",
    pluginId: "smoke",
    capabilities: { runtime: "dsh", revision: 5, capabilities: [] },
  });
  check("hello принят", hello.status === 200 && hello.body && hello.body.ok === true, hello.body);

  // 3. Узел считает канал плагина живым и основным (TCP-моста в смоуке нет).
  const h1 = await get("/api/health");
  const pb = (h1.body && h1.body.pluginBridge) || {};
  check("health: bridgeChannel=plugin", h1.body && h1.body.bridgeChannel === "plugin", h1.body && h1.body.bridgeChannel);
  check("health: pluginBridge.connected", pb.connected === true, pb);
  check("health: pluginBridge.alive", pb.alive === true, pb);
  check("health: source=smoke-test", pb.source === "smoke-test", pb.source);
  check("health: version=2", pb.version === 2, pb.version);

  // 4. Long-poll отдаёт команду, которую узел сам поставил в очередь
  //    (poll_loop шлёт session.list, пока канал жив).
  const p1 = await poll(6);
  const cmds = (p1.body && p1.body.commands) || [];
  check("poll вернул команды", p1.status === 200 && cmds.length > 0, { status: p1.status, count: cmds.length });
  const listCmd = cmds.find((c) => c.method === "session.list");
  check("среди команд есть session.list", !!listCmd, cmds.map((c) => c.method));

  // 5. Отвечаем на все полученные команды как плагин.
  const fakeSessions = [
    {
      runtime: "dsh",
      sessionId: "sess_dsh_smoke0000000000000001",
      externalSessionId: "smoke-ext-1",
      title: "Смоук-сессия",
      cwd: "C:/smoke",
      orderingTime: Date.now(),
      metadata: { live: true, persisted: true, readOnly: false },
    },
  ];
  for (const c of cmds) {
    const result = c.method === "session.list" ? { sessions: fakeSessions, nextCursor: null } : { ok: true };
    await ingest("result", { id: c.id, ok: true, result });
  }
  check("ответы на команды отправлены", true);

  // 6. Ответ дошёл: узел сложил сессии в event-feed, и они видны телефону.
  let sawSessions = false;
  for (let i = 0; i < 40 && !sawSessions; i++) {
    const ev = await get("/api/events?since=0&had=1");
    const items = (ev.body && (ev.body.events || ev.body.items)) || [];
    sawSessions = items.some(
      (e) => e && e.type === "sessions" && JSON.stringify(e.data || {}).includes("Смоук-сессия")
    );
    if (!sawSessions) await sleep(250);
  }
  check("сессии из ответа плагина попали в event-feed", sawSessions);

  // 7. RPC телефона идёт через тот же канал: session.getState уходит в очередь,
  //    мы отвечаем, узел возвращает результат вызывающему.
  const rpcPromise = post("/api/rpc", {
    token: TOKEN,
    method: "session.getState",
    params: { sessionId: fakeSessions[0].sessionId },
  });
  const p2 = await poll(6);
  const stateCmd = ((p2.body && p2.body.commands) || []).find((c) => c.method === "session.getState");
  check("RPC телефона породил команду session.getState", !!stateCmd, (p2.body && p2.body.commands || []).map((c) => c.method));
  if (stateCmd) {
    await ingest("result", {
      id: stateCmd.id,
      ok: true,
      result: { runtime: "dsh", sessionId: stateCmd.params.sessionId, status: "idle", sourceState: { availability: "available" } },
    });
  }
  const rpc = await rpcPromise;
  check("RPC вернул ok", rpc.status === 200 && rpc.body && rpc.body.ok === true, rpc.body);
  check("RPC вернул status=idle", rpc.body && rpc.body.result && rpc.body.result.status === "idle", rpc.body);

  // 8. Метрики канала: очередь разобрана, потерь нет, rtt измерен.
  const h2 = await get("/api/health");
  const pb2 = (h2.body && h2.body.pluginBridge) || {};
  check("очередь команд пуста", pb2.queue === 0, pb2);
  check("нет брошенных команд", pb2.dropped === 0, pb2);
  check("rtt измерен", typeof pb2.rttMs === "number" && pb2.rttMs >= 0, pb2.rttMs);

  // 9. Ошибка плагина пробрасывается вызывающему как ошибка, а не как пустой ok.
  const rpcErrPromise = post("/api/rpc", {
    token: TOKEN,
    method: "session.getSnapshot",
    params: { sessionId: fakeSessions[0].sessionId },
  });
  const p3 = await poll(6);
  const snapCmd = ((p3.body && p3.body.commands) || []).find((c) => c.method === "session.getSnapshot");
  check("unsupported-метод дошёл до плагина", !!snapCmd, (p3.body && p3.body.commands || []).map((c) => c.method));
  if (snapCmd) {
    await ingest("result", { id: snapCmd.id, ok: false, error: "unsupported_method:session.getSnapshot" });
  }
  const rpcErr = await rpcErrPromise;
  check("ошибка плагина вернулась как 502", rpcErr.status === 502, { status: rpcErr.status });
  check("текст ошибки сохранён", rpcErr.body && String(rpcErr.body.error || "").includes("unsupported_method"), rpcErr.body);

  console.log(failures === 0 ? "SMOKE OK" : "SMOKE FAILED: " + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("смоук упал с исключением:", e && e.message);
  process.exit(1);
});
