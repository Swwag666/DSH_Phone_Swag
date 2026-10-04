(function () {
  "use strict";
  var MARK = "__dshDesktopDraftSync";
  if (typeof window !== "object" || window[MARK]) return;
  window[MARK] = true;

  // --- P8: one draft-sync engine per document -----------------------------
  // The plugin engine (plugin/dsh-draft-sync/lib/client.js) is the richer one
  // (full teardown, heartbeat, XHR sniffing). If its module is present in this
  // document, this patch stands down instead of running a second engine. If
  // this patch armed first, it publishes a stop hook so the plugin can take
  // over cleanly, and it releases the shared claim key on stop.
  var ARM_KEY = "__dshDraftSyncArmed";
  var ARM_VALUE = "dsh-desktop-gui-patch";
  if (window.__dshDraftSyncPlugin) return;
  if (window[ARM_KEY]) {
    try { console.log("[dsh-draft-sync] already armed by " + window[ARM_KEY] + ", gui patch stands down"); } catch (e) {}
    return;
  }
  window[ARM_KEY] = ARM_VALUE;

  var VERSION = 2;
  var NODE_PORT = 8460;
  // :8460 - основной порт узла (http, либо https когда включён TLS).
  // :8461 - loopback-only http, который узел поднимает при TLS, чтобы
  // этот патч не терял бутстрап. Перебираем оба, первый живой wins.
  var NODE_BASES = [
    "http://127.0.0.1:" + NODE_PORT,
    "http://127.0.0.1:" + (NODE_PORT + 1),
    "http://localhost:" + NODE_PORT,
    "http://localhost:" + (NODE_PORT + 1)
  ];
  var ORIGIN_ID = "dsh-desktop";
  var PUSH_DELAY_MS = 600;
  var POLL_BUSY_MS = 60;      // активный темп, когда вкладка видима и пользователь рядом
  var POLL_IDLE_MS = 900;     // D2: idle-backoff (вкладка скрыта / нет composer / давно не печатали)
  var GRACE_MS = 2500;
  var MAX_TEXT = 10000;
  var RETRY_MS = 5000;
  var WATCH_RETRY_MS = 800;
  var WATCH_CHECK_MS = 1500;   // D5: единственный «health tick» проверки composer
  var MUTATION_DEBOUNCE_MS = 120;
  var IDLE_AFTER_MS = 30000;

  var cfg = null;          // {token, port}
  var nodeBase = null;
  var sessionId = null;    // harness external id, e.g. session-<uuid>
  var since = 0;
  var el = null;           // composer [data-composer-input]
  var pushTimer = 0;
  var lastLocalInput = 0;  // ms epoch of the last keystroke here
  var lastPushedText = null;
  var applyingRemote = false;
  var pendingRemoteText = null; // D8: текст, отложенный пока вкладка скрыта
  var alive = false;
  var started = false;          // D2/D3: single-flight для start()
  var engineEpoch = 0;          // D1/D9: инкремент на каждый stop → async-хвосты отбрасываются
  var sessionEpoch = 0;         // D9: инкремент на каждую смену привязки сессии
  var pollAbort = null;
  var pollHandle = 0;           // D2: id таймера poll-цепочки
  var pollRunning = false;      // D2: живёт ли цепочка
  var bootstrapping = false;    // D3: single-flight fetchConfig
  var bootHandle = 0;           // D2/D3: id отложенного bootstrap
  var watchHandle = 0;          // D5: единственный retry-таймер поиска composer
  var watchPending = false;     // D5: debounce мутаций
  var mo = null;
  var moTarget = null;          // D5: за чем сейчас наблюдаем
  var attachedEls = [];         // D6: все узлы, на которые вешали слушатель
  var fetchHooked = false;      // D1: снимается в stop()
  var originalFetch = null;
  var wrappedFetch = null;
  var visibilityBound = false;
  var lifecycleBound = false;

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[dsh-draft-sync]");
      console.log.apply(console, args);
    } catch (e) {}
  }

  function now() {
    return Date.now();
  }

  function isComposer(node) {
    return !!(node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-composer-input"));
  }

  function composerAttached() {
    return !!(el && isComposer(el) && el.isConnected);
  }

  function composerText() {
    if (!el) return "";
    // innerText keeps paragraph breaks, textContent glues them together
    var t = (typeof el.innerText === "string" ? el.innerText : el.textContent) || "";
    return t.slice(0, MAX_TEXT);
  }

  function setComposerContent(text) {
    // fallback path: whole-content replacement without the caret dance
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function applyComposerText(text) {
    if (!el) return;
    // D8: never touch an editor the user cannot see - stash and flush on
    // visibilitychange instead of stealing focus in a background tab.
    if (typeof document === "object" && document.hidden) {
      pendingRemoteText = text;
      return;
    }
    pendingRemoteText = null;
    applyingRemote = true;
    try {
      var active = document.activeElement;
      // D8: only take focus when nothing else owns it. If the user is typing
      // in another field we replace the content without execCommand and
      // without moving the caret.
      var focusFree = !!(active && active !== el && active !== document.body && active !== document.documentElement);
      var ok = false;
      if (!focusFree) {
        el.focus();
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        // insertText goes through the native input pipeline, so the Lexical
        // editor picks the change up as a real edit event. execCommand is
        // deprecated - it is tried first only because it is the one path that
        // Lexical observes as a real edit, and we fall back when it is gone.
        try {
          ok = !!(document.execCommand && document.execCommand("insertText", false, text));
        } catch (e2) {
          ok = false;
        }
      }
      if (!ok) setComposerContent(text);
      if (!text) {
        // wiped draft: make sure the placeholder state resets
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      }
    } catch (e) {
      log("apply failed", e && e.message);
    } finally {
      lastPushedText = text;
      applyingRemote = false;
    }
  }

  function onVisibilityChange() {
    if (!alive) return;
    if (document.hidden) return;
    // D8: flush the draft we refused to apply while hidden
    if (pendingRemoteText !== null) {
      var text = pendingRemoteText;
      pendingRemoteText = null;
      if (!applyingRemote && text !== composerText()) applyComposerText(text);
    }
    // D2: hidden->visible: come back to the active tempo at once
    if (pollRunning && pollHandle) {
      clearTimeout(pollHandle);
      pollHandle = 0;
      pollLoop();
    }
  }

  function bindVisibility() {
    if (visibilityBound) return;
    visibilityBound = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function unbindVisibility() {
    if (!visibilityBound) return;
    visibilityBound = false;
    try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (e) {}
  }

  function fetchConfig() {
    var i = 0;
    function attempt() {
      if (!alive) return Promise.resolve(null);
      if (i >= NODE_BASES.length) return Promise.resolve(null);
      var base = NODE_BASES[i++];
      return fetch(base + "/api/draft-config", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!alive) return null;
          if (j && j.ok && j.token) {
            nodeBase = base;
            return j;
          }
          return attempt();
        })
        .catch(function () { return attempt(); });
    }
    return attempt();
  }

  // P5-style guard: never build a request without a node base and a config,
  // and never let a rejection escape (callers only branch on the payload).
  function nodeRequest(method, params) {
    if (!alive || !cfg || !nodeBase) return Promise.resolve(null);
    try {
      return fetch(nodeBase + "/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-token": cfg.token },
        body: JSON.stringify({ token: cfg.token, method: method, params: params })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function pushDraft(force) {
    if (!alive || !cfg || !nodeBase || !sessionId || !el) return;
    var text = composerText();
    if (!force && text === lastPushedText) return;
    lastPushedText = text;
    var epoch = engineEpoch;
    nodeRequest("session.updateDraft", { sessionId: sessionId, text: text, origin: ORIGIN_ID })
      .then(function (j) {
        if (!alive || epoch !== engineEpoch) return;
        if (j && j.ok) return;
        // token rotated or the node restarted: re-bootstrap once
        log("push rejected, re-reading config");
        lastPushedText = null;
        cfg = null;
        nodeBase = null;
        scheduleBootstrap(RETRY_MS);
      })
      .catch(function () {});
  }

  function schedulePush() {
    if (!alive || applyingRemote) return;
    lastLocalInput = now();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = 0;
      pushDraft(false);
    }, PUSH_DELAY_MS);
  }

  function sameTarget(data) {
    if (!sessionId) return false;
    if (data.externalSessionId === sessionId) return true;
    return data.sessionId === sessionId;
  }

  // D9: events are matched against the session and the engine epoch that were
  // current when the request went out, so a session switch or an engine
  // restart in flight can no longer apply stale text.
  function handleEvents(events, reqEpoch, reqSessionEpoch, reqSessionId) {
    if (!alive || reqEpoch !== engineEpoch || reqSessionEpoch !== sessionEpoch) return;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i] || {};
      if (ev.type !== "draft" || !ev.data) continue;
      var d = ev.data;
      if (d.origin === ORIGIN_ID) continue; // own echo
      if (!sameTarget(d)) continue;
      if (reqSessionId && reqSessionId !== sessionId) continue; // rebound while polling
      if (applyingRemote) continue;
      var busyTyping = document.activeElement === el && (now() - lastLocalInput) < GRACE_MS;
      if (busyTyping) continue;
      applyComposerText(String(d.text || ""));
    }
  }

  // --- D2: poll chain is a single, tracked, cancellable loop ---------------
  function pollDelay() {
    if (typeof document === "object" && document.hidden) return POLL_IDLE_MS;
    if (!composerAttached()) return POLL_IDLE_MS;
    if (lastLocalInput && (now() - lastLocalInput) > IDLE_AFTER_MS) return POLL_IDLE_MS;
    return POLL_BUSY_MS;
  }

  function startPoll() {
    if (!alive || pollRunning) return;
    pollRunning = true;
    pollLoop();
  }

  function stopPoll() {
    pollRunning = false;
    if (pollHandle) { clearTimeout(pollHandle); pollHandle = 0; }
    if (pollAbort) { try { pollAbort.abort(); } catch (e) {} pollAbort = null; }
  }

  function schedulePoll(delay) {
    if (!alive || !pollRunning) return;
    if (pollHandle) clearTimeout(pollHandle);
    var epoch = engineEpoch;
    pollHandle = setTimeout(function () {
      pollHandle = 0;
      if (!alive || !pollRunning || epoch !== engineEpoch) return;
      pollLoop();
    }, delay);
  }

  function pollLoop() {
    if (!alive || !pollRunning) return;
    if (!cfg || !nodeBase) { pollRunning = false; return; }
    if (pollAbort) { try { pollAbort.abort(); } catch (e) {} }
    var ac = new AbortController();
    pollAbort = ac;
    var epoch = engineEpoch;
    var sessEpoch = sessionEpoch;
    var sid = sessionId;
    // D7: token travels in the x-dsh-token header only (the node accepts the
    // header first); it no longer lands in the access log via the query string.
    var url = nodeBase + "/api/events?since=" + encodeURIComponent(String(since)) + "&had=1";
    fetch(url, { cache: "no-store", signal: ac.signal, headers: { "x-dsh-token": cfg.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!alive || epoch !== engineEpoch) return;
        if (!j) throw new Error("no data");
        since = Number(j.ts) || since;
        handleEvents(j.events || [], epoch, sessEpoch, sid);
        schedulePoll(pollDelay());
      })
      .catch(function (e) {
        if (!alive || epoch !== engineEpoch) return;
        if (e && e.name === "AbortError") return;
        if (!pollRunning) return;
        // node down or auth gone: back off, re-bootstrap (single-flight)
        pollRunning = false;
        cfg = null;
        nodeBase = null;
        scheduleBootstrap(RETRY_MS);
      });
  }

  function loadExistingDraft() {
    if (!alive || !cfg || !nodeBase || !sessionId) return;
    var sid = sessionId;
    var epoch = engineEpoch;
    var sessEpoch = sessionEpoch;
    nodeRequest("session.getDraft", { sessionId: sid })
      .then(function (j) {
        if (!alive || epoch !== engineEpoch || sessEpoch !== sessionEpoch || sid !== sessionId) return;
        var d = j && j.result;
        if (!d) return;
        var text = String(d.text || "");
        if (!text) return;
        if (composerText()) return; // never clobber local content
        if (d.origin === ORIGIN_ID) return;
        applyComposerText(text);
      })
      .catch(function () {});
  }

  // --- active session tracking: sniff the page's own /api calls ---
  var SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // D4: names are stored WITHOUT the "/api/" prefix; the old comparison built
  // "/api//api/session/list" and therefore never matched, so service calls
  // (list/title/rename/fork/create) hijacked the bound session.
  var SIDE_CHANNELS = ["session/list", "session/title", "session/rename", "session/fork", "session/create"];

  function apiPathOf(url) {
    var idx = url.indexOf("/api/");
    var path = idx >= 0 ? url.slice(idx) : url;
    path = path.split("?")[0].split("#")[0];
    while (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.slice(0, -1);
    return path.indexOf("/api/") === 0 ? path.slice(5) : path;
  }

  function isSideChannel(url) {
    var name = apiPathOf(url);
    for (var i = 0; i < SIDE_CHANNELS.length; i++) {
      if (name === SIDE_CHANNELS[i]) return true;
    }
    return false;
  }

  function trackFromUrlAndBody(url, bodyText) {
    if (!alive) return;
    var m = SESSION_RE.exec(bodyText || "");
    if (!m) return;
    // not an "open this session" signal
    if (isSideChannel(url)) return;
    if (m[0] !== sessionId) adoptSession(m[0], "sniff");
  }

  function adoptSession(id, why) {
    if (!alive || !id || id === sessionId) return;
    sessionId = id;
    sessionEpoch++;        // D9: in-flight responses for the old session die
    lastPushedText = null;
    log("active session (" + why + "):", sessionId);
    if (cfg && nodeBase) {
      loadExistingDraft();
      pushDraft(false);
    }
  }

  // --- D1: fetch interception that can be undone -------------------------
  var FETCH_KEY = "__dshDesktopDraftSyncFetch";

  function hookFetch() {
    if (fetchHooked) return;
    var of = window.fetch;
    if (typeof of !== "function") return;
    originalFetch = of;
    wrappedFetch = function (input, init) {
      try {
        var url = "";
        var body = null;
        if (typeof input === "string") url = input;
        else if (input && input.url) url = String(input.url);
        if (init && typeof init.body === "string") body = init.body;
        if (url.indexOf("/api/") >= 0 && ((init && init.method) || "GET").toUpperCase() === "POST" && body) {
          trackFromUrlAndBody(url, body);
        }
      } catch (e) {}
      return of.apply(window, arguments);
    };
    window[FETCH_KEY] = true;
    window.fetch = wrappedFetch;
    fetchHooked = true;
  }

  function unhookFetch() {
    window[FETCH_KEY] = false;
    // restore only when our wrapper is still the top of the chain, so a later
    // interceptor (e.g. the DSH connection layer) is left intact
    if (fetchHooked && originalFetch !== null && window.fetch === wrappedFetch) {
      window.fetch = originalFetch;
    }
    fetchHooked = false;
    originalFetch = null;
    wrappedFetch = null;
  }

  // --- D6: listener bookkeeping for every node we ever attached to -------
  function listenEl(node) {
    if (!node || attachedEls.indexOf(node) >= 0) return;
    node.addEventListener("input", schedulePush, true);
    attachedEls.push(node);
  }

  function releaseEl(node) {
    if (!node) return;
    var i = attachedEls.indexOf(node);
    if (i >= 0) attachedEls.splice(i, 1);
    try { node.removeEventListener("input", schedulePush, true); } catch (e) {}
  }

  function releaseAllEls() {
    while (attachedEls.length) {
      var node = attachedEls.pop();
      try { node.removeEventListener("input", schedulePush, true); } catch (e) {}
    }
  }

  // --- D5: one tracked retry chain + debounced, narrowly scoped observer --
  function watchComposer() {
    watchPending = false;
    if (!alive) return;
    if (el && !composerAttached()) {
      // the composer node was replaced: drop our listener from the old one
      releaseEl(el);
      el = null;
      retargetObserver(null);
    }
    if (composerAttached()) {
      // health tick: the observer is narrowed to the composer container, so a
      // single tracked timer re-validates the attachment (and re-widens the
      // observer) if the whole view gets swapped out from under us
      retargetObserver(el);
      scheduleWatch(WATCH_CHECK_MS);
      return;
    }
    var found = document.querySelector('[data-composer-input]');
    if (found) {
      el = found;
      lastPushedText = null;
      listenEl(el);
      log("composer attached");
      retargetObserver(el);
      scheduleWatch(WATCH_CHECK_MS);
      if (cfg && nodeBase && sessionId) loadExistingDraft();
      return;
    }
    scheduleWatch(WATCH_RETRY_MS);
  }

  function scheduleWatch(delay) {
    if (!alive) return;
    if (watchHandle) return; // exactly one pending retry chain
    watchHandle = setTimeout(function () {
      watchHandle = 0;
      watchComposer();
    }, delay);
  }

  function stopWatch() {
    if (watchHandle) { clearTimeout(watchHandle); watchHandle = 0; }
    watchPending = false;
  }

  function mutationSeen() {
    if (!alive) return;
    if (composerAttached()) return; // nothing to re-bind
    if (watchPending) return;       // a fast re-check is already queued
    // debounce: coalesce a burst of mutations into ONE re-check, and jump
    // ahead of the slow health tick instead of stacking another timer
    watchPending = true;
    if (watchHandle) { clearTimeout(watchHandle); watchHandle = 0; }
    scheduleWatch(MUTATION_DEBOUNCE_MS);
  }

  // Observe the composer's own container once we know where it lives; fall
  // back to the document only while the composer is missing.
  function retargetObserver(node) {
    if (!alive || !mo) return;
    var target = node && node.parentNode ? node.parentNode : document.documentElement;
    if (moTarget === target) return;
    try { mo.disconnect(); } catch (e) {}
    moTarget = target;
    try { mo.observe(target, { childList: true, subtree: true }); } catch (e) { moTarget = null; }
  }

  function observeDom() {
    if (typeof MutationObserver !== "function") { scheduleWatch(WATCH_RETRY_MS); return; }
    if (!mo) {
      mo = new MutationObserver(mutationSeen);
      moTarget = null;
    }
    retargetObserver(null);
    watchComposer();
  }

  // --- D3: single-flight bootstrap, tracked retry timer ------------------
  function scheduleBootstrap(delay) {
    if (!alive) return;
    if (bootHandle) clearTimeout(bootHandle);
    var epoch = engineEpoch;
    bootHandle = setTimeout(function () {
      bootHandle = 0;
      if (!alive || epoch !== engineEpoch) return;
      bootstrap();
    }, delay);
  }

  function bootstrap() {
    if (!alive) return;
    if (cfg && nodeBase) { startPoll(); return; }
    if (bootstrapping) return;
    bootstrapping = true;
    var epoch = engineEpoch;
    fetchConfig().then(function (j) {
      bootstrapping = false;
      if (!alive || epoch !== engineEpoch) return;
      if (!j) { scheduleBootstrap(RETRY_MS); return; }
      cfg = j;
      log("linked to dsh-phone node", nodeBase, "v" + (j.version || "?"));
      if (sessionId) { loadExistingDraft(); pushDraft(false); }
      startPoll();
    }).catch(function () {
      bootstrapping = false;
      if (alive && epoch === engineEpoch) scheduleBootstrap(RETRY_MS);
    });
  }

  function resetState() {
    cfg = null;
    nodeBase = null;
    sessionId = null;
    since = 0;
    lastPushedText = null;
    lastLocalInput = 0;
    pendingRemoteText = null;
    applyingRemote = false;
    sessionEpoch++;
  }

  // --- D1: real teardown (idempotent) ------------------------------------
  function stop() {
    engineEpoch++;         // kills every in-flight .then from this engine
    alive = false;
    started = false;
    stopPoll();
    if (bootHandle) { clearTimeout(bootHandle); bootHandle = 0; }
    bootstrapping = false;
    stopWatch();
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
    if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; moTarget = null; }
    releaseAllEls();
    el = null;
    unbindVisibility();
    unhookFetch();
    resetState();
    if (window[ARM_KEY] === ARM_VALUE) {
      try { delete window[ARM_KEY]; } catch (e) { window[ARM_KEY] = null; }
    }
    if (window.__dshDesktopDraftSyncStop === stop) window.__dshDesktopDraftSyncStop = null;
    log("stopped");
  }

  function start() {
    if (started || alive) return;   // D2/D3: never arm twice
    started = true;
    alive = true;
    engineEpoch++;
    hookFetch();
    bindVisibility();
    observeDom();
    bootstrap();
    log("v" + VERSION + " armed");
  }

  // Teardown hooks: the desktop GUI has no plugin-effect channel, so expose
  // stop() for the host (and for the plugin engine taking over) and bind it to
  // page lifecycle events. bfcache restore re-arms through pageshow.
  window.__dshDesktopDraftSyncStop = stop;
  window.__dshDesktopDraftSyncStart = start;

  function onPageHide() { stop(); }
  function onPageShow() { start(); }

  if (!lifecycleBound) {
    lifecycleBound = true;
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function onReady() {
      document.removeEventListener("DOMContentLoaded", onReady);
      start();
    });
  } else {
    start();
  }
})();
