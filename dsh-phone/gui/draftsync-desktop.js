(function () {
  "use strict";
  var MARK = "__dshDesktopDraftSync";
  if (typeof window !== "object" || window[MARK]) return;
  window[MARK] = true;

  var VERSION = 1;
  var NODE_BASES = ["http://127.0.0.1:8460", "http://localhost:8460"];
  var ORIGIN_ID = "dsh-desktop";
  var PUSH_DELAY_MS = 600;
  var POLL_IDLE_MS = 900;
  var GRACE_MS = 2500;
  var MAX_TEXT = 10000;

  var cfg = null;          // {token, port}
  var nodeBase = null;
  var sessionId = null;    // harness external id, e.g. session-<uuid>
  var since = 0;
  var el = null;           // composer [data-composer-input]
  var pushTimer = 0;
  var lastLocalInput = 0;  // ms epoch of the last keystroke here
  var lastPushedText = null;
  var applyingRemote = false;
  var alive = false;
  var pollAbort = null;

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

  function composerText() {
    if (!el) return "";
    // innerText keeps paragraph breaks, textContent glues them together
    var t = (typeof el.innerText === "string" ? el.innerText : el.textContent) || "";
    return t.slice(0, MAX_TEXT);
  }

  function applyComposerText(text) {
    if (!el) return;
    applyingRemote = true;
    try {
      el.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      // insertText goes through the native input pipeline, so the Lexical
      // editor picks the change up as a real edit event
      var ok = document.execCommand("insertText", false, text);
      if (!ok) {
        // fallback: whole-content replacement without the caret dance
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
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

  function fetchConfig() {
    var i = 0;
    function attempt() {
      if (i >= NODE_BASES.length) return Promise.resolve(null);
      var base = NODE_BASES[i++];
      return fetch(base + "/api/draft-config", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
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

  function nodeRequest(method, params) {
    return fetch(nodeBase + "/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dsh-token": cfg.token },
      body: JSON.stringify({ token: cfg.token, method: method, params: params })
    }).then(function (r) { return r.ok ? r.json() : null; });
  }

  function pushDraft(force) {
    if (!alive || !cfg || !sessionId || !el) return;
    var text = composerText();
    if (!force && text === lastPushedText) return;
    lastPushedText = text;
    nodeRequest("session.updateDraft", { sessionId: sessionId, text: text, origin: ORIGIN_ID })
      .then(function (j) {
        if (j && j.ok) return;
        // token rotated or the node restarted: re-bootstrap once
        log("push rejected, re-reading config");
        cfg = null;
        bootstrap();
      })
      .catch(function () {});
  }

  function schedulePush() {
    if (applyingRemote) return;
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

  function handleEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var ev = events[i] || {};
      if (ev.type !== "draft" || !ev.data) continue;
      var d = ev.data;
      if (d.origin === ORIGIN_ID) continue; // own echo
      if (!sameTarget(d)) continue;
      if (applyingRemote) continue;
      var busyTyping = document.activeElement === el && (now() - lastLocalInput) < GRACE_MS;
      if (busyTyping) continue;
      applyComposerText(String(d.text || ""));
    }
  }

  function pollLoop() {
    if (!alive || !cfg) return;
    if (pollAbort) pollAbort.abort();
    pollAbort = new AbortController();
    var url = nodeBase + "/api/events?since=" + encodeURIComponent(String(since)) + "&had=1&token=" + encodeURIComponent(cfg.token);
    fetch(url, { cache: "no-store", signal: pollAbort.signal, headers: { "x-dsh-token": cfg.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!alive || !j) throw new Error("no data");
        since = Number(j.ts) || since;
        handleEvents(j.events || []);
        setTimeout(pollLoop, 60);
      })
      .catch(function (e) {
        if (!alive) return;
        if (e && e.name === "AbortError") return;
        // node down or auth gone: back off, re-bootstrap
        cfg = null;
        setTimeout(bootstrap, 5000);
      });
  }

  function loadExistingDraft() {
    if (!cfg || !sessionId) return;
    nodeRequest("session.getDraft", { sessionId: sessionId })
      .then(function (j) {
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
  var SIDE_CHANNELS = ["/api/session/list", "/api/session/title", "/api/session/rename", "/api/session/fork", "/api/session/create"];

  function trackFromUrlAndBody(url, bodyText) {
    var m = SESSION_RE.exec(bodyText || "");
    if (!m) return;
    var path = url.indexOf("/api/") >= 0 ? url.slice(url.indexOf("/api/")) : url;
    var base = path.split("?")[0];
    for (var i = 0; i < SIDE_CHANNELS.length; i++) {
      if (base === "/api/" + SIDE_CHANNELS[i].slice(5)) return; // not an "open this session" signal
    }
    if (m[0] !== sessionId) {
      sessionId = m[0];
      lastPushedText = null;
      log("active session:", sessionId);
      if (cfg) {
        loadExistingDraft();
        pushDraft(false);
      }
    }
  }

  function hookFetch() {
    if (window.__dshFetchHooked) return;
    window.__dshFetchHooked = true;
    var of = window.fetch;
    if (typeof of !== "function") return;
    window.fetch = function (input, init) {
      try {
        var url = "";
        var body = null;
        if (typeof input === "string") url = input;
        else if (input && input.url) url = String(input.url);
        if (init && typeof init.body === "string") body = init.body;
        if (url.indexOf("/api/") >= 0 && (init && init.method || "GET").toUpperCase() === "POST" && body) {
          trackFromUrlAndBody(url, body);
        }
      } catch (e) {}
      return of.apply(window, arguments);
    };
  }

  function watchComposer() {
    if (el && el.isConnected) return;
    var found = document.querySelector('[data-composer-input]');
    if (found) {
      el = found;
      lastPushedText = null;
      el.addEventListener("input", schedulePush, true);
      log("composer attached");
      if (cfg && sessionId) loadExistingDraft();
      return;
    }
    setTimeout(watchComposer, 800);
  }

  var mo = null;
  function observeDom() {
    if (typeof MutationObserver !== "function") { setTimeout(watchComposer, 800); return; }
    mo = new MutationObserver(function () {
      if (!el || !el.isConnected) {
        if (el) { el = null; }
        watchComposer();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    watchComposer();
  }

  function bootstrap() {
    if (!alive) return;
    if (cfg) { pollLoop(); return; }
    fetchConfig().then(function (j) {
      if (!alive) return;
      if (!j) { setTimeout(bootstrap, 5000); return; }
      cfg = j;
      log("linked to dsh-phone node", nodeBase, "v" + (j.version || "?"));
      if (sessionId) { loadExistingDraft(); pushDraft(false); }
      pollLoop();
    });
  }

  function start() {
    alive = true;
    hookFetch();
    observeDom();
    bootstrap();
    log("v" + VERSION + " armed");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
