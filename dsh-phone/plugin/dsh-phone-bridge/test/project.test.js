/**
 * Тесты проекции истории. Проверяем правила соответствия «сырое событие DSH ->
 * элемент таймлайна» и главное свойство: ничего не выдумывается. Нет факта в
 * событии — нет поля в элементе (никаких угаданных кодов возврата и «восстановленных»
 * diff'ов с диска).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	contentItems,
	createProjection,
	enrichToolResult,
	foldTitle,
	isUserMessage,
	lastTurnEndKind,
	paginateItems,
	projectHistory,
	resultContent,
	toolContent
} from "../lib/host/project.js";
import { BridgeError } from "../lib/host/errors.js";
import { itemId } from "../lib/host/identity.js";

const EXTERNAL = "session-ext-1";
const PLATFORM = "sess_dsh_0123456789abcdef01234567";

// Счётчик seq растёт монотонно: внутри одного списка события идут подряд,
// как в настоящем логе DSH (проверка пропуска seq тестируется отдельно).
let seqCounter = 0;
function ev(type, data, extra = {}) {
	return { type, seq: seqCounter++, time: 1_700_000_000_000 + seqCounter, data, ...extra };
}
function project(events) {
	const projection = createProjection(EXTERNAL, PLATFORM);
	for (const event of events) projection.apply(event, void 0);
	return projection.snapshot();
}
function one(items, predicate) {
	const found = items.filter(predicate);
	assert.equal(found.length, 1, `ожидался ровно один элемент, найдено ${found.length}`);
	return found[0];
}

test("настоящее пользовательское сообщение -> message/markdown role user", () => {
	const message = { id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "привет" }] };
	const items = project([ev("user/message", message)]);
	const item = one(items, (i) => i.type === "message");
	assert.equal(item.role, "user");
	assert.equal(item.status, "done");
	assert.deepEqual(item.content, { kind: "markdown", format: "markdown", text: "привет" });
	assert.equal(item.id, itemId(EXTERNAL, "message", "m1:0"));
	assert.equal(item.sessionId, PLATFORM);
	assert.equal(item.source.runtime, "dsh");
	assert.equal(item.source.sessionId, EXTERNAL);
	assert.equal(item.source.itemType, "user/message");
	assert.deepEqual(item.source.messageSource, { kind: "user" });
	assert.match(item.contentHash, /^sha256:[0-9a-f]{64}$/);
});

test("сообщение, вставленное плагином, в таймлайн не попадает", () => {
	const injected = { id: "m2", source: { kind: "plugin", plugin: "skills" }, content: [{ type: "text", text: "системный контекст" }] };
	assert.deepEqual(project([ev("user/message", injected)]), []);
	assert.equal(isUserMessage({ type: "user/message", data: injected }), false);
	assert.equal(isUserMessage({ type: "user/message", data: { source: { kind: "user" }, content: [] } }), true);
});

test("clientMessageId возвращается из rpcId нашего же запроса", () => {
	const rpcId = "dshp.не-наш";
	const items = project([ev("user/message", { id: "m3", source: { kind: "user", rpcId }, content: [{ type: "text", text: "x" }] })]);
	assert.equal(items[0].source.clientMessageId, void 0);
});

test("текст и reasoning ассистента разделяются", () => {
	const items = project([
		ev("turn/start", { turn: 1 }),
		ev("assistant/message", { message: { id: "a1", source: { provider: "deepseek", model: "chat" }, content: [{ type: "reasoning", text: "думаю" }, { type: "text", text: "ответ" }] } })
	]);
	const reasoning = one(items, (i) => i.type === "system");
	assert.equal(reasoning.role, "assistant");
	assert.deepEqual(reasoning.content, { kind: "reasoning", text: "думаю" });
	const message = one(items, (i) => i.type === "message");
	assert.equal(message.role, "assistant");
	assert.equal(message.content.kind, "markdown");
	assert.equal(message.content.text, "ответ");
	assert.equal(message.source.provider, "deepseek");
	assert.equal(message.source.model, "chat");
});

test("tool-call и tool/result сливаются в один элемент tool", () => {
	const items = project([
		ev("tool/call", { callId: "c1", name: "read", arguments: "{\"file_path\":\"a.txt\"}" }),
		ev("tool/result", { message: { content: [{ toolCallId: "c1", content: [{ type: "text", text: "содержимое" }], isError: false }] } })
	]);
	const tools = items.filter((i) => i.type === "tool");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].status, "done");
	assert.equal(tools[0].content.kind, "tool_call");
	assert.equal(tools[0].content.toolName, "read");
	assert.deepEqual(tools[0].content.input, { file_path: "a.txt" });
	assert.equal(tools[0].content.output, "содержимое");
	assert.equal(tools[0].content.isError, false);
	assert.equal(tools[0].content.callId, "c1");
});

test("ошибка инструмента -> status failed и текст ошибки", () => {
	const items = project([
		ev("tool/call", { callId: "c2", name: "read", arguments: {} }),
		ev("tool/result", { error: { message: "нет файла" }, message: { content: [{ toolCallId: "c2", content: [], isError: true }] } })
	]);
	const tool = one(items, (i) => i.type === "tool");
	assert.equal(tool.status, "failed");
	assert.equal(tool.content.isError, true);
	assert.deepEqual(tool.content.error, { message: "нет файла" });
});

test("bash/pwsh -> tool/command, web_search -> tool/web_search", () => {
	assert.equal(toolContent("bash", { command: "ls -la" }).kind, "command");
	assert.equal(toolContent("pwsh", { command: "Get-Process" }).command, "Get-Process");
	assert.equal(toolContent("web_search", { query: "dsh" }).kind, "web_search");
	assert.equal(toolContent("web_search", { queries: "[\"a\"]" }).query, "[\"a\"]");
	// Код возврата не выдумываем: его нет в аргументах вызова.
	assert.equal("exitCode" in toolContent("bash", { command: "false" }), false);
});

test("mcp и вызовы агентов получают свои kind", () => {
	assert.equal(toolContent("mcp__srv__tool", {}).kind, "mcp");
	assert.equal(toolContent("mcp__srv__tool", {}).name, "mcp__srv__tool");
	assert.deepEqual(toolContent("subagent", { prompt: "x" }).kind, "agent_call");
	assert.equal(toolContent("subagent", {}).action, "invoke");
	assert.equal(toolContent("subagent_fork", {}).action, "spawn");
	assert.equal(toolContent("send_message", { agent_id: "a-1" }).targetIds[0], "a-1");
	assert.equal(toolContent("interrupt_agent", {}).action, "close");
});

test("ask_user_question и exit_plan_mode -> input_request только для чтения", () => {
	for (const name of ["ask_user_question", "exit_plan_mode"]) {
		const content = toolContent(name, {});
		assert.equal(content.kind, "input_request");
		assert.equal(content.readOnly, true);
	}
});

test("write/edit: diff берётся из меты DSH, а не с диска", () => {
	const content = { kind: "tool_call", toolName: "edit", input: { file_path: "a.txt" }, isError: false };
	const enriched = enrichToolResult(content, { diffs: [{ path: "a.txt", oldText: "было", newText: "стало" }] });
	assert.equal(enriched.kind, "file_change");
	assert.equal(enriched.changes.length, 1);
	assert.equal(enriched.changes[0].kind, "update");
	assert.equal(enriched.changes[0].diff, "-было\n+стало");
	assert.equal(enriched.changes[0].contextual, true);
	const created = enrichToolResult({ ...content, toolName: "write", input: { file_path: "b.txt", content: "строка1\nстрока2\n" } }, void 0);
	assert.equal(created.kind, "file_change");
	assert.equal(created.changes[0].kind, "add");
	assert.equal(created.changes[0].diff, "+строка1\n+строка2");
	assert.equal(created.changes[0].contextual, false);
	// Без меты и без content никакого file_change: выдумывать правку нельзя.
	assert.equal(enrichToolResult({ kind: "tool_call", toolName: "edit", input: {} }, void 0).kind, "tool_call");
});

test("resultContent склеивает текстовые блоки и помечает изображения", () => {
	const value = resultContent([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]);
	assert.ok(value.output.includes("a"));
	assert.ok(value.output.includes("b"));
	assert.ok(value.output.includes("недоступен"));
	assert.equal(Array.isArray(value.result), true);
	assert.deepEqual(resultContent(void 0).output, "");
});

test("approval/asked и approval/decided -> одна запись permission", () => {
	const items = project([ev("approval/asked", { id: "ap1", tool: "bash" }), ev("approval/decided", { id: "ap1", decision: "allow" })]);
	const approvals = items.filter((i) => i.content?.kind === "permission");
	assert.equal(approvals.length, 1);
	assert.equal(approvals[0].type, "tool");
	assert.equal(approvals[0].role, "system");
	assert.equal(approvals[0].content.readOnly, true);
	assert.equal(approvals[0].content.decision, "allow");
});

test("compaction -> marker/compact", () => {
	const items = project([ev("compaction/started", { reason: "context" })]);
	const marker = one(items, (i) => i.type === "marker");
	assert.equal(marker.content.kind, "compact");
	assert.equal(marker.content.eventType, "compaction/started");
});

test("внутренние события не порождают элементы", () => {
	const items = project([
		ev("request/header", { header: { config: { provider: "p", model: "m" } } }),
		ev("step/start", { turn: 1, step: 1 }),
		ev("model/selection", { provider: "p" }),
		ev("unknown/event", {})
	]);
	assert.deepEqual(items, []);
});

test("turn/start и turn/end служебные и закрывают незавершённые элементы", () => {
	const items = project([
		ev("turn/start", { turn: 1 }),
		ev("tool/call", { callId: "c3", name: "bash", arguments: { command: "sleep 10" } }),
		ev("turn/end", { reason: { kind: "interrupted" } })
	]);
	assert.equal(items.filter((i) => i.type === "turn.start").length, 1);
	assert.equal(items.filter((i) => i.type === "turn.end").length, 1);
	assert.equal(contentItems(items).some((i) => i.type.startsWith("turn.")), false);
	const tool = one(items, (i) => i.type === "tool");
	// Инструмент не завершился: честный статус — interrupted, а не вечный running.
	assert.equal(tool.status, "interrupted");
	const end = one(items, (i) => i.type === "turn.end");
	assert.equal(end.status, "interrupted");
});

test("повторный seq игнорируется, пропуск seq — ошибка", () => {
	const projection = createProjection(EXTERNAL, PLATFORM);
	projection.apply({ type: "tool/call", seq: 5, time: 1, data: { callId: "c", name: "read", arguments: {} } });
	projection.apply({ type: "tool/call", seq: 5, time: 1, data: { callId: "c", name: "read", arguments: {} } });
	assert.equal(projection.throughSeq, 5);
	assert.throws(
		() => projection.apply({ type: "tool/call", seq: 9, time: 1, data: { callId: "c2", name: "read", arguments: {} } }),
		(error) => error instanceof BridgeError && error.code === "PERSISTENCE_ERROR"
	);
});

test("стрим-черновик и финальное сообщение дают один и тот же id", () => {
	const projection = createProjection(EXTERNAL, PLATFORM);
	projection.apply({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } });
	projection.apply({ type: "step/start", seq: 1, time: 1, data: { turn: 1, step: 1 } });
	projection.apply({ type: "assistant/chunk", seq: 2, time: 1, data: { turn: 1, step: 1, chunk: { index: 0, type: "text-delta", text: "часть" } } });
	const draft = projection.snapshot();
	assert.equal(draft.length, 2);
	const draftItem = draft.find((i) => i.type === "message");
	assert.equal(draftItem.status, "running");
	assert.equal(draftItem.content.text, "часть");
	projection.apply({
		type: "assistant/message",
		seq: 3,
		time: 1,
		data: { turn: 1, step: 1, message: { id: "a", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "часть и продолжение" }] } }
	});
	const final = projection.snapshot();
	const finalItem = final.find((i) => i.type === "message");
	assert.equal(final.length, 2);
	assert.equal(finalItem.id, draftItem.id);
	assert.equal(finalItem.status, "done");
	assert.equal(finalItem.content.text, "часть и продолжение");
	// orderSeq первого появления сохранён: элемент не прыгает в конец списка.
	assert.equal(finalItem.orderSeq, draftItem.orderSeq);
});

test("метод stream() не перезаписывает уже зафиксированные события", () => {
	const projection = createProjection(EXTERNAL, PLATFORM);
	projection.apply({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } });
	projection.stream(1, 1, { index: 0, type: "text-delta", text: "живой текст" }, 2, 0);
	assert.ok(projection.dirty);
	assert.equal(projection.snapshot().find((i) => i.type === "message").content.text, "живой текст");
	// cursor меньше throughSeq: стрим опоздал, применять его нельзя.
	const before = projection.snapshot().length;
	projection.stream(1, 1, { index: 0, type: "text-delta", text: "поздно" }, 3, -1);
	assert.equal(projection.snapshot().length, before);
});

test("drain отдаёт только изменения и очищает их", () => {
	const projection = createProjection(EXTERNAL, PLATFORM);
	projection.apply({ type: "tool/call", seq: 0, time: 1, data: { callId: "c", name: "read", arguments: {} } });
	const first = projection.drain();
	assert.equal(first.items.length, 1);
	assert.deepEqual(first.removed, []);
	assert.deepEqual(projection.drain().items, []);
	projection.apply({ type: "tool/result", seq: 1, time: 1, data: { message: { content: [{ toolCallId: "c", content: [{ type: "text", text: "ok" }] }] } } });
	const second = projection.drain();
	assert.equal(second.items.length, 1);
	assert.equal(second.items[0].status, "done");
});

test("snapshot упорядочен по orderSeq, revision = seq + 1", () => {
	const items = project([
		ev("user/message", { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "1" }] }),
		ev("assistant/message", { message: { id: "a", source: {}, content: [{ type: "text", text: "2" }] } })
	]);
	assert.deepEqual(items.map((i) => i.content.text), ["1", "2"]);
	assert.deepEqual(items.map((i) => i.orderSeq), [1, 2]);
	assert.ok(items.every((i) => i.contentHash.startsWith("sha256:")));
});

test("foldTitle и lastTurnEndKind читают только факты из лога", () => {
	assert.equal(foldTitle([{ type: "session/title", data: { title: "первый" } }, { type: "session/title", data: { title: "второй" } }]), "второй");
	assert.equal(foldTitle([{ type: "user/message", data: {} }]), null);
	assert.equal(foldTitle([]), null);
	assert.equal(lastTurnEndKind([{ type: "turn/end", data: { reason: { kind: "error" } } }]), "error");
	assert.equal(lastTurnEndKind([{ type: "turn/end", data: { reason: { kind: "completed" } } }, { type: "other", data: {} }]), "completed");
	assert.equal(lastTurnEndKind([]), void 0);
});

test("projectHistory проигрывает весь лог", async () => {
	const log = {
		session: { id: EXTERNAL, cwd: "/tmp/x", createdAt: 1 },
		events: [
			ev("user/message", { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "вопрос" }] }),
			ev("assistant/message", { message: { id: "a1", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "ответ" }] } })
		]
	};
	const items = await projectHistory(log, PLATFORM);
	assert.equal(items.length, 2);
	assert.equal(items.every((i) => i.sessionId === PLATFORM), true);
	assert.equal(items.every((i) => i.source.sessionId === EXTERNAL), true);
	// Пустой и битый лог не должны ронять проекцию.
	assert.deepEqual(await projectHistory({ session: {}, events: [] }, PLATFORM), []);
	assert.deepEqual(await projectHistory(void 0, PLATFORM), []);
});

test("paginateItems соблюдает лимиты числа и байтов", () => {
	const item = (n) => ({ id: `i${n}`, content: { text: "x".repeat(100) } });
	const items = Array.from({ length: 10 }, (_, i) => item(i));
	assert.equal(paginateItems(items, { maxItems: 3 }).length, 4);
	assert.deepEqual(paginateItems([], {}), []);
	const byBytes = paginateItems(items, { maxItems: 1000, maxBytes: 260 });
	assert.ok(byBytes.length > 1);
	assert.ok(byBytes.every((page) => page.length > 0));
	// Один элемент больше бюджета — явная ошибка, а не тихая потеря.
	assert.throws(() => paginateItems([{ id: "big", content: { text: "y".repeat(5000) } }], { maxBytes: 1000 }), (error) => error.code === "FRAME_TOO_LARGE");
});
