const CACHE = "dsh-phone-v21";
const ASSETS = ["/", "/app.js", "/md.js", "/itemrender.js", "/draftsync.js", "/style.css", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// network-first: never serve a stale app.js/style.css from cache.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
  );
});

// ---------- Web Push ----------
function idbSet(k, v) {
  return new Promise((res, rej) => {
    const rq = indexedDB.open("dsh-phone", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(v, k);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    rq.onerror = () => rej(rq.error);
  });
}

function idbGet(k) {
  return new Promise((res, rej) => {
    const rq = indexedDB.open("dsh-phone", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onsuccess = () => {
      const db = rq.result;
      const g = db.transaction("kv", "readonly").objectStore("kv").get(k);
      g.onsuccess = () => { db.close(); res(g.result); };
      g.onerror = () => rej(g.error);
    };
    rq.onerror = () => rej(rq.error);
  });
}

function b64uToUint8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const base = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function showPush(payload) {
  const n = {
    body: payload && payload.body ? String(payload.body) : "",
    tag: payload && payload.tag ? String(payload.tag) : "dsh-phone",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { sessionId: payload && payload.sessionId },
    renotify: true,
  };
  return self.registration.showNotification(payload && payload.title ? String(payload.title) : "DSH Phone", n);
}

self.addEventListener("push", (e) => {
  let payload = null;
  try { payload = e.data ? e.data.json() : null; } catch (_) { payload = null; }
  e.waitUntil(showPush(payload));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url && c.url.startsWith(self.location.origin)) {
          if (e.notification.data && e.notification.data.sessionId) {
            try { c.focus(); return; } catch (_) {}
          }
          c.focus();
          return;
        }
      }
      return self.clients.openWindow("/");
    })
  );
});

// Browser rotated the subscription (or it expired): re-subscribe with the
// current VAPID key and hand the fresh endpoint to the node. The gateway token
// lives in IndexedDB (SW has no localStorage access) - written when the user
// enables push in the app.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      let token = null;
      try { token = await idbGet("token"); } catch (_) {}
      if (!token) return;
      const r = await fetch("/api/push/info?token=" + encodeURIComponent(token)).then((x) => x.json()).catch(() => null);
      if (!r || !r.ok || !r.vapid_public) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToUint8(r.vapid_public),
      });
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
    })()
  );
});
