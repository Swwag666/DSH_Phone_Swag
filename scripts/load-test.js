// Нагрузочный прогон DSH-узла в роли «реальных людей».
// Симулирует N телефонов: long-poll событий с обрывами, rpc-вызовы (валидные,
// левые, без токена, с огромным телом), push-подписки которые копят состояние.
// Гоняется по loopback http :8461 - тот же axum-app и те же хабы/буферы, что и
// https :8460, но без TLS-оверхеда и без отключения проверки сертификатов.
//
// Запуск: node load-test.js [секунды_нагрузки] [число_воркеров]

"use strict";

const BASE = "http://127.0.0.1:8461";
const TOKEN = process.env.DSH_TOKEN || "";
if (!TOKEN) {
  console.error("нужен DSH_TOKEN");
  process.exit(2);
}

const DURATION = parseInt(process.argv[2] || "75", 10) * 1000;
const WORKERS = parseInt(process.argv[3] || "15", 10);

const stats = {
  events_ok: 0, events_aborted: 0, events_err: 0,
  rpc_ok: 0, rpc_403: 0, rpc_401: 0, rpc_err: 0,
  push_sub: 0, push_unsub: 0, push_err: 0,
  big_ok: 0, big_err: 0,
  lat_ms: [],
};
let stop = false;

function lat(ms) {
  stats.lat_ms.push(ms);
  if (stats.lat_ms.length > 5000) stats.lat_ms.shift();
}

async function j(method, path, body, headers, signal) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  lat(Date.now() - t0);
  return res;
}

// long-poll событий как телефон: держит соединение, часть обрывает досрочно
async function eventsWorker(i) {
  let since = 0;
  while (!stop) {
    const ac = new AbortController();
    const abortEarly = Math.random() < 0.35;
    const to = setTimeout(() => ac.abort(), 1000 + Math.random() * 4000);
    try {
      const res = await j("GET", `/api/events?since=${since}&had=1&token=${TOKEN}`, undefined, undefined, ac.signal);
      clearTimeout(to);
      if (res.ok) {
        stats.events_ok++;
        const data = await res.json();
        if (data && typeof data.ts === "number") since = data.ts;
      } else {
        stats.events_err++;
        await res.text().catch(() => {});
      }
    } catch (e) {
      clearTimeout(to);
      if (e && e.name === "AbortError") stats.events_aborted++;
      else stats.events_err++;
    }
    // небольшая пауза как у живого клиента между поллами
    await sleep(150 + Math.random() * 500);
  }
}

// rpc как телефон: пинг, списки, левый метод, без токена, огромное тело
async function rpcWorker(i) {
  const big = "x".repeat(200 * 1024); // 200KB черновик
  while (!stop) {
    const r = Math.random();
    try {
      if (r < 0.45) {
        const res = await j("POST", "/api/rpc", { token: TOKEN, method: "ping", params: {} });
        if (res.ok) stats.rpc_ok++; else stats.rpc_err++;
        await res.text().catch(() => {});
      } else if (r < 0.6) {
        const res = await j("POST", "/api/rpc", { token: TOKEN, method: "session.list", params: {} });
        if (res.ok) stats.rpc_ok++; else stats.rpc_err++;
        await res.text().catch(() => {});
      } else if (r < 0.72) {
        // метод вне whitelist -> 403
        const res = await j("POST", "/api/rpc", { token: TOKEN, method: "rm.rf", params: {} });
        if (res.status === 403) stats.rpc_403++; else stats.rpc_err++;
        await res.text().catch(() => {});
      } else if (r < 0.82) {
        // без токена -> 401
        const res = await j("POST", "/api/rpc", { method: "ping", params: {} });
        if (res.status === 401) stats.rpc_401++; else stats.rpc_err++;
        await res.text().catch(() => {});
      } else if (r < 0.92) {
        // огромное тело
        const res = await j("POST", "/api/rpc", { token: TOKEN, method: "session.updateDraft", params: { text: big } });
        if (res.ok) stats.big_ok++; else stats.big_err++;
        await res.text().catch(() => {});
      } else {
        // мусор вместо json
        const t0 = Date.now();
        const res = await fetch(BASE + "/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
        lat(Date.now() - t0);
        stats.rpc_err++;
        await res.text().catch(() => {});
      }
    } catch (e) {
      stats.rpc_err++;
    }
    await sleep(120 + Math.random() * 400);
  }
}

// push-подписки: телефон переподключается и каждый раз новый endpoint,
// отписывается редко -> если сервер не чистит, подписки копятся
let epCounter = 0;
const liveEndpoints = [];
async function pushWorker(i) {
  while (!stop) {
    try {
      if (Math.random() < 0.6) {
        const ep = `https://push.example.com/sub/${Date.now()}-${epCounter++}`;
        const res = await j("POST", "/api/push/subscribe", {
          token: TOKEN, endpoint: ep,
          p256dh: "BP" + "A".repeat(80), auth: "auth" + "B".repeat(20),
          device: "loadtest-" + i,
        });
        if (res.ok) { stats.push_sub++; liveEndpoints.push(ep); }
        else stats.push_err++;
        await res.text().catch(() => {});
      } else if (liveEndpoints.length && Math.random() < 0.5) {
        const ep = liveEndpoints.shift();
        const res = await j("POST", "/api/push/unsubscribe", { token: TOKEN, endpoint: ep });
        if (res.ok) stats.push_unsub++; else stats.push_err++;
        await res.text().catch(() => {});
      }
    } catch (e) {
      stats.push_err++;
    }
    await sleep(300 + Math.random() * 700);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0; }

async function main() {
  console.log(`нагрузка: ${WORKERS} воркеров x ${(DURATION / 1000).toFixed(0)}с на ${BASE}`);
  const workers = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(eventsWorker(i));
    workers.push(rpcWorker(i));
    if (i % 3 === 0) workers.push(pushWorker(i));
  }
  await sleep(DURATION);
  stop = true;
  // даём воркерам завершить текущие запросы
  await Promise.allSettled(workers);

  const s = stats.lat_ms.slice().sort((a, b) => a - b);
  const total = stats.events_ok + stats.events_aborted + stats.events_err +
    stats.rpc_ok + stats.rpc_403 + stats.rpc_401 + stats.rpc_err +
    stats.push_sub + stats.push_unsub + stats.push_err + stats.big_ok + stats.big_err;
  console.log("=== сводка ===");
  console.log(`всего запросов: ${total}`);
  console.log(`events: ok=${stats.events_ok} aborted=${stats.events_aborted} err=${stats.events_err}`);
  console.log(`rpc: ok=${stats.rpc_ok} 403=${stats.rpc_403} 401=${stats.rpc_401} err=${stats.rpc_err} big_ok=${stats.big_ok} big_err=${stats.big_err}`);
  console.log(`push: sub=${stats.push_sub} unsub=${stats.push_unsub} err=${stats.push_err} (неотписанных endpoint'ов осталось в клиенте: ${liveEndpoints.length})`);
  console.log(`latency ms: p50=${pct(s, 0.5)} p90=${pct(s, 0.9)} p99=${pct(s, 0.99)} max=${s[s.length - 1] || 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
