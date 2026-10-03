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

function isMcpTool(c, name) {
  if (c && (c.kind === "mcp" || c.mcpServer)) return true;
  const n = String((c && (c.toolName || c.name)) || name || "");
  return n.indexOf("mcp__") === 0 || n.indexOf("mcp.") === 0;
}

// короткая подпись-описание вызова: то, что DSH Desktop показывает рядом с именем тулзы
function toolDescOf(c) {
  const inp = c && typeof c.input === "object" ? c.input : {};
  const d = (inp.user_prompt || inp.userPrompt || inp.description || inp.prompt || "");
  if (typeof d === "string" && d.trim()) return d.trim();
  const one = [inp.command, inp.file_path, inp.path, inp.pattern, inp.query, inp.url, inp.cwd]
    .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())[0];
  return typeof one === "string" ? one : "";
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
    // фото с ПК: DSH кладёт dshAttachment + китайский плейсхолдер в text -
    // картинку отрисует imagesHtml, текст-заглушку прячем
    const isDshAtt = !!(c.dshAttachment && c.dshAttachment.attachmentId);
    if (typeof c.text === "string") {
      const kind = (c.kind === "reasoning" || c.kind === "thinking") ? "reasoning" : "markdown";
      if (isDshAtt && c.text.indexOf("暂不支持") >= 0) return ["markdown", ""];
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
    // картинка без текста: не выплёвываем JSON-мусор, отдаём пустой текст (html даст <img>)
    if (c.kind === "image" || c.type === "image" || isDshAtt || Array.isArray(c.attachments) || Array.isArray(c.media) || Array.isArray(c.images)) {
      return ["markdown", ""];
    }
    return ["markdown", JSON.stringify(c)];
  }
  if (typeof it.text === "string") return ["markdown", it.text];
  return ["markdown", JSON.stringify(it)];
}

function toolCardHtml(it) {
  const c = (it.content && typeof it.content === "object") ? it.content : {};
  const kind = String(c.kind || "command");
  const fullName = toolNameOf(it, c);
  const mcp = isMcpTool(c, it.toolName || it.name);
  // DSH-стиль шапки: "Tool call <полное имя> · <описание>" / "MCP <имя> · <описание>"
  let icon = "$", title = fullName, sub = "tool call", mono = true;
  if (mcp) {
    icon = "⌁"; sub = "mcp"; mono = false;
  } else if (kind === "agent_call") {
    icon = "◆"; title = c.action || fullName; sub = "агент"; mono = false;
  } else if (kind === "input_request") {
    icon = "?"; sub = "вопрос";
  } else if (/^(read|grep|glob|list)\b/i.test(fullName)) {
    icon = "▤"; mono = false;
  } else if (/^(edit|write|apply)\b/i.test(fullName)) {
    icon = "✎"; mono = false;
  } else if (/^(subagent|workflow|ralph)\b/i.test(fullName)) {
    icon = "◆"; mono = false;
  }
  const running = toolRunning(it);
  const err = c.isError === true;
  let body = "";
  const desc = toolDescOf(c);
  if (desc) body += `<div class="tool-sec tool-desc">${escapeHtml(desc.slice(0, 6000))}</div>`;
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
  // картинки, которые вернул инструмент (viewport-скрины, read_image и т.п.)
  const tImgs = imagesHtml(it);
  if (tImgs) body += `<div class="tool-sec tool-lbl">изображения</div>` + tImgs;
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

// ---------- изображения внутри item (фото с ПК / с телефона) ----------
// DSH хранит вложения в content-addressed store; app.js кладёт в
// window.__dshAttBase готовый префикс "/api/attachment?token=...&sessionId=..."
function attUrl(id, mediaType) {
  const base = (typeof window !== "undefined" && window.__dshAttBase) || "";
  if (!base || !id) return null;
  const hex = String(id).replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const mt = String(mediaType || "");
  return base + "attachmentId=" + encodeURIComponent(hex) + (mt ? "&mediaType=" + encodeURIComponent(mt) : "");
}

function b64ToSrc(data, mediaType) {
  const mt = String(mediaType || "image/png");
  if (String(data).startsWith("data:")) return String(data);
  return "data:" + mt + ";base64," + String(data);
}

function pushImg(out, seen, src, name) {
  if (!src || typeof src !== "string") return;
  if (src.length < 32) return;
  if (seen.has(src)) return;
  seen.add(src);
  out.push({ src: src, name: name || "" });
}

function imagesOf(it) {
  const out = [];
  const seen = new Set();
  const c = it.content;
  // 0) реальный формат DSH: content.dshAttachment + content.result[].attachment
  //    {attachmentId: "sha256:<hex>", mediaType, name} -> /api/attachment
  if (c && typeof c === "object" && c.dshAttachment && typeof c.dshAttachment === "object") {
    const a = c.dshAttachment;
    pushImg(out, seen, attUrl(a.attachmentId, a.mediaType), a.name);
  }
  if (c && typeof c === "object" && Array.isArray(c.result)) {
    for (const r of c.result) {
      if (!r || typeof r !== "object") continue;
      const a = r.attachment;
      if (!a || typeof a !== "object" || !a.attachmentId) continue;
      const mt = a.mediaType || a.mimeType || "";
      if (mt && !String(mt).startsWith("image/")) continue;
      pushImg(out, seen, attUrl(a.attachmentId, mt), a.name);
    }
  }
  // 1) поле attachments на самом item
  const attLists = [it.attachments, it.media, (c && typeof c === "object") ? (c.attachments || c.media || c.images) : null];
  for (const list of attLists) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      const mt = a.mediaType || a.mimeType || a.mimetype || a.type;
      if (String(mt) && !String(mt).startsWith("image/")) continue;
      pushImg(out, seen, a.dataUrl || a.url || (a.data ? b64ToSrc(a.data, mt) : null) || (a.base64 ? b64ToSrc(a.base64, mt) : null), a.name || a.fileName);
    }
  }
  // 2) content.kind image
  if (c && typeof c === "object" && (c.kind === "image" || c.type === "image")) {
    const src = c.source || c;
    pushImg(out, seen, (typeof src === "string" ? src : null) ||
      (src && (src.data || src.base64) ? b64ToSrc(src.data || src.base64, src.mediaType || c.mediaType) : null) ||
      (c.dataUrl || c.url || (c.data ? b64ToSrc(c.data, c.mediaType) : null) || (c.base64 ? b64ToSrc(c.base64, c.mediaType) : null)),
      c.name || c.fileName);
  }
  // 3) blocks/parts массив с image-элементами
  const blocks = (c && typeof c === "object") ? (c.blocks || c.parts || c.content) : null;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type !== "image" && b.kind !== "image") continue;
      const s = b.source || b;
      pushImg(out, seen, b.dataUrl || b.url ||
        ((b.data || b.base64 || (s && (s.data || s.base64))) ? b64ToSrc(b.data || b.base64 || (s && (s.data || s.base64)), (s && (s.mediaType || s.mimeType)) || b.mediaType) : null),
        b.name || b.fileName);
    }
  }
  // 4) одиночная строка data:image внутри текстового поля не-markdown item
  if (c && typeof c === "object" && c.kind && c.kind !== "markdown" && typeof c.text === "string" && c.text.startsWith("data:image")) {
    pushImg(out, seen, c.text, "");
  }
  return out;
}

function imagesHtml(it) {
  const imgs = imagesOf(it);
  if (!imgs.length) return "";
  return `<div class="msg-imgs">` + imgs.map((m) =>
    `<img class="msg-img" src="${escapeHtml(m.src)}" alt="${escapeHtml(m.name)}" loading="lazy" onclick="window.open(this.src)" />`
  ).join("") + `</div>`;
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
  if (role === "user") { cls += "user"; body = escapeHtml(t[1] || "").replace(/\n/g, "<br>") + imagesHtml(it); }
  else if (isToolItem(it)) { cls += "tool"; body = toolCardHtml(it); }
  else if (t[0] === "reasoning") { cls += "reasoning"; body = reasoningHtml(t[1]); }
  else if (role === "assistant") { cls += "assistant"; body = renderMarkdown(t[1]) + imagesHtml(it); }
  else { cls += "system"; body = escapeHtml(t[1] || "").replace(/\n/g, "<br>"); }
  return `<div class="${cls}">${body}</div>`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cleanText, keyOf, toolResultText, toolNameOf, mcpSplit, isToolItem, isMcpTool, toolDescOf, toolRunning,
    turnEndInfo, isTurnEnd, isTurnError, TURN_END_LABELS, isBookkeeping,
    itemText, toolCardHtml, reasoningHtml, imagesOf, imagesHtml, itemHtml,
  };
}
