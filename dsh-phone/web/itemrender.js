"use strict";
// Pure item rendering for the DSH Phone chat: turns bridge items (messages,
// tool calls, MCP calls, agent calls, reasoning, turn markers) into display
// text/HTML. No DOM, no app state - loads in the browser as a plain <script>
// after md.js (uses its globals) and runs under `node test-items.js`
// (harness pre-sets global.escapeHtml/global.renderMarkdown before require).

function cleanText(s) {
  return String(s || "").replace(/[\uFFFD\uFFFE]/g, "");
}

function keyOf(it) {
  return it.id || ("k-" + (it.turnId || "") + "-" + (it.orderSeq ?? "") + "-" + (it.contentHash || ""));
}

function toolResultText(c) {
  if (!c) return "";
  if (typeof c.output === "string") return c.output;
  if (Array.isArray(c.result)) return c.result.map((o) => (o && typeof o.text === "string" ? o.text : "")).join("\n");
  if (c.output && typeof c.output === "object" && typeof c.output.text === "string") return c.output.text;
  if (typeof c.text === "string") return c.text;
  return "";
}

function toolNameOf(it, c) {
  return (c && (c.title || c.toolName || c.name)) || it.toolName || it.name || "tool";
}

function mcpSplit(full) {
  const parts = String(full || "").split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return [parts[1], parts.slice(2).join("__")];
  return ["", String(full || "")];
}

function isToolItem(it) {
  const c = it.content;
  return it.type === "tool" || (c && typeof c === "object" && (c.toolName || c.name || c.kind === "tool_use"));
}

function toolRunning(it) {
  const s = String(it.status || "");
  if (!s) return false;
  if (["done", "failed", "error", "cancelled", "canceled", "interrupted", "success"].indexOf(s) >= 0) return false;
  return true;
}

function turnEndInfo(it) {
  const c = it.content || {};
  const r = c.reason || c.result || c.payload || {};
  const kind = String(r.kind || c.reasonKind || c.status || "completed");
  let msg = "";
  if (r.error && typeof r.error === "object" && typeof r.error.message === "string") msg = r.error.message;
  if (!msg && r.failure && typeof r.failure === "object" && typeof r.failure.message === "string") msg = r.failure.message;
  if (!msg && typeof r.error === "string") msg = r.error;
  if (!msg && typeof r.message === "string") msg = r.message;
  return { kind: kind, msg: cleanText(msg) };
}

function isTurnEnd(it) {
  return it.type === "turn.end" || (it.content && it.content.kind === "turn_end");
}

function isTurnError(it) {
  if (!isTurnEnd(it)) return false;
  const k = turnEndInfo(it).kind;
  return k === "error" || k === "failed" || k === "max-tokens";
}

const TURN_END_LABELS = {
  "error": "ход сломался",
  "failed": "ход сломался",
  "interrupted": "ход прерван",
  "max-tokens": "ход оборван: лимит токенов",
  "user": "ход остановлен",
  "stop": "ход остановлен",
  "cancelled": "ход отменён",
};

function isBookkeeping(it) {
  if (it.type === "marker") return true;
  if (it.type === "turn.start" || (it.content && it.content.kind === "turn_start")) return true;
  return false;
}

function itemText(it) {
  const c = it.content;
  if (isTurnEnd(it)) {
    const info = turnEndInfo(it);
    if (info.kind === "completed" || info.kind === "done") return ["turnend", ""];
    let out = TURN_END_LABELS[info.kind] || ("ход: " + info.kind);
    if (info.msg) out += "\n" + info.msg;
    return ["turnend", out];
  }
  if (isToolItem(it)) {
    const nm = toolNameOf(it, c);
    let st = "";
    if (c && c.isError) st = " · ошибка";
    else if (toolRunning(it)) st = " · " + it.status;
    let out = "[" + nm + st + "]";
    const res = toolResultText(c);
    if (res) out += "\n" + res.slice(0, 4000);
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

function toolCardHtml(it) {
  const c = (it.content && typeof it.content === "object") ? it.content : {};
  const kind = String(c.kind || "command");
  let icon = "$", title = toolNameOf(it, c), sub = "shell", mono = true;
  if (kind === "mcp" || /^mcp__/.test(String(c.name || ""))) {
    const split = mcpSplit(c.name || title);
    icon = "⌁"; title = split[1] || title; sub = split[0] ? "mcp · " + split[0] : "mcp"; mono = false;
  } else if (kind === "agent_call") {
    icon = "◆"; title = c.action || title; sub = "агент"; mono = false;
  } else if (kind === "input_request") {
    icon = "?"; sub = "вопрос";
  }
  const running = toolRunning(it);
  const err = c.isError === true;
  let body = "";
  const desc = (c.input && typeof c.input.description === "string") ? c.input.description
    : (typeof c.description === "string" ? c.description : "");
  if (desc) body += `<div class="tool-sec tool-desc">${escapeHtml(desc)}</div>`;
  let inputTxt = "";
  if (c.input && typeof c.input.command === "string") inputTxt = c.input.command;
  if (!inputTxt && typeof c.command === "string") inputTxt = c.command;
  if (inputTxt) {
    body += `<div class="tool-sec tool-lbl">вход</div><div class="tool-sec tool-code">${escapeHtml(inputTxt.slice(0, 6000))}${inputTxt.length > 6000 ? "\n…" : ""}</div>`;
  } else if (c.input && typeof c.input === "object" && Object.keys(c.input).length) {
    try {
      const j = JSON.stringify(c.input, null, 1);
      body += `<div class="tool-sec tool-lbl">вход</div><div class="tool-sec tool-code">${escapeHtml(j.slice(0, 6000))}${j.length > 6000 ? "\n…" : ""}</div>`;
    } catch (_) {}
  }
  const out = toolResultText(c);
  if (out) {
    body += `<div class="tool-sec tool-lbl">выход</div><div class="tool-sec tool-out${err ? " err" : ""}">${escapeHtml(out.slice(0, 12000))}${out.length > 12000 ? "\n… (обрезано)" : ""}</div>`;
  }
  if (!body) body = `<div class="tool-sec">${running ? "выполняется…" : (err ? "без вывода" : "нет вывода")}</div>`;
  const stChip = err ? `<span class="tstat tstat-err">ошибка</span>` : (running ? `<span class="tstat tstat-run">выполняется</span>` : "");
  const openAttr = (err || running) ? "" : " hidden";
  const caret = (err || running) ? "▾" : "▸";
  return `<div class="toolwrap${err ? " terr" : ""}${running ? " trun" : ""}">` +
    `<div class="toolhead${mono ? " mono" : ""}" onclick="toggleTool(this)"><span class="toolicon">${icon}</span><span class="toolsub">${escapeHtml(sub)}</span><span class="toolt">${escapeHtml(title)}</span>${stChip}<span class="toolc">${caret}</span></div>` +
    `<div class="toolbody"${openAttr}>${body}</div></div>`;
}

function reasoningHtml(txt) {
  const t = txt || "";
  const short = t.length <= 400;
  return `<div class="rhead" onclick="toggleTool(this)"><span class="rt">размышления</span><span class="rlen">${t.length}</span><span class="toolc">${short ? "▾" : "▸"}</span></div>` +
    `<div class="rbody"${short ? "" : " hidden"}>${renderMarkdown(t)}</div>`;
}

function itemHtml(it) {
  const role = it.role || "system";
  const t = itemText(it);
  let cls = "msg ";
  let body;
  if (isTurnEnd(it)) {
    if (!t[1]) return "";
    cls += "turnend";
    const info = turnEndInfo(it);
    const tone = (info.kind === "error" || info.kind === "failed") ? " te-err" : " te-warn";
    body = `<span class="te-dot${tone}"></span><span class="te-txt">${escapeHtml(t[1].split("\n")[0])}</span>` +
      (info.msg ? `<span class="te-msg">${escapeHtml(info.msg.slice(0, 500))}</span>` : "");
    return `<div class="${cls}${tone}">${body}</div>`;
  }
  if (role === "user") { cls += "user"; body = escapeHtml(t[1] || "").replace(/\n/g, "<br>"); }
  else if (isToolItem(it)) { cls += "tool"; body = toolCardHtml(it); }
  else if (t[0] === "reasoning") { cls += "reasoning"; body = reasoningHtml(t[1]); }
  else if (role === "assistant") { cls += "assistant"; body = renderMarkdown(t[1]); }
  else { cls += "system"; body = escapeHtml(t[1] || "").replace(/\n/g, "<br>"); }
  return `<div class="${cls}">${body}</div>`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cleanText, keyOf, toolResultText, toolNameOf, mcpSplit, isToolItem, toolRunning,
    turnEndInfo, isTurnEnd, isTurnError, TURN_END_LABELS, isBookkeeping,
    itemText, toolCardHtml, reasoningHtml, itemHtml,
  };
}
