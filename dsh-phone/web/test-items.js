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
has("mcp card server tag", mcpHtml, "mcp · blender");
has("mcp card short name", mcpHtml, "bpy_api_lookup");
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

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
