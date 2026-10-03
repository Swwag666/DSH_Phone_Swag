"use strict";
// Unit tests for itemrender.js - run with `node dsh-phone/web/test-items.js`
// from the repo root. Fixtures mirror the real bridge item shapes captured
// from a live DSH Desktop "Agents Anywhere" session.

const md = require("./md.js");
global.escapeHtml = md.escapeHtml;
global.renderMarkdown = md.renderMarkdown;
const ir = require("./itemrender.js");

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + "\n  expected: " + e + "\n  actual:   " + a); }
}
function ok(name, cond) {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name); }
}
function has(name, haystack, needle) {
  ok(name, String(haystack).indexOf(needle) >= 0);
}

// ---- fixtures (live bridge shapes) ----
const userMsg = { id: "i1", type: "message", role: "user", orderSeq: 1, content: "сделай <b>взлом</b> & всё" };
const asstMsg = { id: "i2", type: "message", role: "assistant", orderSeq: 2, content: { kind: "text", text: "делаю **сразу**\n\n- пункт 1\n- пункт 2" } };
const reasoning = { id: "i3", type: "system", role: "system", orderSeq: 3, content: { kind: "reasoning", text: "думаю. надо проверить границы. потом код." } };
const toolCmd = {
  id: "i4", type: "tool", role: "assistant", orderSeq: 4, status: "done",
  content: {
    kind: "command", toolName: "bash",
    input: { command: "dir C:\\need", description: "смотрю папку", timeoutMs: 30000 },
    output: " Volume in drive C", result: [{ type: "text", text: " Volume in drive C" }],
    isError: false, callId: "c1",
  },
};
const toolMcp = {
  id: "i5", type: "tool", role: "assistant", orderSeq: 5, status: "done",
  content: {
    kind: "mcp", name: "mcp__blender__bpy_api_lookup",
    input: { query: "ShaderNodeTexSky", user_prompt: "нужна схема ноды" },
    output: "full type schema: all properties + methods", isError: false, callId: "c2",
  },
};
const toolAgent = {
  id: "i6", type: "tool", role: "assistant", orderSeq: 6, status: "running",
  content: { kind: "agent_call", action: "search", toolName: "subagent" },
};
const toolErr = {
  id: "i7", type: "tool", role: "assistant", orderSeq: 7, status: "done",
  content: { kind: "command", toolName: "pwsh", input: { command: "git push" }, output: "fatal: not a git repository", isError: true, callId: "c3" },
};
const turnOk = { id: "i8", type: "turn.end", role: "system", orderSeq: 8, content: { kind: "turn_end", reason: { kind: "completed" } } };
const turnErr = { id: "i9", type: "turn.end", role: "system", orderSeq: 9, content: { kind: "turn_end", reason: { kind: "error", failure: { message: "LlmFailure: rate limited" } } } };
const turnMax = { id: "i10", type: "turn.end", role: "system", orderSeq: 10, content: { kind: "turn_end", reason: { kind: "max-tokens" } } };
const turnInt = { id: "i11", type: "turn.end", role: "system", orderSeq: 11, content: { kind: "turn_end", reason: { kind: "interrupted" } } };
const turnStart = { id: "i12", type: "turn.start", role: "system", orderSeq: 12, content: { kind: "turn_start" } };

// ---- itemText ----
eq("user message text", ir.itemText(userMsg), ["markdown", "сделай <b>взлом</b> & всё"]);
eq("assistant markdown", ir.itemText(asstMsg)[0], "markdown");
ok("assistant text keeps bold", ir.itemText(asstMsg)[1].indexOf("**сразу**") >= 0);
eq("reasoning kind", ir.itemText(reasoning)[0], "reasoning");
eq("tool text header", ir.itemText(toolCmd)[0], "tool");
ok("tool text has name", ir.itemText(toolCmd)[1].indexOf("[bash") === 0);
ok("tool text has output", ir.itemText(toolCmd)[1].indexOf("Volume in drive") >= 0);
ok("tool error flagged in text", ir.itemText(toolErr)[1].indexOf("ошибка") >= 0);
eq("turn completed silent", ir.itemText(turnOk), ["turnend", ""]);
ok("turn error labelled", ir.itemText(turnErr)[1].indexOf("ход сломался") === 0);
ok("turn error message kept", ir.itemText(turnErr)[1].indexOf("rate limited") >= 0);
ok("turn max-tokens labelled", ir.itemText(turnMax)[1].indexOf("лимит токенов") >= 0);
ok("turn interrupted labelled", ir.itemText(turnInt)[1].indexOf("прерван") >= 0);

// ---- classifiers ----
ok("isToolItem command", ir.isToolItem(toolCmd));
ok("isToolItem mcp", ir.isToolItem(toolMcp));
ok("not tool for message", !ir.isToolItem(asstMsg));
eq("isTurnEnd", ir.isTurnEnd(turnErr), true);
eq("isTurnError completed", ir.isTurnError(turnOk), false);
eq("isTurnError error", ir.isTurnError(turnErr), true);
eq("isTurnError max-tokens", ir.isTurnError(turnMax), true);
eq("isTurnError interrupted is not error", ir.isTurnError(turnInt), false);
eq("isBookkeeping turn.start", ir.isBookkeeping(turnStart), true);
eq("isBookkeeping turn.end kept for render", ir.isBookkeeping(turnErr), false);
eq("isBookkeeping marker", ir.isBookkeeping({ type: "marker" }), true);
eq("toolRunning running", ir.toolRunning(toolAgent), true);
eq("toolRunning done", ir.toolRunning(toolCmd), false);
eq("toolRunning empty status", ir.toolRunning({ status: "" }), false);

// ---- keyOf ----
eq("keyOf id", ir.keyOf(userMsg), "i1");
ok("keyOf fallback", ir.keyOf({ turnId: "t", orderSeq: 5, contentHash: "h" }).length > 0);
eq("keyOf stable", ir.keyOf({ turnId: "t", orderSeq: 5, contentHash: "h" }), ir.keyOf({ turnId: "t", orderSeq: 5, contentHash: "h" }));

// ---- mcpSplit ----
eq("mcpSplit full", ir.mcpSplit("mcp__blender__bpy_api_lookup"), ["blender", "bpy_api_lookup"]);
eq("mcpSplit nested", ir.mcpSplit("mcp__codebase_memory__search_code"), ["codebase_memory", "search_code"]);
eq("mcpSplit non-mcp", ir.mcpSplit("bash"), ["", "bash"]);
eq("mcpSplit empty", ir.mcpSplit(""), ["", ""]);

// ---- turnEndInfo ----
eq("turnEndInfo error message", ir.turnEndInfo(turnErr).msg, "LlmFailure: rate limited");
eq("turnEndInfo completed", ir.turnEndInfo(turnOk).kind, "completed");
eq("turnEndInfo nested error.message", ir.turnEndInfo({ type: "turn.end", content: { reason: { kind: "error", error: { message: "boom" } } } }).msg, "boom");

// ---- itemHtml ----
has("user html escaped", ir.itemHtml(userMsg), "&lt;b&gt;взлом&lt;/b&gt;");
has("user html class", ir.itemHtml(userMsg), "msg user");
has("assistant html markdown", ir.itemHtml(asstMsg), "<strong>сразу</strong>");
has("assistant html class", ir.itemHtml(asstMsg), "msg assistant");

const toolHtml = ir.itemHtml(toolCmd);
has("tool card wrap", toolHtml, "toolwrap");
has("tool card head", toolHtml, "toolhead");
has("tool card name", toolHtml, "bash");
has("tool card input command", toolHtml, "dir C:\\need");
has("tool card input escaped", toolHtml, "dir C:\\\\need".replace(/\\\\/g, "\\"));
has("tool card description", toolHtml, "смотрю папку");
has("tool card output", toolHtml, "Volume in drive C");
has("tool card collapsed when done", toolHtml, " hidden");
has("tool card caret closed", toolHtml, "▸");

const mcpHtml = ir.itemHtml(toolMcp);
has("mcp card tag", mcpHtml, ">mcp<");
has("mcp card full name", mcpHtml, "mcp__blender__bpy_api_lookup");
has("mcp card user_prompt desc", mcpHtml, "нужна схема ноды");
has("mcp card input json", mcpHtml, "ShaderNodeTexSky");
has("mcp card output", mcpHtml, "all properties");

const agentHtml = ir.itemHtml(toolAgent);
has("agent card kind", agentHtml, "агент");
has("agent card action", agentHtml, "search");
has("agent card running chip", agentHtml, "tstat-run");
ok("agent card open while running", /class="toolbody"\s*>/.test(agentHtml));
ok("agent body auto-open", /class="toolbody"\s*>/.test(agentHtml));

const errHtml = ir.itemHtml(toolErr);
has("error card flag", errHtml, "tstat-err");
has("error card red wrap", errHtml, "terr");
has("error card output err", errHtml, "tool-out err");
has("error card auto-open", errHtml, "toolbody");
ok("error body open attribute", /class="toolbody"\s*>/.test(errHtml));
has("error card output", errHtml, "fatal: not a git repository");

const runHtml = ir.itemHtml({ id: "x", type: "tool", status: "running", content: { kind: "command", toolName: "bash", input: { command: "ping 1.1.1.1" } } });
has("running chip", runHtml, "выполняется");
ok("running body open", /class="toolbody"\s*>/.test(runHtml));

eq("turn completed renders empty", ir.itemHtml(turnOk), "");
const teHtml = ir.itemHtml(turnErr);
has("turn error chip class", teHtml, "msg turnend te-err");
has("turn error text", teHtml, "ход сломался");
has("turn error message", teHtml, "rate limited");
has("turn max-tokens warn", ir.itemHtml(turnMax), "te-warn");
has("turn interrupted text", ir.itemHtml(turnInt), "прерван");

const rHtml = ir.itemHtml(reasoning);
has("reasoning head", rHtml, "rhead");
has("reasoning label", rHtml, "размышления");
has("reasoning body", rHtml, "rbody");
has("reasoning markdown inside", rHtml, "<p>");
ok("reasoning short auto-open", /class="rbody"\s*>/.test(rHtml));
const longReasoning = { id: "r2", type: "system", role: "system", orderSeq: 3, content: { kind: "reasoning", text: "x".repeat(500) } };
ok("reasoning long collapsed", /class="rbody"\s+hidden/.test(ir.itemHtml(longReasoning)));

// ---- injection safety ----
const evil = { id: "e1", type: "tool", role: "assistant", content: { kind: "command", toolName: "<img src=x onerror=alert(1)>", input: { command: "<script>alert(2)</script>" }, output: "<b>&amp;</b>" } };
const evilHtml = ir.itemHtml(evil);
ok("tool name escaped", evilHtml.indexOf("<img") < 0);
ok("command escaped", evilHtml.indexOf("<script>") < 0);
has("output escaped", evilHtml, "&lt;b&gt;&amp;amp;&lt;/b&gt;");
const evilTurn = { id: "e2", type: "turn.end", content: { kind: "turn_end", reason: { kind: "error", error: { message: "<script>alert(3)</script>" } } } };
ok("turn error message escaped", ir.itemHtml(evilTurn).indexOf("<script>") < 0);

// ---- big output truncation ----
const big = { id: "b1", type: "tool", role: "assistant", content: { kind: "command", toolName: "bash", output: "z".repeat(50000) } };
const bigHtml = ir.itemHtml(big);
ok("output capped", bigHtml.indexOf("z".repeat(13000)) < 0);
has("truncation note", bigHtml, "обрезано");
ok("itemText caps at 4000", ir.itemText(big)[1].length < 4100);

// ---- tool_call реального формата DSH (kind tool_call, toolName, title) ----
const realTool = {
  id: "r1", type: "tool", role: "assistant", status: "done", orderSeq: 1,
  content: {
    kind: "tool_call", toolName: "read", title: "read", callId: "c9",
    input: { file_path: "C:\\x\\y.txt", offset: 1, limit: 50 },
    output: "содержимое файла", result: [{ type: "text", text: "содержимое файла" }], isError: false,
  },
};
const realHtml = ir.itemHtml(realTool);
has("real tool card full name", realHtml, ">read<");
has("real tool desc from file_path", realHtml, "C:\\x\\y.txt".replace(/\\\\/g, "\\"));
has("real tool output", realHtml, "содержимое файла");

const realMcp = {
  id: "r2", type: "tool", role: "assistant", status: "done", orderSeq: 2,
  content: {
    kind: "tool_call", toolName: "mcp__blender__execute_blender_code", title: "mcp__blender__execute_blender_code", callId: "c10",
    input: { code: "print(1)", user_prompt: "cast_proteje_skin2 - убрать жёлтые пиксели над веками" },
    output: "done", isError: false,
  },
};
const realMcpHtml = ir.itemHtml(realMcp);
ok("real mcp detected by toolName prefix", ir.isMcpTool(realMcp.content, "mcp__blender__execute_blender_code"));
has("real mcp full name in head", realMcpHtml, "mcp__blender__execute_blender_code");
has("real mcp user_prompt as desc", realMcpHtml, "cast_proteje_skin2 - убрать жёлтые пиксели над веками");
ok("mcp not mono shell", realMcpHtml.indexOf("toolhead mono") < 0);

// ---- изображения ----
const imgUser = {
  id: "im1", type: "message", role: "user", orderSeq: 1,
  content: { kind: "markdown", format: "markdown", text: "глянь фотку" },
  attachments: [{ name: "p.jpg", mediaType: "image/jpeg", data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" }],
};
const imHtml = ir.itemHtml(imgUser);
has("image rendered as img tag", imHtml, "<img class=\"msg-img\"");
has("image data url", imHtml, "data:image/jpeg;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=");
has("image item text kept", imHtml, "глянь фотку");

const imgBlockUser = {
  id: "im2", type: "message", role: "user", orderSeq: 2,
  content: { blocks: [
    { type: "text", text: "вторая" },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: "aWFtYmFzZTY0" } },
  ] },
};
const im2Html = ir.itemHtml(imgBlockUser);
has("block image rendered", im2Html, "data:image/png;base64,aWFtYmFzZTY0");
has("block text rendered", im2Html, "вторая");

const imgOnly = {
  id: "im3", type: "message", role: "user", orderSeq: 3,
  content: { kind: "image", mediaType: "image/webp", data: "aGVsbG93b3JsZA==" },
};
ok("image-only item no json junk", ir.itemHtml(imgOnly).indexOf("JSON") < 0 || ir.itemText(imgOnly)[1] !== JSON.stringify(imgOnly.content));
has("image-only renders img", ir.itemHtml(imgOnly), "data:image/webp;base64,aGVsbG93b3JsZA==");

// ---- dshAttachment: реальный формат DSH (attachmentId sha256, без бинарных данных) ----
global.window = { __dshAttBase: "/api/attachment?token=T&sessionId=S&" };
const HEX64 = "fe0ce27f6d70885e68e57dd8a2fc857a75d0474f17eea5542814e6145b73dc5d";
const attUser = {
  id: "at1", type: "message", role: "user", orderSeq: 4,
  content: {
    kind: "text", format: "text", text: "[изображение]",
    dshAttachment: { attachmentId: "sha256:" + HEX64, bytes: 14641, height: 512, mediaType: "image/png", name: "shot.png", width: 512 },
  },
};
const attHtml = ir.itemHtml(attUser);
has("dshAttachment renders via api url", attHtml, "/api/attachment?token=T&amp;sessionId=S&amp;attachmentId=" + HEX64);
has("dshAttachment mediaType passed", attHtml, "mediaType=image%2Fpng");
has("dshAttachment alt name", attHtml, "shot.png");
const attPh = {
  id: "at1b", type: "message", role: "user", orderSeq: 4,
  content: { kind: "text", format: "text", text: "[图片暂不支持跨设备预览]",
    dshAttachment: { attachmentId: "sha256:" + HEX64, bytes: 14641, height: 512, mediaType: "image/png", name: "shot.png", width: 512 } },
};
ok("dshAttachment placeholder text hidden", ir.itemText(attPh)[1] === "");

const attTool = {
  id: "at2", type: "tool", role: "assistant", status: "done", orderSeq: 5,
  content: {
    kind: "tool_call", toolName: "read_image", title: "read_image", callId: "c11",
    input: { file_path: "proteje_skin2_face.png" }, output: "прочитано",
    result: [
      { type: "text", text: "прочитано" },
      { type: "image", attachment: { attachmentId: "sha256:" + HEX64, mediaType: "image/webp", name: "face.webp" } },
    ],
    isError: false,
  },
};
const attToolHtml = ir.itemHtml(attTool);
has("tool result image via api url", attToolHtml, "attachmentId=" + HEX64);
has("tool image label", attToolHtml, "изображения");

const attBad = { id: "at3", type: "message", role: "user", orderSeq: 6, content: { dshAttachment: { attachmentId: "sha256:zzzz", mediaType: "image/png" } } };
ok("bad attachmentId skipped", ir.itemHtml(attBad).indexOf("attachmentId=") < 0);
delete global.window;

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
