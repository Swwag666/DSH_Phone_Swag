// Single version source for the SW side (S3). index.html loads assets with a
// "?v=N" query; this SW normalizes that query away when reading/writing the
// cache, so a version bump in HTML does not cause offline cache misses.
// The cache name itself is still versioned so activate can evict old entries (S1).
const APP_VERSION = "22";
const CACHE = "dsh-phone-v" + APP_VERSION;
// Canonical (unversioned) precache list - cached under these exact paths.
const ASSETS = ["/", "/app.js", "/md.js", "/itemrender.js", "/draftsync.js", "/style.css", "/manifest.json", "/icon.svg"];
const ASSET_SET = new Set(ASSETS);
// Whitelist of extra same-origin paths allowed into the runtime cache (S2).
const CACHEABLE_EXT = /\.(?:js|mjs|css|svg|png|jpe?g|gif|webp|avif|ico|json|webmanifest|woff2?|ttf|otf|map)$/i;
// Runtime-cache entry cap (excluding precached ASSETS) to bound growth (S2).
const MAX_EXTRA_ENTRIES = 50;

function isCacheablePath(pathname) {
  return ASSET_SET.has(pathname) || CACHEABLE_EXT.test(pathname);
}

// "/app.js?v=19" -> "/app.js" so any HTML version marker hits one cache entry (S3).
function normalizeUrl(url) {
  if (url.searchParams.has("v")) {
    const u = new URL(url.href);
    u.searchParams.delete("v");
    u.search = u.searchParams.toString() ? "?" + u.searchParams.toString() : "";
    return u.pathname + u.search;
  }
  return url.pathname + url.search;
}

// Install: fetch each asset individually; a missing asset no longer blocks
// activation of the whole SW (S4).
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((path) => {
        // Bust any intermediate HTTP cache; store under the canonical path.
        const fetchUrl = path === "/" ? "/" : path + "?v=" + APP_VERSION;
        return fetch(fetchUrl, { cache: "reload" })
          .then((res) => {
            if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
            return c.put(path, res);
          });
      })))
      .then((results) => {
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length) console.warn("sw: precache incomplete:", failed.map((r) => String(r.reason)));
      })
      .catch((err) => console.warn("sw: install cache error:", err))
      .then(() => self.skipWaiting())
  );
});

// Unchanged (S1): drop every cache but the current one, then claim clients.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Trim runtime-cached entries beyond the cap; precached ASSETS are never evicted (S2).
function pruneCache(c) {
  return c.keys().then((keys) => {
    const core = [];
    const extra = [];
    for (const k of keys) {
      let pathname;
      try { pathname = new URL(k.url).pathname; } catch (_) { continue; }
      if (ASSET_SET.has(pathname)) core.push(k); else extra.push(k);
    }
    const doomed = extra.slice(0, Math.max(0, extra.length - MAX_EXTRA_ENTRIES));
    if (!doomed.length) return;
    return Promise.all(doomed.map((k) => c.delete(k)));
  }).catch(() => {});
}

// network-first: never serve a stale app.js/style.css from cache.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  // S2: same-origin only - never cache cross-origin opaque responses.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // S2: whitelist instead of "cache every GET".
  if (!isCacheablePath(url.pathname)) return;
  const cacheKey = normalizeUrl(url); // S3
  const isNavigate = e.request.mode === "navigate";
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // S2: only cache successful basic responses - no 404/500, no opaque.
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE)
            .then((c) => c.put(cacheKey, copy).then(() => pruneCache(c)))
            .catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(cacheKey).then((hit) => {
          if (hit) return hit;
          // S7: HTML fallback only for navigations; other requests fail as offline.
          return isNavigate ? caches.match("/") : undefined;
        })
      )
  );
});

// ---------- Web Push ----------
// One lazy shared connection instead of open-per-call; closed only on
// versionchange, errors surface via tx.onerror/onabort (S8).
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const rq = indexedDB.open("dsh-phone", 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      rq.onsuccess = () => {
        const db = rq.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        res(db);
      };
      rq.onerror = () => rej(rq.error);
      rq.onblocked = () => rej(new Error("indexedDB open blocked"));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function idbTx(mode, fn) {
  return openDB().then((db) => new Promise((res, rej) => {
    let tx;
    try { tx = db.transaction("kv", mode); } catch (err) { rej(err); return; }
    let rq = null;
    try { rq = fn(tx.objectStore("kv")); } catch (err) { rej(err); return; }
    tx.oncomplete = () => res(rq ? rq.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error("transaction aborted"));
  }));
}

function idbSet(k, v) { return idbTx("readwrite", (s) => s.put(v, k)); }
function idbGet(k) { return idbTx("readonly", (s) => s.get(k)); }

function b64uToUint8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const base = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// S9 (conservative): suppress identical tag+body notifications inside a short
// window so an event burst does not spam the user; tag+renotify still replaces.
const NOTIFY_DEDUPE_MS = 3000;
const lastNotifyAt = new Map();
function notifyThrottled(key) {
  const now = Date.now();
  for (const [k, t] of lastNotifyAt) {
    if (now - t > NOTIFY_DEDUPE_MS) lastNotifyAt.delete(k);
  }
  const prev = lastNotifyAt.get(key);
  lastNotifyAt.set(key, now);
  return prev !== undefined && now - prev < NOTIFY_DEDUPE_MS;
}

function showPush(payload) {
  const body = payload && payload.body ? String(payload.body) : "";
  const tag = payload && payload.tag ? String(payload.tag) : "dsh-phone";
  const sessionId = payload && payload.sessionId ? String(payload.sessionId) : "";
  if (notifyThrottled(tag + "|" + body + "|" + sessionId)) {
    return Promise.resolve();
  }
  const n = {
    body,
    tag,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { sessionId },
    renotify: true,
  };
  return self.registration.showNotification(payload && payload.title ? String(payload.title) : "DSH Phone", n);
}

self.addEventListener("push", (e) => {
  let payload = null;
  try { payload = e.data ? e.data.json() : null; } catch (_) { payload = null; }
  e.waitUntil(showPush(payload).catch((err) => console.warn("sw: showNotification failed:", err)));
});

// S5: dead branch removed; sessionId is now delivered to the page (postMessage)
// or encoded into the opened URL hash. NOTE: app.js still needs a
// `navigator.serviceWorker.addEventListener("message", ...)` handler for
// { type: "dsh-open-session", sessionId } and/or "#s=" hash routing.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const sessionId = data.sessionId ? String(data.sessionId) : "";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const target = list.find((c) => c.url && c.url.startsWith(self.location.origin));
      if (target) {
        if (sessionId) {
          try { target.postMessage({ type: "dsh-open-session", sessionId }); } catch (_) {}
        }
        return target.focus();
      }
      return self.clients.openWindow(sessionId ? "/#s=" + encodeURIComponent(sessionId) : "/");
    })
  );
});

// Browser rotated the subscription (or it expired): re-subscribe with the
// current VAPID key and hand the fresh endpoint to the node. The gateway token
// lives in IndexedDB (SW has no localStorage access) - written when the user
// enables push in the app.
// S6: prefer e.newSubscription, unsubscribe/re-report the old endpoint to the
// node, and never let a rejection escape waitUntil.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      let token = null;
      try { token = await idbGet("token"); } catch (_) {}
      if (!token) return;

      // Best-effort capture of the old endpoint before rotation replaces it,
      // so the node can drop the dead address.
      let oldEndpoint = null;
      try {
        const old = await self.registration.pushManager.getSubscription();
        if (old) oldEndpoint = old.endpoint;
      } catch (_) {}

      // Prefer the browser-provided replacement subscription if present.
      let sub = e.newSubscription || null;
      if (!sub) {
        const r = await fetch("/api/push/info?token=" + encodeURIComponent(token)).then((x) => x.json()).catch(() => null);
        if (!r || !r.ok || !r.vapid_public) return;
        try {
          sub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64uToUint8(r.vapid_public),
          });
        } catch (err) {
          console.warn("sw: re-subscribe failed:", err);
          sub = null;
        }
        if (!sub) return;
      }

      const j = sub.toJSON();
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          endpoint: sub.endpoint,
          p256dh: j.keys && j.keys.p256dh,
          auth: j.keys && j.keys.auth,
          device: "sw-resub",
        }),
      }).catch(() => {});

      // Tell the node the previous endpoint is dead (same shape as app.js disablePush).
      if (oldEndpoint && oldEndpoint !== sub.endpoint) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, endpoint: oldEndpoint }),
        }).catch(() => {});
      }
    })().catch((err) => console.warn("sw: pushsubscriptionchange failed:", err))
  );
});
