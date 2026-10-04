"use strict";
const LS = "dsh-phone-token";
let token = localStorage.getItem(LS) || "";
let bridgeOn = false;
// Какой канал сейчас в работе: "tcp" (мост плагина или AA), "plugin" (HTTP-канал
// web-половины) или "" (не знаем/нет). Показывается в тултипе точки статуса.
let bridgeChannel = "";

function bridgeChannelLabel() {
  if (!bridgeOn) return "мост отключён";
  if (bridgeChannel === "plugin") return "мост: плагин dsh-phone (HTTP)";
  if (bridgeChannel === "tcp") return "мост: TCP (DSH Desktop)";
  return "мост подключён";
}

function paintBridge() {
  const dot = $("status-dot");
  if (!dot) return;
  dot.className = "dot " + (bridgeOn ? "on" : "off");
  dot.title = bridgeChannelLabel();
}
let sessions = [];
let activeSession = null;
let items = new Map();       // key -> item
let rendered = new Set();    // keys already in DOM
let nodeFor = new Map();     // key -> DOM node
let knownStatus = "";
let since = 0;
let pollTimer = null;
let pollOn = false;            // A1: единственный признак живого цикла поллинга
let pollAbort = null;          // A2: отмена in-flight long-poll
let refreshTimer = null;
let refreshInFlight = false;   // A2: только один refreshActiveChat за раз
let refreshQueued = false;
let chatEpoch = 0;             // A3: «поколение» чата; каждый .then сверяет его
let chatAbort = null;          // A2/A3: отмена запросов ушедшего чата
let approvalInFlight = false;  // A8
let approvalQueued = false;
let lastApprovalAt = 0;
let authInFlight = false;      // A1: повторный тап «предъявить ключ»
let orderedCache = null;       // A5: кэш отсортированного списка айтемов
let lastUserSeq = -1;          // A5: инкрементальный lastUserText
let sessionsSig = "";          // A9: сигнатура списка сессий
let pageHiddenAt = 0;          // A14
let lastAuthToken = "";        // A11: токен, для которого актуальны since/sessions
const notifiedNotices = new Set();  // A8: дедуп уведомлений по noticeId
const notifiedTurns = new Map();    // A8: дедуп уведомлений по sessionId
const MAX_ITEMS = 1500;             // A5: потолок истории в памяти и в DOM
const FETCH_TIMEOUT_MS = 20000;     // A2
const EVENTS_TIMEOUT_MS = 120000;   // A2: long-poll узел держит дольше обычного RPC
const APPROVAL_MIN_MS = 700;        // A8
const HIST_SESSIONS_KEEP = 40;      // A10: LRU-потолок кэша истории в localStorage
let lastError = "";
let models = [];
let permissions = [];
let currentModelId = null;
let currentPermissionId = null;
let pendingAttachments = [];
let turnHadError = false;
let turnT0 = 0;
let readUpTo = (() => { try { return JSON.parse(localStorage.getItem("dsh-phone-read") || "{}"); } catch (_) { return {}; } })();

// ---------- draft sync (поле ввода живёт на всех устройствах) ----------
const deviceId = (() => {
  let id = "";
  try { id = localStorage.getItem("dsh-phone-devid") || ""; } catch (_) {}
  if (!id) {
    id = "d" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem("dsh-phone-devid", id); } catch (_) {}
  }
  return id;
})();
let lastTypedAt = 0;
let draftTimer = null;
let draftPillTimer = null;

function scheduleDraftOut() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    if (!activeSession) return;
    api("session.updateDraft", { sessionId: activeSession, text: $("input").value, deviceId: deviceId })
      .catch(() => {});
  }, DRAFT_PUSH_DELAY_MS);
}

function applyRemoteDraft(remote) {
  if (!remote || remote.sessionId !== activeSession) return;
  const text = draftSyncDecision(remote, deviceId, lastTypedAt, Date.now());
  if (text === null) return;
  if (!draftChanged($("input").value, text)) return;
  $("input").value = text;
  autoGrow();
  if (text) showDraftPill();
}

function showDraftPill() {
  const pill = $("draft-pill");
  if (!pill) return;
  pill.classList.add("on");
  if (draftPillTimer) clearTimeout(draftPillTimer);
  draftPillTimer = setTimeout(() => { pill.classList.remove("on"); draftPillTimer = null; }, 2500);
}

function loadRemoteDraft() {
  if (!activeSession) return;
  api("session.getDraft", { sessionId: activeSession }).then((r) => {
    if (!r.ok || !r.result) return;
    if (r.result.origin === deviceId) return;
    const text = typeof r.result.text === "string" ? r.result.text : "";
    if (text && !$("input").value) {
      $("input").value = text;
      autoGrow();
    }
  }).catch(() => {});
}

function orderTs(s) {
  return s && s.orderingTime ? new Date(s.orderingTime).getTime() : 0;
}
function markRead(sid, ts) {
  if (!ts) ts = Date.now();
  if (!readUpTo[sid] || readUpTo[sid] < ts) {
    readUpTo[sid] = ts;
    try { localStorage.setItem("dsh-phone-read", JSON.stringify(readUpTo)); } catch (_) {}
  }
}

// typewriter только для свежих ходов, инициированных в этой сессии (не реплей при реконнекте)
let allowTw = false;

function histKey(sid) { return "dsh-phone-hist-" + sid; }
function sessCacheKey() { return "dsh-phone-sessions"; }

function saveHistory(sid, list) {
  if (!sid || !Array.isArray(list) || !list.length) return;
  try {
    const slim = [...list].sort((a, b) => (a.orderSeq || 0) - (b.orderSeq || 0)).slice(-300);
    localStorage.setItem(histKey(sid), JSON.stringify(slim));
  } catch (_) {}
}

function loadCachedHistory(sid) {
  try {
    const raw = localStorage.getItem(histKey(sid));
    if (!raw) return null;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : null;
  } catch (_) { return null; }
}

function saveSessionsCache(list) {
  try { localStorage.setItem(sessCacheKey(), JSON.stringify((list || []).slice(0, 500))); } catch (_) {}
}

function loadCachedSessions() {
  try {
    const raw = localStorage.getItem(sessCacheKey());
    if (!raw) return null;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : null;
  } catch (_) { return null; }
}

const $ = (id) => document.getElementById(id);

function status(text) {
  const el = $("statusline");
  const t = String(text || "");
  let cls = "st-none";
  if (/думаю|работает|заливаю|отправк|подгружаю|загрузк|жду|модели/i.test(t)) cls = "st-work";
  else if (/ошибка|не сменил|не загрузил|не смог|мост отключ|нет связи|недоступен|не подош/i.test(t)) cls = "st-err";
  else if (/подключено|отправлено|добавлено|готово|загружен|вся история/i.test(t)) cls = "st-on";
  el.className = cls;
  el.innerHTML = `<span class="st-dot"></span><span class="st-txt">${escapeHtml(t)}</span>` +
    (cls === "st-work" ? `<span class="st-dots"><i></i><i></i><i></i></span>` : "");
}

function notifyNow(title, body, tag) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, { body: String(body || ""), tag: tag || undefined });
    setTimeout(() => { try { n.close(); } catch (_) {} }, 9000);
  } catch (_) {}
}

function isErrorItem(it) {
  if (!it) return false;
  const s = it.status;
  return s === "failed" || s === "error" || s === "cancelled" || s === "interrupted";
}

function show(view) {
  ["view-auth", "view-list", "view-chat"].forEach((v) => $(v).classList.add("hidden"));
  $(view).classList.remove("hidden");
  $("back").classList.toggle("hidden", view === "view-list" || view === "view-auth");
  $("refresh").classList.toggle("hidden", view !== "view-list");
  $("new-btn").classList.toggle("hidden", view !== "view-list");
  $("model-btn").classList.toggle("hidden", view !== "view-chat");
}

// ---------- A2: общий механизм отмены и таймаутов ----------
// Возвращает AbortController со встроенным таймаутом; dispose() снимает таймер
// и отписывается от родительского сигнала (иначе контроллеры копятся).
function newAbort(parent, ms) {
  const ctl = new AbortController();
  let timer = null;
  let unlink = null;
  const dispose = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (unlink) { try { unlink(); } catch (_) {} unlink = null; }
  };
  ctl.dispose = dispose;
  if (ms) timer = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, ms);
  if (parent) {
    const onParentAbort = () => { try { ctl.abort(); } catch (_) {} };
    if (parent.signal.aborted) { try { ctl.abort(); } catch (_) {} }
    else parent.signal.addEventListener("abort", onParentAbort, { once: true });
    unlink = () => { try { parent.signal.removeEventListener("abort", onParentAbort); } catch (_) {} };
  }
  return ctl;
}

function isAbort(e) { return !!(e && e.name === "AbortError"); }

function jsonPost(url, body, opts = {}) {
  const ctl = newAbort(opts.parent || null, opts.timeout || FETCH_TIMEOUT_MS);
  const dispose = () => { try { ctl.dispose(); } catch (_) {} };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ctl.signal,
  }).then((r) => {
    // A4: 502/HTML-страница ошибки больше не падает молча внутри r.json()
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }).then((j) => { dispose(); return j; }, (e) => { dispose(); throw e; });
}

function api(method, params = {}, opts = {}) {
  return jsonPost("/api/rpc", { token, method, params }, opts);
}

function watch(sid, off) {
  return jsonPost("/api/watch", { token, sessionId: sid, unwatch: !!off }, {});
}

// ---------- auth ----------
function tryAuth(t) {
  token = t;
  return api("ping", {}).then((r) => {
    if (r.ok) {
      localStorage.setItem(LS, token);
      lastError = "";
      status("подключено");
      startPolling();
      startRefreshTimer();
      refreshSessions();
      show("view-list");
      return true;
    }
    lastError = (r.error === "bridge_disconnected")
      ? "мост этого устройства ещё подключается — повтори через пару секунд"
      : "токен не подошёл или гейтвей недоступен";
    $("auth-err").textContent = lastError;
    return false;
  }).catch((e) => {
    lastError = "нет связи с гейтвеем: " + e.message;
    $("auth-err").textContent = lastError;
    return false;
  });
}

$("auth-go").onclick = async () => {
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (_) {}
  tryAuth($("token-input").value.trim());
};

// ---------- sessions ----------
function renderSessions() {
  const el = $("groups");
  const sorted = [...sessions].sort((a, b) => {
    const ta = a.orderingTime ? new Date(a.orderingTime).getTime() : Date.now();
    const tb = b.orderingTime ? new Date(b.orderingTime).getTime() : Date.now();
    return tb - ta;
  });
  const groups = groupBy(sorted);
  el.innerHTML = "";
  if (!groups.size) { el.innerHTML = "<div class='group-title'>Сессий нет</div>"; return; }
  for (const [cwd, list] of groups) {
    const g = document.createElement("div");
    g.className = "group";
    const t = document.createElement("div");
    t.className = "group-title";
    t.textContent = cwd;
    g.appendChild(t);
    list.forEach((s) => {
      const ts = orderTs(s);
      const unread = activeSession !== s.sessionId && ts > (readUpTo[s.sessionId] || 0);
      const d = document.createElement("div");
      d.className = "session" + (unread ? " unread" : "");
      const title = document.createElement("div");
      title.className = "t";
      title.textContent = cleanText(s.title || (s.externalSessionId ? "чат " + String(s.externalSessionId).slice(0, 8) : "(новый чат)"));
      if (unread) {
        const dot = document.createElement("span");
        dot.className = "unread-dot";
        title.appendChild(dot);
      }
      const sub = document.createElement("div");
      sub.className = "s";
      sub.textContent = s.orderingTime ? new Date(s.orderingTime).toLocaleString() : "сейчас";
      if (s.metadata && s.metadata.live) {
        const lv = document.createElement("span");
        lv.className = "live";
        lv.textContent = "● live";
        sub.appendChild(lv);
      }
      d.appendChild(title);
      d.appendChild(sub);
      d.onclick = () => openChat(s);
      g.appendChild(d);
    });
    el.appendChild(g);
  }
}

function groupBy(sessions) {
  const m = new Map();
  for (const s of sessions) {
    const key = s.cwd || "(без проекта)";
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(s);
  }
  return m;
}

function cleanText(s) {
  return String(s || "").replace(/[\uFFFD\uFFFE]/g, "");
}

// ---------- chat ----------
function updateAttBase() {
  // префикс URL для картинок-вложений: /api/attachment с токеном и сессией
  window.__dshAttBase = "/api/attachment?token=" + encodeURIComponent(token || "") + "&sessionId=" + encodeURIComponent(activeSession || "") + "&";
}

function openChat(s) {
  if (activeSession) watch(activeSession, true);
  activeSession = s.sessionId;
  updateAttBase();
  markRead(s.sessionId, orderTs(s));
  knownStatus = "";
  allowTw = false;
  items = new Map();
  rendered = new Set();
  nodeFor = new Map();
  noticeSig = "";
  $("approval").innerHTML = "";
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
  $("input").value = "";
  autoGrow();
  $("chat-meta").textContent = cleanText(s.title || s.cwd || "чат") + " — загрузка…";
  show("view-chat");
  watch(activeSession, false);
  const cached = loadCachedHistory(activeSession);
  if (cached && cached.length) {
    for (const it of cached) items.set(keyOf(it), it);
    fullRender();
    $("chat-meta").textContent = cleanText(s.title || s.cwd || "чат") + " — из кэша…";
  }
  loadFullHistory().then((list) => {
    for (const it of list) items.set(keyOf(it), it);
    saveHistory(activeSession, list);
    fullRender();
    lastError = "";
    $("chat-meta").textContent = cleanText(s.title || s.cwd || "чат");
    refreshActiveChat();
    loadRemoteDraft();
  }).catch((e) => {
    lastError = "ошибка загрузки истории: " + e.message;
    status(lastError);
    fullRender();
  });
}

// full history, no limit — follow cursor to exhaustion
async function loadFullHistory() {
  let out = [];
  let cursor = null;
  let seen = new Set();
  for (let i = 0; i < 300; i++) {
    const params = { sessionId: activeSession };
    if (cursor) params.cursor = cursor; // omit limit -> full history
    const r = await api("session.getSnapshot", params);
    if (!r.ok) break;
    const chunk = r.result.items || [];
    for (const it of chunk) {
      const k = keyOf(it);
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
    if (!r.result.nextCursor) break;
    cursor = r.result.nextCursor;
    if (!chunk.length) break;
  }
  return out;
}

$("back").onclick = () => {
  if (activeSession) {
    const s = sessions.find((x) => x.sessionId === activeSession);
    markRead(activeSession, orderTs(s));
    watch(activeSession, true);
  }
  activeSession = null;
  refreshSessions();
  show("view-list");
};

$("refresh").onclick = () => refreshSessions();

$("model-btn").onclick = () => openModelSheet();
$("model-close").onclick = () => $("model-sheet").classList.add("hidden");
$("model-sheet").addEventListener("click", (e) => { if (e.target === $("model-sheet")) $("model-sheet").classList.add("hidden"); });
$("attach").onclick = () => $("file-input").click();
$("file-input").addEventListener("change", (e) => handleFiles(e.target.files));

$("jumplast").onclick = () => scrollToBottom();

// ---------- items ----------
// item parsing/rendering (itemText, itemHtml, toolCardHtml, keyOf, turn.end
// helpers...) lives in itemrender.js - pure, unit-tested under node.

let lastUserText = "";

function computeLastUserText() {
  let txt = "", best = -1;
  for (const it of items.values()) {
    const o = it.orderSeq || 0;
    if (it.role === "user" && o > best) { best = o; txt = itemText(it)[1] || ""; }
  }
  lastUserText = txt;
}

function updateMsgactions() {
  const el = $("msgactions");
  if (!el) return;
  el.classList.toggle("hidden", !(activeSession && lastUserText));
  const rb = $("retry-btn");
  if (rb) rb.classList.toggle("err", !!turnHadError);
}

function retryLast() {
  if (!activeSession || !lastUserText) return;
  turnHadError = false;
  allowTw = true;
  turnT0 = Date.now();
  status("повтор хода…");
  api("session.startTurn", { sessionId: activeSession, content: lastUserText }).then((r) => {
    if (r.ok) {
      status(r.result && r.result.queued ? "агент занят - повтор в очереди…" : "повторяю, жду ответ…");
    } else {
      status("повтор не прошёл: " + (r.error || "?"));
    }
  });
}

function editLast() {
  if (!lastUserText) return;
  const el = $("input");
  el.value = lastUserText;
  autoGrow();
  el.focus();
  el.selectionStart = el.selectionEnd = el.value.length;
  status("правишь последнее сообщение");
}

function copyToClipboard(text) {
  return new Promise((resolve) => {
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        resolve(ok);
      } catch (_) { resolve(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => resolve(true)).catch(legacy);
    } else legacy();
  });
}

window.copyCode = function (btn) {
  const block = btn.closest(".codeblock");
  const codeEl = block ? block.querySelector("code") : null;
  const txt = codeEl ? codeEl.textContent : "";
  copyToClipboard(txt).then((ok) => {
    const old = btn.textContent;
    btn.textContent = ok ? "скопировано" : "ошибка";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1300);
  });
};

window.toggleTool = function (head) {
  const body = head.nextElementSibling;
  if (!body) return;
  const opening = body.hasAttribute("hidden");
  if (opening) body.removeAttribute("hidden"); else body.setAttribute("hidden", "");
  head.classList.toggle("open", opening);
  const caret = head.querySelector(".toolc");
  if (caret) caret.textContent = opening ? "▾" : "▸";
};

// ---------- markdown/escaping live in md.js (pure, unit-tested there) ----------
// tool cards / reasoning / turn.end chips live in itemrender.js (pure too) ----------

function renderOne(it) {
  const tmp = document.createElement("div");
  tmp.innerHTML = itemHtml(it);
  return tmp.firstChild;
}

function fullRender() {
  const el = $("chat-items");
  rendered = new Set();
  nodeFor = new Map();
  stopTw();
  tw = { key: null, target: "", shown: 0, node: null, timer: null, active: false };
  computeLastUserText();
  updateMsgactions();
  const ordered = [...items.values()].sort((a, b) => (a.orderSeq || 0) - (b.orderSeq || 0)).filter((it) => !isBookkeeping(it));
  el.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const it of ordered) {
    const node = renderOne(it);
    if (!node) continue;
    frag.appendChild(node);
    rendered.add(keyOf(it));
    nodeFor.set(keyOf(it), node);
  }
  if (!ordered.length) {
    const empty = document.createElement("div");
    empty.className = "msg system";
    empty.textContent = "Сообщений пока нет";
    frag.appendChild(empty);
  }
  el.appendChild(frag);
  scrollToBottom();
  updateJump();
  syncTypewriter();
}

function appendDom(arr) {
  const el = $("chat-items");
  const stick = nearBottom(el);
  const frag = document.createDocumentFragment();
  for (const it of arr) {
    const node = renderOne(it);
    if (!node) { rendered.add(keyOf(it)); continue; }
    frag.appendChild(node);
    rendered.add(keyOf(it));
    nodeFor.set(keyOf(it), node);
  }
  el.appendChild(frag);
  if (stick) el.scrollTop = el.scrollHeight;
  updateJump();
  syncTypewriter();
}

function replaceDom(it) {
  const k = keyOf(it);
  const old = nodeFor.get(k);
  if (!old) {
    if (isBookkeeping(it) || (isTurnEnd(it) && !itemText(it)[1])) return;
    fullRender();
    return;
  }
  const el = $("chat-items");
  const stick = nearBottom(el);
  if (tw.active && tw.key === k) {
    syncTypewriter();
    if (stick) el.scrollTop = el.scrollHeight;
    return;
  }
  const node = renderOne(it);
  if (!node) { old.remove(); nodeFor.delete(k); return; }
  old.replaceWith(node);
  nodeFor.set(k, node);
  if (stick) el.scrollTop = el.scrollHeight;
  syncTypewriter();
}

function mergeInto(list, isLive) {
  const add = [], upd = [];
  for (const it of list) {
    const k = keyOf(it);
    const have = items.get(k);
    if (!have) { items.set(k, it); add.push(it); }
    else if ((have.revision || 0) !== (it.revision || 0)) { items.set(k, it); upd.push(it); }
  }
  for (const it of add) { if (isErrorItem(it) || isTurnError(it)) turnHadError = true; }
  computeLastUserText();
  updateMsgactions();
  if (!add.length && !upd.length) return;
  if (isLive && rendered.size) {
    const toAdd = add.filter((it) => !rendered.has(keyOf(it))).sort((a, b) => (a.orderSeq || 0) - (b.orderSeq || 0));
    if (toAdd.length) appendDom(toAdd);
    for (const it of upd) replaceDom(it);
  } else {
    fullRender();
  }
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom() {
  const el = $("chat-items");
  el.scrollTop = el.scrollHeight;
  updateJump();
}

function updateJump() {
  const el = $("chat-items");
  if (el) $("jumplast").classList.toggle("hidden", nearBottom(el));
}

$("chat-items").addEventListener("scroll", updateJump);

let tw = { key: null, target: "", shown: 0, node: null, timer: null, active: false };

function stopTw() {
  if (tw.timer) { clearInterval(tw.timer); tw.timer = null; }
  tw.active = false;
}

function lastAssistantItem() {
  let best = null, bo = -1;
  for (const it of items.values()) {
    if (it.role !== "assistant" || (it.type && it.type !== "message")) continue;
    const o = it.orderSeq || 0;
    if (o > bo) { bo = o; best = it; }
  }
  return best;
}

function lastTurnEndItem() {
  let best = null, bo = -1;
  for (const it of items.values()) {
    if (!isTurnEnd(it)) continue;
    const o = it.orderSeq || 0;
    if (o > bo) { bo = o; best = it; }
  }
  return best;
}

function renderTwFrame() {
  if (!tw.node) return;
  const visible = tw.target.slice(0, tw.shown);
  tw.node.textContent = "";
  tw.node.appendChild(document.createTextNode(visible));
  const cur = document.createElement("span");
  cur.className = "twcur";
  cur.textContent = "\u258c";
  tw.node.appendChild(cur);
}

function twTick() {
  const el = $("chat-items");
  const stick = nearBottom(el);
  const it = items.get(tw.key);
  if (!tw.node || !tw.node.isConnected) { stopTw(); tw.key = null; tw.node = null; return; }
  if (it) tw.target = itemText(it)[1] || "";
  if (tw.shown > tw.target.length) tw.shown = tw.target.length;
  if (tw.shown >= tw.target.length) {
    if (!isWorking(knownStatus)) {
      const node = tw.node;
      stopTw();
      tw.key = null;
      tw.node = null;
      if (it && node.isConnected) {
        const fresh = renderOne(it);
        node.replaceWith(fresh);
        nodeFor.set(keyOf(it), fresh);
      }
      if (stick) scrollToBottom();
    }
    return;
  }
  const backlog = tw.target.length - tw.shown;
  const step = backlog > 1500 ? 20 : 3;
  tw.shown = Math.min(tw.target.length, tw.shown + step);
  renderTwFrame();
  if (stick) el.scrollTop = el.scrollHeight;
}

function engageTw(node, key, target) {
  if (tw.active && tw.key && tw.key !== key && tw.node && tw.node.isConnected) {
    const oldIt = items.get(tw.key);
    if (oldIt) {
      const fresh = renderOne(oldIt);
      tw.node.replaceWith(fresh);
      nodeFor.set(tw.key, fresh);
    }
  }
  stopTw();
  tw.key = key;
  tw.node = node;
  tw.target = target;
  tw.shown = 0;
  tw.active = true;
  renderTwFrame();
  tw.timer = setInterval(twTick, 30);
}

function syncTypewriter() {
  const it = lastAssistantItem();
  if (!it) { stopTw(); tw.key = null; tw.node = null; return; }
  const k = keyOf(it);
  const node = nodeFor.get(k);
  const txt = itemText(it)[1] || "";
  if (allowTw && isWorking(knownStatus) && node) {
    if (tw.key !== k || !tw.active) engageTw(node, k, txt);
    else { tw.target = txt; tw.node = node; }
  } else if (tw.key === k && tw.active) {
    tw.target = txt;
  }
}

function isWorking(s) {
  return s === "running" || s === "working" || s === "waiting" || s === "pending";
}

function applyState(st) {
  if (!st) return;
  const prev = knownStatus;
  knownStatus = st.status || knownStatus;
  if (st.selections && st.selections.model) currentModelId = st.selections.model;
  if (st.selections && st.selections.permission) currentPermissionId = st.selections.permission;
  const working = isWorking(knownStatus);
  paintBridge();
  $("send").disabled = false;
  $("interrupt").style.display = working ? "" : "none";
  let meta = "";
  if (activeSession) meta = cleanText(titleOf(activeSession) || "чат");
  const mname = modelTitle(currentModelId);
  if (mname) meta += " · " + mname;
  if (working) meta += " · думаю…";
  else if (knownStatus && knownStatus !== "idle") meta += " · " + knownStatus;
  $("chat-meta").textContent = meta;
  if (working) status("агент работает…");
  if (st.status === "waiting_approval" && isWorking(prev)) {
    notifyNow("Нужен твой ответ", titleOf(activeSession) || "агент", "appr-" + activeSession);
  }
  checkApproval(st);
  updateMsgactions();
  syncTypewriter();
}

function titleOf(sid) {
  const s = sessions.find((x) => x.sessionId === sid);
  return s ? (s.title || s.cwd) : sid;
}

// ---------- actions ----------
function autoGrow() {
  const el = $("input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}
$("input").addEventListener("input", autoGrow);
$("input").addEventListener("input", () => {
  lastTypedAt = Date.now();
  scheduleDraftOut();
});

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const val = $("input").value.trim();
  if (!activeSession) return;
  if (!val && !pendingAttachments.length) return;
  $("input").value = "";
  autoGrow();
  turnHadError = false;
  allowTw = true;
  turnT0 = Date.now();
  const atts = pendingAttachments.slice();
  pendingAttachments = [];
  renderChips();
  const params = { sessionId: activeSession, content: val, attachments: atts };
  status("отправка…");
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
  api("session.startTurn", params).then((r) => {
    if (r.ok) {
      const queued = r.result && r.result.queued;
      status(queued
        ? "агент занят - сообщение в очереди, уйдёт как освободится…"
        : "отправлено, жду ответ…");
    } else {
      $("input").value = val;
      pendingAttachments = atts;
      renderChips();
      autoGrow();
      scheduleDraftOut();
      status("не ушло: " + (r.error || "?") + " - вернула в поле");
    }
  });
};

$("interrupt").onclick = () => {
  if (!activeSession) return;
  api("session.interrupt", { sessionId: activeSession });
  status("стоп запрошен");
};

$("retry-btn").onclick = retryLast;
$("edit-btn").onclick = editLast;

// ---------- notices / questions ----------
let noticeSig = "";

function noticeFormSpec(n) {
  if (n.input && Array.isArray(n.input.questions)) return n.input;
  if (n.form && Array.isArray(n.form.questions)) return n.form;
  const acts = n.actions || [];
  for (const a of acts) {
    if (a && a.input && Array.isArray(a.input.questions)) return a.input;
  }
  return null;
}

function noticeActionOf(n, want) {
  const acts = n.actions || [];
  for (const a of acts) {
    const aid = a.actionId || a.id || a.name || "";
    if (aid === want) return { actionId: aid, input: a.input || null };
  }
  return { actionId: want, input: null };
}

function submitNotice(nid, actionId, inputData) {
  const params = { sessionId: activeSession, noticeId: nid, actionId: actionId };
  if (inputData) params.inputData = inputData;
  status(actionId === "submit" || actionId === "approve" ? "отправляю ответ…" : "отменяю запрос…");
  api("session.respondInteraction", params).then((r) => {
    if (r.ok) {
      status("ответ ушёл");
      $("approval").innerHTML = "";
      noticeSig = "";
      setTimeout(() => { if (activeSession) refreshActiveChat(); }, 500);
    } else {
      status("ответ не прошёл: " + (r.error || "?"));
      setTimeout(() => { if (activeSession) refreshActiveChat(); }, 800);
    }
  }).catch((e) => { status("ответ не прошёл: " + e.message); });
}

function questionHtml(q) {
  const prompt = String(q.prompt || q.question || "");
  const header = q.header ? `<div class="qh">${escapeHtml(q.header)}</div>` : "";
  const multi = !!q.multiple;
  const opts = Array.isArray(q.options) ? q.options : [];
  let h = `<div class="qq" data-qid="${escapeHtml(q.id)}">` + header + `<div class="qp">${escapeHtml(prompt)}</div><div class="qq-opts">`;
  for (const o of opts) {
    h += `<div class="qopt" data-oid="${escapeHtml(o.id)}" role="${multi ? "checkbox" : "radio"}" tabindex="0">` +
      `<span class="qo-mark"></span><span class="qo-body"><span class="qo-label">${escapeHtml(o.label)}</span>` +
      (o.description ? `<span class="qo-desc">${escapeHtml(o.description)}</span>` : "") +
      `</span></div>`;
  }
  h += `</div>`;
  if (q.allowCustom) h += `<input class="qcustom" type="text" placeholder="свой ответ…" autocomplete="off" />`;
  h += `</div>`;
  return h;
}

function noticeCard(n) {
  const nid = n.noticeId || n.id || "";
  const wrap = document.createElement("div");
  wrap.className = "notice";
  const title = n.title || n.question || n.text || "Нужен ответ";
  const sub = n.message || "";
  const spec = noticeFormSpec(n);
  let html = `<div class="q">${escapeHtml(title)}</div>`;
  if (sub) html += `<div class="q-sub">${escapeHtml(sub)}</div>`;
  const answers = {};
  if (spec && spec.questions.length) {
    for (const q of spec.questions) {
      answers[q.id] = { optionIds: new Set(), custom: "" };
      html += questionHtml(q);
    }
    const submitA = noticeActionOf(n, "submit");
    const cancelA = noticeActionOf(n, "cancel");
    html += `<div class="notice-actions">` +
      `<button class="btn primary" data-nid="${escapeHtml(nid)}" data-aid="${escapeHtml(submitA.actionId)}">ответить</button>` +
      (cancelA ? `<button class="btn" data-nid="${escapeHtml(nid)}" data-aid="${escapeHtml(cancelA.actionId)}">отменить</button>` : "") +
      `</div>`;
  } else {
    const acts = (n.actions || []).filter((a) => a && (a.actionId || a.id || a.name));
    if (!acts.length) return wrap;
    html += `<div class="notice-actions">` + acts.map((a) => {
      const aid = a.actionId || a.id || a.name || "";
      const lbl = a.label || a.title || a.name || aid;
      return `<button class="btn${a.style === "primary" ? " primary" : ""}" data-nid="${escapeHtml(nid)}" data-aid="${escapeHtml(aid)}">${escapeHtml(lbl)}</button>`;
    }).join("") + `</div>`;
  }
  wrap.innerHTML = html;

  for (const qEl of wrap.querySelectorAll(".qq")) {
    const qid = qEl.getAttribute("data-qid");
    const qspec = spec && spec.questions.find((x) => x.id === qid);
    const isMulti = !!(qspec && qspec.multiple);
    qEl.querySelectorAll(".qopt").forEach((opt) => {
      const pick = () => {
        const oid = opt.getAttribute("data-oid");
        const a = answers[qid];
        if (isMulti) {
          const on = opt.classList.toggle("on");
          if (on) a.optionIds.add(oid); else a.optionIds.delete(oid);
        } else {
          qEl.querySelectorAll(".qopt").forEach((o) => o.classList.remove("on"));
          opt.classList.add("on");
          a.optionIds.clear();
          a.optionIds.add(oid);
        }
      };
      opt.onclick = pick;
      opt.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
    });
    const custom = qEl.querySelector(".qcustom");
    if (custom) {
      custom.oninput = () => { answers[qid].custom = custom.value; };
    }
  }

  wrap.querySelectorAll(".notice-actions .btn").forEach((b) => {
    b.onclick = () => {
      const aid = b.getAttribute("data-aid");
      if (spec && spec.questions.length && (aid === "submit")) {
        const inputData = { answers: {} };
        let missing = false;
        for (const q of spec.questions) {
          const a = answers[q.id] || { optionIds: new Set(), custom: "" };
          const optionIds = [...a.optionIds];
          let customText = (a.custom || "").trim();
          if (!q.multiple) {
            if (optionIds.length > 1) optionIds.length = 1;
            if (optionIds.length && customText) customText = "";
          }
          const answered = optionIds.length > 0 || customText.length > 0;
          if (!answered && q.required !== false) {
            missing = true;
            const qEl = wrap.querySelector(`.qq[data-qid="${CSS.escape(q.id)}"]`);
            if (qEl) {
              qEl.classList.add("miss");
              setTimeout(() => qEl.classList.remove("miss"), 1600);
            }
          }
          inputData.answers[q.id] = { optionIds: optionIds, customText: customText };
        }
        if (missing) { status("ответь на обязательные вопросы"); return; }
        submitNotice(b.getAttribute("data-nid"), aid, inputData);
      } else {
        submitNotice(b.getAttribute("data-nid"), aid, undefined);
      }
    };
  });
  return wrap;
}

function checkApproval(state) {
  const el = $("approval");
  const waiting = state && ["waiting_approval", "waiting", "blocked", "pending", "asking"].indexOf(state.status) >= 0;
  if (!waiting || !activeSession) { el.innerHTML = ""; noticeSig = ""; return; }
  api("session.getNotices", { sessionId: activeSession }).then((r) => {
    if (!activeSession) return;
    const ns = ((r.ok && r.result && r.result.notices) || []).filter((n) => {
      const st = n.status || "open";
      return st === "open" || st === "pending";
    });
    if (!ns.length) {
      if (el.innerHTML) { el.innerHTML = ""; noticeSig = ""; }
      return;
    }
    const sig = ns.map((n) => (n.noticeId || n.id) + ":" + (n.revision || 0)).join("|");
    if (sig === noticeSig) return;
    noticeSig = sig;
    for (const n of ns) {
      const nid = n.noticeId || n.id;
      if (nid) notifyNow("Нужен твой ответ", (n.title || titleOf(activeSession) || "агент").slice(0, 120), "notice-" + nid);
    }
    el.innerHTML = "";
    for (const n of ns) el.appendChild(noticeCard(n));
  }).catch(() => {});
}

// ---------- model & permission picker ----------
function modelTitle(id) {
  if (!id) return "";
  const m = models.find((x) => x.id === id || x.selectionId === id);
  return m ? (m.title || (m.metadata && m.metadata.modelName) || "") : "";
}

function permissionTitle(id) {
  const p = permissions.find((x) => x.id === id || x.selectionId === id);
  return p ? p.title : "";
}

async function loadCatalog() {
  if (models.length && permissions.length) return;
  const [m, p] = await Promise.all([api("catalog.listModels", {}), api("catalog.listPermissions", {})]);
  if (m.ok) models = m.result.models || [];
  if (p.ok) permissions = p.result.permissions || [];
}

async function openModelSheet() {
  $("model-sheet").classList.remove("hidden");
  status("загружаю модели…");
  try { await loadCatalog(); } catch (e) { status("каталог: " + e.message); }
  renderModelSheet();
}

function renderModelSheet() {
  $("model-list").innerHTML = models.map((m) => {
    const sel = (m.id === currentModelId || m.selectionId === currentModelId);
    return `<div class="pick${sel ? " on" : ""}" data-model="${escapeHtml(m.selectionId || m.id)}">${escapeHtml(m.title || (m.metadata && m.metadata.modelName))}</div>`;
  }).join("");
  $("model-list").querySelectorAll("[data-model]").forEach((el) => {
    el.onclick = () => pickModel(el.getAttribute("data-model"));
  });
  $("perm-list").innerHTML = permissions.map((p) => {
    const sel = (p.id === currentPermissionId || p.selectionId === currentPermissionId);
    return `<div class="pick${sel ? " on" : ""}" data-perm="${escapeHtml(p.selectionId || p.id)}">${escapeHtml(p.title)}</div>`;
  }).join("");
  $("perm-list").querySelectorAll("[data-perm]").forEach((el) => {
    el.onclick = () => pickPermission(el.getAttribute("data-perm"));
  });
  $("model-current").textContent = "сейчас: " + (modelTitle(currentModelId) || "-") + " · " + (permissionTitle(currentPermissionId) || "-");
}

function pickModel(id) {
  if (!activeSession) return;
  api("session.updateSelections", { sessionId: activeSession, selections: { model: id } }).then((r) => {
    if (r.ok) { currentModelId = id; renderModelSheet(); status("модель: " + modelTitle(id)); }
    else status("не сменилось: " + (r.error || "?"));
  });
}

function pickPermission(id) {
  if (!activeSession) return;
  api("session.updateSelections", { sessionId: activeSession, selections: { permission: id } }).then((r) => {
    if (r.ok) { currentPermissionId = id; renderModelSheet(); status("доступ: " + permissionTitle(id)); }
    else status("не сменилось: " + (r.error || "?"));
  });
}

// ---------- new chat ----------
$("new-btn").onclick = openNewSheet;
$("new-close").onclick = closeNewSheet;
$("new-sheet").addEventListener("click", (e) => { if (e.target === $("new-sheet")) closeNewSheet(); });
$("new-create").onclick = createNewSession;

function openNewSheet() {
  $("new-err").textContent = "";
  $("new-text").value = "";
  $("new-sheet").classList.remove("hidden");
  api("workspace.list", {}).then((r) => {
    const ws = (r.ok && r.result && r.result.workspaces) || [];
    $("ws-list").innerHTML = ws.map((w) => `<option value="${escapeHtml(w.path)}"></option>`).join("");
    if (ws.length && !$("new-cwd").value) {
      const last = sessions[0];
      $("new-cwd").value = (last && last.cwd) || ws[0].path || "";
    }
  }).catch(() => {});
  loadCatalog().catch(() => {});
}

function closeNewSheet() { $("new-sheet").classList.add("hidden"); }

function createNewSession() {
  const cwd = $("new-cwd").value.trim();
  if (!cwd) { $("new-err").textContent = "укажи папку (cwd)"; return; }
  if (!models.length || !permissions.length) { $("new-err").textContent = "каталог ещё грузится, повтори"; return; }
  const sessionId = "session-" + uuid();
  const clientMessageId = "c-" + uuid();
  const content = $("new-text").value.trim() || "привет";
  const params = {
    sessionId,
    content,
    clientMessageId,
    cwd,
    selections: {
      model: currentModelId || models[0].selectionId || models[0].id || "",
      permission: currentPermissionId || permissions[0].selectionId || permissions[0].id || "",
    },
    agentPreset: "standard",
  };
  status("создаю чат…");
  $("new-create").disabled = true;
  api("session.createAndStart", params).then((r) => {
    if (r.ok && r.result && r.result.accepted) {
      closeNewSheet();
      sessions.unshift({ sessionId, title: content, cwd });
      renderSessions();
      openChat({ sessionId, title: content, cwd });
    } else {
      const msg = (r.result && (r.result.message || r.result.code)) || r.error || "не вышло";
      $("new-err").textContent = "ошибка: " + msg;
    }
    $("new-create").disabled = false;
  }).catch((e) => {
    $("new-err").textContent = "ошибка: " + e.message;
    $("new-create").disabled = false;
  });
}

function uuid() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    if (window.crypto && crypto.getRandomValues) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = (arr) => Array.from(arr).map((x) => x.toString(16).padStart(2, "0")).join("");
      return h(b.slice(0, 4)) + "-" + h(b.slice(4, 6)) + "-" + h(b.slice(6, 8)) + "-" + h(b.slice(8, 10)) + "-" + h(b.slice(10, 16));
    }
  } catch (_) {}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------- attachments ----------
function renderChips() {
  const el = $("attach-chips");
  if (!pendingAttachments.length) { el.innerHTML = ""; el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = pendingAttachments.map((a, i) => {
    const thumb = (a.isImage && a.preview)
      ? `<img class="chip-thumb" src="${a.preview}" alt="" />`
      : `<span class="chip-ico">${a.mediaType && a.mediaType.startsWith("audio/") ? "🎙" : (a.isImage ? "🖼" : "📄")}</span>`;
    return `<span class="chip">${thumb}<span class="chip-name">${escapeHtml(a.name)}</span><button class="chip-x" data-i="${i}">✕</button></span>`;
  }).join("");
  el.querySelectorAll(".chip-x").forEach((b) => {
    b.onclick = () => { pendingAttachments.splice(Number(b.getAttribute("data-i")), 1); renderChips(); };
  });
}

async function handleFiles(files) {
  for (const f of files) {
    if (!f) continue;
    status("заливаю: " + f.name + "…");
    try {
      let file = f;
      if ((f.type || "").startsWith("image/")) {
        try { file = await prepareImage(f); } catch (_) { file = f; }
      }
      const data = await readFileBase64(file);
      const isImage = (file.type || "").startsWith("image/");
      const fullUrl = "data:" + (file.type || "application/octet-stream") + ";base64," + data;
      let preview = fullUrl;
      if (isImage) { try { preview = await makeThumb(fullUrl); } catch (_) { preview = fullUrl; } }
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: file.name, mediaType: file.type || "application/octet-stream", data }),
      }).then((x) => x.json());
      if (r.ok) {
        pendingAttachments.push(Object.assign({}, r.attachment, { isImage, preview }));
        renderChips();
        status("добавлено: " + file.name + (file !== f ? " (сжато до jpeg)" : ""));
      } else {
        status("не загрузилось: " + (r.error || "?"));
      }
    } catch (e) {
      status("ошибка файла: " + e.message);
    }
  }
  $("file-input").value = "";
  $("cam-input").value = "";
}

// фото с камеры телефона: HEIC/тяжёлые -> сжатый JPEG, который читает агент
function loadImgEl(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("не декодируется"));
    i.src = url;
  });
}

async function prepareImage(f) {
  const heavy = f.size > 1200 * 1024;
  const exotic = /heic|heif/i.test(f.type + " " + f.name) || !/jpeg|png|webp|gif/i.test(f.type || "");
  if (!heavy && !exotic) return f;
  const url = URL.createObjectURL(f);
  try {
    const img = await loadImgEl(url);
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return f;
    const maxSide = 2048;
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * s));
    const h = Math.max(1, Math.round(h0 * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (!blob || blob.size >= f.size) return f;
    const base = String(f.name || "photo").replace(/\.[^.]+$/, "");
    return new File([blob], base + ".jpg", { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeThumb(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const max = 160;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        const s = Math.min(1, max / Math.max(w, h));
        w = Math.max(1, Math.round(w * s));
        h = Math.max(1, Math.round(h * s));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.75));
      } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = url;
  });
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------- camera ----------
$("cam").onclick = () => $("cam-input").click();
$("cam-input").addEventListener("change", (e) => handleFiles(e.target.files));

// ---------- voice input: диктовка (Web Speech) или голосовое сообщение (MediaRecorder) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recog = null, recActive = false, recBase = "";
let mediaRec = null, mediaChunks = [], mediaTimer = null;

function pickRecMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  const list = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
  return "";
}

function stopVoiceMemo() {
  if (mediaRec && mediaRec.state !== "inactive") { try { mediaRec.stop(); } catch (_) {} }
}

async function startVoiceMemo() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    status("микрофон не дан: " + (e.name || "нет доступа"));
    return;
  }
  const mime = pickRecMime();
  try { mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (_) { mediaRec = new MediaRecorder(stream); }
  mediaChunks = [];
  const t0 = Date.now();
  recActive = true;
  $("mic").classList.add("rec");
  status("пиши голосовое… ещё раз нажми, чтобы отправить в чат");
  mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) mediaChunks.push(e.data); };
  mediaRec.onstop = async () => {
    recActive = false;
    $("mic").classList.remove("rec");
    clearInterval(mediaTimer); mediaTimer = null;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(mediaChunks, { type: mediaRec.mimeType || "audio/mp4" });
    if (!blob.size) { status("пустая запись"); return; }
    const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const ext = /webm/i.test(blob.type) ? "webm" : "m4a";
    const d = new Date();
    const p = (n) => (n < 10 ? "0" : "") + n;
    const name = "voice-" + p(d.getHours()) + p(d.getMinutes()) + "-" + sec + "s." + ext;
    const file = new File([blob], name, { type: blob.type });
    status("голосовое " + sec + "с - прицепляю…");
    await handleFiles([file]);
  };
  mediaRec.start();
  mediaTimer = setInterval(() => {
    if (mediaRec && mediaRec.state === "recording") status("пиши голосовое… " + Math.round((Date.now() - t0) / 1000) + "с");
  }, 5000);
}

$("mic").onclick = () => {
  if (recActive) {
    if (recog) { try { recog.stop(); } catch (_) {} }
    stopVoiceMemo();
    return;
  }
  if (!window.isSecureContext) { status("микрофону нужен https - включи TLS на узле"); return; }
  if (SR) { startVoice(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    status("запись голоса в этом браузере не поддерживается");
    return;
  }
  startVoiceMemo();
};

function startVoice() {
  recActive = true;
  recBase = $("input").value ? $("input").value.replace(/\s+$/, "") + " " : "";
  $("mic").classList.add("rec");
  recog = new SR();
  const navLang = (navigator.language || "ru").toLowerCase();
  recog.lang = navLang.startsWith("ru") ? "ru-RU" : (navigator.language || "ru-RU");
  recog.continuous = false;
  recog.interimResults = true;
  recog.onresult = (e) => {
    let interim = "", fin = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
    }
    if (fin) recBase += fin + " ";
    $("input").value = recBase + interim;
    autoGrow();
    if (interim) status("слышу: " + interim.slice(0, 60));
  };
  recog.onend = () => {
    recActive = false;
    $("mic").classList.remove("rec");
    $("input").value = recBase;
    autoGrow();
    status("запись закончена");
    try { $("input").focus(); } catch (_) {}
  };
  recog.onerror = (e) => {
    recActive = false;
    $("mic").classList.remove("rec");
    status("микрофон: " + e.error);
  };
  try { recog.start(); status("говори…"); } catch (e) { status("микрофон: " + (e.error || "занят")); }
}

// ---------- session stats ----------
function statsKey(sid) { return "dsh-phone-stats-" + sid; }

function loadStats(sid) {
  try { return JSON.parse(localStorage.getItem(statsKey(sid)) || "{}") || {}; } catch (_) { return {}; }
}

function saveStats(sid, st) {
  try { localStorage.setItem(statsKey(sid), JSON.stringify(st)); } catch (_) {}
}

function bumpStat(sid, patch) {
  const st = loadStats(sid);
  for (const k in patch) st[k] = (st[k] || 0) + patch[k];
  saveStats(sid, st);
}

function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "с";
  const m = Math.floor(s / 60);
  return m + "м " + ("0" + Math.floor(s % 60)).slice(-2) + "с";
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtCost(usd) {
  if (usd < 0.01) return "$" + (usd * 100).toFixed(1) + "c";
  return "$" + usd.toFixed(usd < 1 ? 3 : 2);
}

// тариф deepseek-чат на 1M токенов: вход/выход
const PRICE_IN = 0.27, PRICE_OUT = 1.10;

function findUsage(it) {
  if (!it || typeof it !== "object") return null;
  const cands = [it.usage, it.stats, it.credits, it.metadata && it.metadata.usage];
  const c = it.content;
  if (c && typeof c === "object") cands.push(c.usage, c.credits, c.metadata && c.metadata.usage);
  for (const u of cands) {
    if (!u || typeof u !== "object") continue;
    const pin = u.promptTokens ?? u.input_tokens ?? u.inputTokens ?? u.prompt_tokens;
    const pout = u.completionTokens ?? u.output_tokens ?? u.outputTokens ?? u.completion_tokens;
    if (typeof pin === "number" || typeof pout === "number") {
      return {
        in: typeof pin === "number" ? pin : 0,
        out: typeof pout === "number" ? pout : 0,
      };
    }
  }
  return null;
}

function harvestUsage(ordered) {
  let inT = 0, outT = 0, found = false;
  for (const it of ordered) {
    const u = findUsage(it);
    if (u) { found = true; inT += u.in; outT += u.out; }
  }
  return { inT, outT, found };
}

function orderedItems() {
  return [...items.values()].sort((a, b) => (a.orderSeq || 0) - (b.orderSeq || 0)).filter((it) => !isBookkeeping(it));
}

function refreshStats() {
  const el = $("menu-stats");
  if (!el) return;
  if (!activeSession) {
    el.innerHTML = '<div class="menu-row"><span>открой чат</span><span>—</span></div>';
    return;
  }
  const ordered = orderedItems();
  const userN = ordered.filter((it) => it.role === "user").length;
  const asstN = ordered.filter((it) => it.role === "assistant").length;
  const st = loadStats(activeSession);
  const avg = st.turns ? st.turnMs / st.turns : 0;
  const u = harvestUsage(ordered);
  let tokLine, costLine;
  if (u.found && (u.inT || u.outT)) {
    tokLine = fmtNum(u.inT) + " вх / " + fmtNum(u.outT) + " вых";
    costLine = fmtCost(u.inT * PRICE_IN / 1e6 + u.outT * PRICE_OUT / 1e6) + " · deepseek-тариф";
  } else {
    let chars = 0;
    for (const it of ordered) {
      if (it.role === "user" || it.role === "assistant") chars += (itemText(it)[1] || "").length;
    }
    const approx = Math.round(chars / 4);
    tokLine = "≈ " + fmtNum(approx) + " · оценка";
    costLine = "≈ " + fmtCost(approx * ((PRICE_IN + PRICE_OUT) / 2) / 1e6);
  }
  const row = (k, v) => '<div class="menu-row"><span>' + escapeHtml(k) + '</span><span>' + escapeHtml(v) + '</span></div>';
  el.innerHTML =
    row("ходов (мои)", String(userN)) +
    row("ответов", String(asstN)) +
    row("ср. ход", st.turns ? fmtDur(st.turnMs / st.turns) : (avg ? fmtDur(avg) : "—")) +
    row("время при тебе", st.turns ? fmtDur(st.turnMs) : "—") +
    row("токены", tokLine) +
    row("стоимость", costLine);
}

window.dshMenuOpen = function () {
  refreshStats();
  pushStateLabel();
};

// ---------- export ----------
function slugify(s) {
  const base = cleanText(s).replace(/[^\wа-яА-ЯёЁ\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 48);
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  return (base || "chat") + "-" + stamp;
}

function mdText(t) { return String(t == null ? "" : t).trim(); }

function chatToMarkdown(title, s, ordered) {
  const L = [];
  L.push("# " + title);
  if (s && s.cwd) L.push("", "> рабочая папка: `" + s.cwd + "`");
  L.push("", "_DSH Phone · экспорт " + new Date().toLocaleString() + " · сообщений: " + ordered.length + "_", "", "---");
  for (const it of ordered) {
    const role = it.role || "system";
    const t = itemText(it);
    const ts = it.orderingTime ? " · " + new Date(it.orderingTime).toLocaleString() : "";
    if (role === "user") { L.push("", "## Я" + ts, "", mdText(t[1])); }
    else if (role === "assistant") { L.push("", "## Агент" + ts, "", mdText(t[1])); }
    else if (t[0] === "tool") {
      const raw = t[1] || "";
      const nl = raw.indexOf("\n");
      const head = mdText(nl >= 0 ? raw.slice(0, nl) : raw);
      L.push("", "<details><summary>🔧 " + head + "</summary>", "", "```", raw, "```", "</details>");
    }
    else if (t[0] === "reasoning") { L.push("", "## Размышления" + ts, "", mdText(t[1])); }
    else { L.push("", "## · система", "", mdText(t[1])); }
  }
  return L.join("\n") + "\n";
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) {} }, 4000);
  status("выгружено: " + name);
}

function shareOrDownload(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).then(() => status("отправлено: " + name)).catch(() => downloadBlob(blob, name));
      return;
    }
  } catch (_) {}
  downloadBlob(blob, name);
}

function exportChat(kind) {
  if (!activeSession) { status("открой чат для экспорта"); return; }
  const ordered = orderedItems();
  if (!ordered.length) { status("чат пуст — нечего выгружать"); return; }
  const s = sessions.find((x) => x.sessionId === activeSession);
  const title = cleanText((s && (s.title || s.cwd)) || "чат");
  const name = "dsh-" + slugify(title) + (kind === "json" ? ".json" : ".md");
  let blob;
  if (kind === "json") {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "dsh-phone",
      session: s || { sessionId: activeSession },
      items: ordered,
    };
    blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  } else {
    blob = new Blob([chatToMarkdown(title, s, ordered)], { type: "text/markdown" });
  }
  shareOrDownload(blob, name);
}

if ($("menu-export-md")) $("menu-export-md").onclick = () => exportChat("md");
if ($("menu-export-json")) $("menu-export-json").onclick = () => exportChat("json");

// ---------- push notifications (Web Push, VAPID) ----------
let pushSub = null;

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// Почему не работает: точная причина вместо «браузер не умеет».
function pushUnsupportedReason() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const secure = window.isSecureContext === true;
  if (isIOS && !standalone) {
    return "iOS: пуши только из установленного приложения - Safari → Поделиться → «На экран Домой», открой оттуда";
  }
  if (!secure && location.protocol !== "https:") {
    return "нужен HTTPS: включи тумблер TLS в конфиге узла и зайди по https:// (пуши в браузерах только по https)";
  }
  if (!("Notification" in window) || !("PushManager" in window)) {
    return "этот браузер без Web Push - поставь PWA на домашний экран или поставь ntfy-приложение";
  }
  if (!("serviceWorker" in navigator)) {
    return "браузер без Service Worker - Web Push недоступен";
  }
  return "браузер не умеет пушей";
}

// The SW re-subscribes on its own (pushsubscriptionchange) and needs the token,
// which localStorage cannot provide to it - so we mirror it into IndexedDB.
function idbSetToken() {
  try {
    const rq = indexedDB.open("dsh-phone", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(token, "token");
      tx.oncomplete = () => db.close();
    };
  } catch (_) {}
}

function pushStateLabel() {
  const el = $("push-state");
  if (!el) return;
  if (!pushSupported()) { el.textContent = "нет"; return; }
  navigator.serviceWorker.ready
    .then((reg) => reg.pushManager.getSubscription())
    .then((s) => { pushSub = s || null; el.textContent = s ? "вкл" : "выкл"; })
    .catch(() => { el.textContent = "?"; });
}

async function enablePush() {
  if (!pushSupported()) { status("пуши: " + pushUnsupportedReason()); return; }
  if (window.isSecureContext !== true) { status("пуши: " + pushUnsupportedReason()); return; }
  let perm = "default";
  try { perm = await Notification.requestPermission(); } catch (_) {}
  if (perm !== "granted") { status("пуши: разрешение не дано"); return; }
  const r = await fetch("/api/push/info?token=" + encodeURIComponent(token)).then((x) => x.json()).catch(() => null);
  if (!r || !r.ok || !r.vapid_public) { status("пуши: узел не отдал ключ"); return; }
  const reg = await navigator.serviceWorker.ready;
  const old = await reg.pushManager.getSubscription();
  if (old) { try { await old.unsubscribe(); } catch (_) {} }
  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8(r.vapid_public),
    });
    const j = sub.toJSON();
    const resp = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        endpoint: sub.endpoint,
        p256dh: j.keys && j.keys.p256dh,
        auth: j.keys && j.keys.auth,
        device: (navigator.userAgent || "").slice(0, 40),
      }),
    }).then((x) => x.json());
    if (!resp.ok) throw new Error(resp.error || "узел не принял подписку");
    pushSub = sub;
    idbSetToken();
    status("пуши включены - узел постучит сам");
  } catch (e) {
    status("пуши: " + (e.message || "не подписалось"));
  }
  pushStateLabel();
}

async function disablePush() {
  try {
    let sub = pushSub;
    if (!sub) {
      const reg = await navigator.serviceWorker.ready;
      sub = await reg.pushManager.getSubscription();
    }
    if (sub) {
      const ep = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, endpoint: ep }),
      }).catch(() => {});
    }
    pushSub = null;
  } catch (_) {}
  status("пуши выключены");
  pushStateLabel();
}

if ($("menu-push")) {
  $("menu-push").onclick = () => { if (pushSub) disablePush(); else enablePush(); };
}

// Экспортируем снятие подписки, чтобы «Стереть ключ доступа» в index.html мог
// удалить push-эндпоинт с узла, а не только локальные данные.
window.dshDisablePush = disablePush;

// S5: sw.js на клик по уведомлению постит {type:"dsh-open-session",sessionId}.
// Открываем нужную сессию, чтобы тап по пушу вёл в диалог, а не на главную.
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = (e && e.data) || {};
    if (d.type !== "dsh-open-session" || !d.sessionId) return;
    const s = (typeof sessions !== "undefined" && sessions || []).find((x) => x && x.sessionId === d.sessionId);
    if (s) openChat(s);
  });
}

// Быстрые шаблоны промптов: клик по чипу дописывает текст в поле ввода и
// закрывает меню. Делегирование на document — чипы живут в menu-sheet.
document.addEventListener("click", (e) => {
  const chip = e.target.closest && e.target.closest(".tpl-chip");
  if (!chip) return;
  const tpl = chip.getAttribute("data-tpl") || "";
  const inp = $("input");
  if (inp && tpl) {
    inp.value = inp.value.trim() ? inp.value.replace(/\s+$/, "") + " " + tpl : tpl;
    if (typeof autoGrow === "function") autoGrow();
    inp.focus();
  }
  const menu = $("menu-sheet");
  if (menu) menu.classList.add("hidden");
});

// ---------- events long-poll ----------
function processEvent(ev) {
  if (ev.type === "bridge") {
    bridgeOn = ev.data.status === "connected";
    // push от web-половины плагина помечен source:"plugin"; остальное - TCP-мост
    bridgeChannel = !bridgeOn ? "" : (ev.data.source === "plugin" ? "plugin" : "tcp");
    paintBridge();
  }
  else if (ev.type === "sessions") { sessions = ev.data.sessions || []; renderSessions(); }
  else if (ev.type === "state" && ev.data.sessionId === activeSession) { applyState(ev.data.state); }
  else if (ev.type === "draft") { applyRemoteDraft(ev.data); }
  else if (ev.type === "items" && ev.data.sessionId === activeSession) {
    mergeInto(ev.data.items, true);
    for (const it of ev.data.items || []) { if (isErrorItem(it) || isTurnError(it)) turnHadError = true; }
  }
  else if (ev.type === "turnEnded") {
    const sid = ev.data && ev.data.sessionId;
    if (sid === activeSession && turnT0) {
      const dur = Date.now() - turnT0;
      bumpStat(sid, { turnMs: dur, turns: 1 });
      status("ход занял " + fmtDur(dur));
      turnT0 = 0;
    }
    const isActive = sid === activeSession;
    const err = isActive && turnHadError;
    let extra = "";
    if (err) {
      const te = lastTurnEndItem();
      if (te) { const info = turnEndInfo(te); if (info.msg) extra = info.msg.slice(0, 160); }
    }
    notifyNow(err ? "Работа не закончена" : "Работа закончена", extra || titleOf(sid) || "агент", "turn-" + (sid || "x"));
    if (isActive) {
      turnHadError = false;
      setTimeout(() => { if (activeSession === sid) refreshActiveChat(); }, 300);
    }
  }
}

async function pollLoop() {
  // A1: флаг жизни проверяется и до запроса, и после — вторая цепочка не выживает
  if (!pollOn) return;
  let got = 0, failed = false;
  const ctl = newAbort(null, EVENTS_TIMEOUT_MS);
  pollAbort = ctl;
  try {
    const r = await fetch(`/api/events?since=${since}&had=1`, {
      headers: { "X-Dsh-Token": token },
      signal: ctl.signal,
    }).then((x) => {
      if (!x.ok) throw new Error("http " + x.status);
      return x.json();
    });
    if (!pollOn) return;
    // A1: курсор сдвигаем только на своём ответе и только числом
    if (r && typeof r.ts === "number") since = r.ts;
    const evs = (r && r.events) || [];
    evs.forEach(processEvent);
    got = evs.length;
    lastError = "";
  } catch (e) {
    try { ctl.dispose(); } catch (_) {}
    if (pollAbort === ctl) pollAbort = null;
    // отмена (pagehide/stopPolling/таймаут) — это не сбой и не повод продолжать
    if (!pollOn || isAbort(e)) return;
    lastError = "события: " + e.message;
    failed = true;
  }
  try { ctl.dispose(); } catch (_) {}
  if (pollAbort === ctl) pollAbort = null;
  if (!pollOn) return;
  if (activeSession) status(bridgeOn ? (isWorking(knownStatus) ? "агент работает…" : (knownStatus === "waiting_approval" ? "ждёт ответа…" : (knownStatus && knownStatus !== "idle" ? knownStatus : "чат"))) : "мост отключён" + (lastError ? " · " + lastError : ""));
  // A14: в скрытой вкладке будим узел и радио заметно реже
  const floor = document.hidden ? (failed ? 15000 : 30000) : 0;
  const delay = Math.max(floor, failed ? 2500 : (got ? 60 : 900));
  pollTimer = setTimeout(pollLoop, delay);
}

// A1: единственная точка входа. Прежний guard смотрел на pollTimer, а он
// присваивается только ПОСЛЕ await — второй тап запускал вторую вечную цепочку.
function startPolling() {
  if (pollOn) return;
  pollOn = true;
  pollTimer = null;
  pollLoop();
}

function stopPolling() {
  pollOn = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (pollAbort) {
    try { pollAbort.abort(); } catch (_) {}
    try { pollAbort.dispose(); } catch (_) {}
    pollAbort = null;
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  const busy = activeSession && (isWorking(knownStatus) || knownStatus === "waiting_approval" || knownStatus === "asking");
  // A14: скрытая вкладка — редкий режим
  const base = busy ? 2500 : 7000;
  const delay = document.hidden ? Math.max(base, 30000) : base;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    try {
      if (!activeSession) refreshSessions();
      else refreshActiveChat();
    } finally {
      scheduleRefresh();
    }
  }, delay);
}

function startRefreshTimer() { scheduleRefresh(); }

// A2/A3: sid и эпоха фиксируются на входе, ответы чужого чата отбрасываются;
// in-flight guard не даёт запросу из 4 разных мест наслаиваться лавиной.
function refreshActiveChat(sidArg, epArg) {
  const sid = sidArg || activeSession;
  if (!sid) return;
  const ep = (epArg === undefined || epArg === null) ? chatEpoch : epArg;
  if (ep !== chatEpoch || sid !== activeSession) return;
  if (refreshInFlight) { refreshQueued = true; return; }
  refreshInFlight = true;
  const parent = chatAbort;
  const opts = { parent: parent };
  const stale = () => ep !== chatEpoch || sid !== activeSession;
  const finish = () => {
    refreshInFlight = false;
    if (refreshQueued) { refreshQueued = false; refreshActiveChat(sid, ep); }
  };
  api("session.getState", { sessionId: sid }, opts).then((rs) => {
    if (!stale() && rs && rs.ok && rs.result) applyState(rs.result, sid);
  }).catch(() => {}).then(() => {
    if (stale()) { finish(); return null; }
    return api("session.getSnapshot", { sessionId: sid, limit: 200 }, opts).then((r) => {
      if (!stale() && r && r.ok && r.result && r.result.items) mergeInto(r.result.items, true);
    }).catch(() => {}).then(finish, finish);
  }, finish);
}

function refreshSessions() {
  api("session.list", { limit: 1000 }).then((r) => {
    if (r && r.ok) {
      sessions = (r.result && r.result.sessions) || [];
      renderSessions();
      saveSessionsCache(sessions);
    } else { lastError = "список сессий: " + ((r && r.error) || "?"); status(lastError); }
  }).catch((e) => { lastError = "список сессий: " + e.message; status(lastError); });
}

// ---------- boot ----------
// QR-подключение кладёт токен в hash-фрагмент (#t=...). Фрагмент не уходит на
// сервер и не попадает в историю запросов, поэтому читаем его один раз при
// загрузке и сразу вычищаем из адресной строки - чтобы секрет не остался
// висеть в omnibox и не улетел при шаринге ссылки.
function takeTokenFromHash() {
  let h = "";
  try { h = window.location.hash || ""; } catch (_) { return ""; }
  const m = h.match(/(?:^|[#&])t=([A-Za-z0-9]+)/);
  if (!m) return "";
  const t = m[1];
  try {
    // history.replaceState чистит hash без перезагрузки страницы
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch (_) {}
  return t;
}

async function boot() {
  // QR-токен из hash приоритетнее сохранённого: так повторное сканирование
  // перевязывает устройство даже если старый токен уже не подходит
  const hashToken = takeTokenFromHash();
  if (hashToken) token = hashToken;
  // sw.js is network-first: it never serves a stale app shell, only acts as
  // an offline fallback - so we keep it registered instead of tearing it down.
  if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("/sw.js").catch(() => {}); } catch (_) {}
  }
  const cs = loadCachedSessions();
  if (cs && cs.length) { sessions = cs; renderSessions(); }
  const h = await fetch("/api/health").then((r) => r.json()).catch(() => ({ ok: false, bridge: "disconnected" }));
  bridgeOn = h.bridge === "connected";
  bridgeChannel = h.bridgeChannel || (h.pluginBridge && h.pluginBridge.alive ? "plugin" : "");
  paintBridge();
  if (token) {
    const ok = await tryAuth(token);
    if (ok) return;
    // вход не прошёл (мост ещё поднимается или токен сменился) - оставляем его
    // в поле, чтобы можно было нажать «подключить» ещё раз, а не набирать
    // 32 символа руками: в этом и весь смысл QR
    if (hashToken) { try { $("token-input").value = hashToken; } catch (_) {} }
  }
  show("view-auth");
}

boot();