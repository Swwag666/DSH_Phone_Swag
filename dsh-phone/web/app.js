"use strict";
const LS = "dsh-phone-token";
let token = localStorage.getItem(LS) || "";
let bridgeOn = false;
let sessions = [];
let activeSession = null;
let items = new Map();       // key -> item
let rendered = new Set();    // keys already in DOM
let nodeFor = new Map();     // key -> DOM node
let knownStatus = "";
let since = 0;
let pollTimer = null;
let refreshTimer = null;
let lastError = "";
let models = [];
let permissions = [];
let currentModelId = null;
let currentPermissionId = null;
let pendingAttachments = [];
let turnHadError = false;
let readUpTo = (() => { try { return JSON.parse(localStorage.getItem("dsh-phone-read") || "{}"); } catch (_) { return {}; } })();

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

function api(method, params = {}) {
  return fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, method, params }),
  }).then((r) => r.json());
}

function watch(sid, off) {
  return fetch("/api/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, sessionId: sid, unwatch: !!off }),
  }).then((r) => r.json());
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
    lastError = "токен не подошёл или гейтвей недоступен";
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
function openChat(s) {
  if (activeSession) watch(activeSession, true);
  activeSession = s.sessionId;
  markRead(s.sessionId, orderTs(s));
  knownStatus = "";
  items = new Map();
  rendered = new Set();
  nodeFor = new Map();
  $("chat-meta").textContent = cleanText(s.title || s.cwd || "чат") + " — загрузка…";
  show("view-chat");
  watch(activeSession, false);
  loadFullHistory().then((list) => {
    for (const it of list) items.set(keyOf(it), it);
    fullRender();
    lastError = "";
    $("chat-meta").textContent = cleanText(s.title || s.cwd || "чат");
    api("session.getState", { sessionId: activeSession }).then((rs) => { if (rs.ok) applyState(rs.result); });
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
function keyOf(it) {
  return it.id || ("k-" + (it.turnId || "") + "-" + (it.orderSeq ?? "") + "-" + (it.contentHash || ""));
}

function itemText(it) {
  const c = it.content;
  if (it.type === "tool" || (c && typeof c === "object" && (c.toolName || c.name || c.kind === "tool_use"))) {
    const nm = (c && (c.toolName || c.name)) || it.toolName || it.name || "tool";
    let out = nm + (it.status ? " · " + it.status : "");
    let res = "";
    if (c) {
      if (typeof c.output === "string") res = c.output;
      else if (Array.isArray(c.result)) res = c.result.map((o) => (o && typeof o.text === "string" ? o.text : "")).join(" ");
      else if (typeof c.text === "string") res = c.text;
    }
    if (res) out += "\n" + res.slice(0, 2000);
    return ["tool", out];
  }
  if (typeof c === "string") return ["markdown", c];
  if (c && typeof c === "object") {
    if (typeof c.text === "string") {
      const kind = (c.kind === "reasoning" || c.kind === "thinking") ? "reasoning" : "markdown";
      return [kind, c.text];
    }
    const blocks = Array.isArray(c) ? c : (c.blocks || c.parts || c.content || []);
    if (Array.isArray(blocks)) {
      const txt = blocks.map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof b.text === "string") return b.text;
        if (b && typeof b === "object" && b.type === "text") return b.text || "";
        return "";
      }).filter(Boolean).join("\n");
      if (txt) return ["markdown", txt];
    }
    return ["markdown", JSON.stringify(c)];
  }
  if (typeof it.text === "string") return ["markdown", it.text];
  return ["markdown", JSON.stringify(it)];
}

function isBookkeeping(it) {
  return it.type === "marker" || (it.type || "").indexOf("turn.") === 0;
}

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
  status("повтор хода…");
  api("session.startTurn", { sessionId: activeSession, content: lastUserText }).then((r) => {
    status(r.ok ? "повторяю, жду ответ…" : "ошибка: " + (r.error || "?"));
    if (!r.ok) alert("ошибка: " + (r.error || "?"));
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

function highlightCode(code) {
  let s = escapeHtml(String(code == null ? "" : code));
  s = s.replace(/((?:&quot;|")[^"\n]*(?:&quot;|"))/g, '<span class="tk-str">$1</span>');
  s = s.replace(/(\/\/[^\n]*)/g, '<span class="tk-com">$1</span>');
  s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tk-com">$1</span>');
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tk-num">$1</span>');
  s = s.replace(/\b(fn|function|const|let|var|return|if|else|for|while|loop|match|import|from|export|async|await|def|class|new|try|catch|throw|use|pub|struct|impl|trait|self|Some|None|Ok|Err|true|false|null|undefined|typeof|static|mut|print)\b/g, '<span class="tk-kw">$1</span>');
  return s;
}

function renderCodeBlock(code, lang) {
  const label = escapeHtml(lang && lang.trim() || "code");
  return `<div class="codeblock"><div class="codehead"><span class="codelang">${label}</span><button class="copycode" type="button" onclick="copyCode(this)">копия</button></div><pre><code>${highlightCode(code)}</code></pre></div>`;
}

function renderInline(s) {
  // input assumed already HTML-escaped
  s = s.replace(/`([^`\n]+)`/g, '<code class="ci">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function renderTableHtml(rows) {
  const parse = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = parse(rows[0]);
  const body = rows.slice(1).filter((r) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(r));
  let html = "<table><thead><tr>" + header.map((c) => "<th>" + renderInline(escapeHtml(c)) + "</th>").join("") + "</tr></thead><tbody>";
  for (const r of body) {
    const cells = parse(r);
    html += "<tr>" + header.map((_, i) => "<td>" + renderInline(escapeHtml(cells[i] || "")) + "</td>").join("") + "</tr>";
  }
  return html + "</tbody></table>";
}

function renderMarkdown(src) {
  const blocks = [];
  let input = String(src == null ? "" : src);
  input = input.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const i = blocks.length;
    blocks.push({ lang: lang.trim(), code });
    return "\u0000B" + i + "\u0000";
  });

  const lines = input.split("\n");
  const out = [];
  let inList = null;
  let tableRows = [];
  let para = [];

  const flushPara = () => { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };
  const closeList = () => { if (inList) { out.push("</" + inList + ">"); inList = null; } };
  const flushTable = () => {
    if (tableRows.length >= 2) out.push(renderTableHtml(tableRows));
    else if (tableRows.length) out.push("<p>" + tableRows.map((r) => renderInline(escapeHtml(r))).join("<br>") + "</p>");
    tableRows = [];
  };

  for (const raw of lines) {
    const line = raw;
    if (/^\u0000B\d+\u0000$/.test(line)) { flushPara(); closeList(); flushTable(); out.push(line); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); closeList(); tableRows.push(line); continue; }
    if (tableRows.length) flushTable();
    if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
    let m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flushPara(); closeList();
      const lvl = Math.min(m[1].length + 1, 4);
      out.push("<h" + lvl + ">" + renderInline(escapeHtml(m[2])) + "</h" + lvl + ">");
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }
    if (/^>\s?/.test(line)) {
      flushPara(); closeList();
      out.push("<blockquote>" + renderInline(escapeHtml(line.replace(/^>\s?/, ""))) + "</blockquote>");
      continue;
    }
    m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (m) {
      flushPara();
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push("<li>" + renderInline(escapeHtml(m[1])) + "</li>");
      continue;
    }
    m = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (m) {
      flushPara();
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push("<li>" + renderInline(escapeHtml(m[1])) + "</li>");
      continue;
    }
    closeList();
    para.push(renderInline(escapeHtml(line)));
  }
  flushPara(); closeList(); flushTable();

  let html = out.join("\n");
  html = html.replace(/\u0000B(\d+)\u0000/g, (m, i) => renderCodeBlock(blocks[+i].code, blocks[+i].lang));
  return html;
}

function itemHtml(it) {
  const role = it.role || "system";
  const t = itemText(it);
  let cls = "msg ";
  let body;
  if (role === "user") { cls += "user"; body = escapeHtml(t[1] || "").replace(/\n/g, "<br>"); }
  else if (t[0] === "tool") {
    cls += "tool";
    const raw = t[1] || "";
    const nl = raw.indexOf("\n");
    const title = nl >= 0 ? raw.slice(0, nl) : raw;
    const rest = nl >= 0 ? raw.slice(nl + 1) : "";
    body = `<div class="toolhead" onclick="toggleTool(this)"><span class="toolt">${escapeHtml(title)}</span><span class="toolc">▸</span></div><div class="toolbody" hidden>${escapeHtml(rest).replace(/\n/g, "<br>")}</div>`;
  }
  else if (t[0] === "reasoning") { cls += "reasoning"; body = renderMarkdown(t[1]); }
  else if (role === "assistant") { cls += "assistant"; body = renderMarkdown(t[1]); }
  else { cls += "system"; body = escapeHtml(t[1] || "").replace(/\n/g, "<br>"); }
  return `<div class="${cls}">${body}</div>`;
}

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
  if (!old) { fullRender(); return; }
  const el = $("chat-items");
  const stick = nearBottom(el);
  if (tw.active && tw.key === k) {
    syncTypewriter();
    if (stick) el.scrollTop = el.scrollHeight;
    return;
  }
  const node = renderOne(it);
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

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
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
    if (it.role !== "assistant") continue;
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
  if (isWorking(knownStatus) && node) {
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
  $("status-dot").className = "dot " + (bridgeOn ? "on" : "off");
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

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const val = $("input").value.trim();
  if (!activeSession) return;
  if (!val && !pendingAttachments.length) return;
  $("input").value = "";
  autoGrow();
  turnHadError = false;
  const atts = pendingAttachments.slice();
  pendingAttachments = [];
  renderChips();
  const params = { sessionId: activeSession, content: val, attachments: atts };
  status("отправка…");
  api("session.startTurn", params).then((r) => {
    status(r.ok ? "отправлено, жду ответ…" : "ошибка: " + (r.error || "?"));
    if (!r.ok) alert("ошибка: " + (r.error || "?"));
  });
};

$("interrupt").onclick = () => {
  if (!activeSession) return;
  api("session.interrupt", { sessionId: activeSession });
  status("стоп запрошен");
};

$("retry-btn").onclick = retryLast;
$("edit-btn").onclick = editLast;

function checkApproval(state) {
  const el = $("approval");
  const waiting = state && ["waiting_approval", "waiting", "blocked", "pending"].indexOf(state.status) >= 0;
  if (!waiting || !activeSession) { el.innerHTML = ""; return; }
  api("session.getNotices", { sessionId: activeSession }).then((r) => {
    const ns = (r.ok && r.result && r.result.notices) || [];
    if (!ns.length) { el.innerHTML = ""; return; }
    el.innerHTML = ns.map((n) => {
      const acts = (n.actions || n.actionCandidates || []).map((a) => {
        const aid = a.actionId || a.id || a.name || "";
        const lbl = a.label || a.title || a.name || aid || "ok";
        return `<button class="btn" data-nid="${escapeHtml(n.noticeId || n.id || "")}" data-aid="${escapeHtml(aid)}">${escapeHtml(lbl)}</button>`;
      }).join(" ");
      const q = n.title || n.question || n.text || "Нужен ответ";
      const sub = n.message ? `<div class="q-sub">${escapeHtml(n.message)}</div>` : "";
      return `<div class="notice">${sub}<div class="q">${escapeHtml(q)}</div>${acts}</div>`;
    }).join("");
    el.querySelectorAll("button[data-aid]").forEach((b) => {
      b.onclick = () => {
        api("session.respondInteraction", {
          sessionId: activeSession,
          noticeId: b.getAttribute("data-nid"),
          actionId: b.getAttribute("data-aid"),
        });
      };
    });
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
      : `<span class="chip-ico">${a.isImage ? "🖼" : "📄"}</span>`;
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
      const data = await readFileBase64(f);
      const isImage = (f.type || "").startsWith("image/");
      const fullUrl = "data:" + (f.type || "application/octet-stream") + ";base64," + data;
      let preview = fullUrl;
      if (isImage) { try { preview = await makeThumb(fullUrl); } catch (_) { preview = fullUrl; } }
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: f.name, mediaType: f.type || "application/octet-stream", data }),
      }).then((x) => x.json());
      if (r.ok) {
        pendingAttachments.push(Object.assign({}, r.attachment, { isImage, preview }));
        renderChips();
        status("добавлено: " + f.name);
      } else {
        status("не загрузилось: " + (r.error || "?"));
      }
    } catch (e) {
      status("ошибка файла: " + e.message);
    }
  }
  $("file-input").value = "";
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

// ---------- events long-poll ----------
function processEvent(ev) {
  if (ev.type === "bridge") { bridgeOn = ev.data.status === "connected"; $("status-dot").className = "dot " + (bridgeOn ? "on" : "off"); }
  else if (ev.type === "sessions") { sessions = ev.data.sessions || []; renderSessions(); }
  else if (ev.type === "state" && ev.data.sessionId === activeSession) { applyState(ev.data.state); }
  else if (ev.type === "items" && ev.data.sessionId === activeSession) {
    mergeInto(ev.data.items, true);
    for (const it of ev.data.items || []) { if (isErrorItem(it)) turnHadError = true; }
  }
  else if (ev.type === "turnEnded") {
    const sid = ev.data && ev.data.sessionId;
    const isActive = sid === activeSession;
    const err = isActive && turnHadError;
    notifyNow(err ? "Работа не закончена" : "Работа закончена", titleOf(sid) || "агент", "turn-" + (sid || "x"));
    if (isActive) turnHadError = false;
  }
}

async function pollLoop() {
  try {
    const r = await fetch(`/api/events?token=${encodeURIComponent(token)}&since=${since}&had=1`).then((x) => x.json());
    since = r.ts;
    (r.events || []).forEach(processEvent);
    lastError = "";
  } catch (e) {
    lastError = "события: " + e.message;
  }
  if (activeSession) status(bridgeOn ? (isWorking(knownStatus) ? "агент работает…" : (knownStatus === "waiting_approval" ? "ждёт ответа…" : (knownStatus && knownStatus !== "idle" ? knownStatus : "чат"))) : "мост отключён" + (lastError ? " · " + lastError : ""));
  pollTimer = setTimeout(pollLoop, 900);
}

function startPolling() { if (!pollTimer) pollLoop(); }

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (!activeSession) { refreshSessions(); return; }
    refreshActiveChat();
  }, 5000);
}

function refreshActiveChat() {
  if (!activeSession) return;
  api("session.getState", { sessionId: activeSession }).then((rs) => {
    if (rs.ok && rs.result) applyState(rs.result);
  }).catch(() => {});
  api("session.getSnapshot", { sessionId: activeSession, limit: 200 }).then((r) => {
    if (r.ok && r.result && r.result.items) mergeInto(r.result.items, true);
  }).catch(() => {});
}

function refreshSessions() {
  api("session.list", { limit: 1000 }).then((r) => {
    if (r.ok) { sessions = r.result.sessions || []; renderSessions(); }
    else { lastError = "список сессий: " + (r.error || "?"); status(lastError); }
  }).catch((e) => { lastError = "список сессий: " + e.message; status(lastError); });
}

// ---------- boot ----------
async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  }
  if (window.caches && window.caches.keys) {
    window.caches.keys().then((ks) => ks.forEach((k) => window.caches.delete(k)));
  }
  const h = await fetch("/api/health").then((r) => r.json()).catch(() => ({ ok: false, bridge: "disconnected" }));
  bridgeOn = h.bridge === "connected";
  $("status-dot").className = "dot " + (bridgeOn ? "on" : "off");
  if (token) {
    const ok = await tryAuth(token);
    if (ok) return;
  }
  show("view-auth");
}

boot();