/**
 * Интеграционная проверка хостовой половины моста: протокол и путь чтения.
 *
 * Вместо DSH подставляется свой ctx (сервисы заменены заглушками), поднимается
 * настоящий TCP-сервер на 127.0.0.1 и прогоняется протокол так, как это делает
 * bridge.rs: handshake и токен, пределы кадров и ресинхронизация, коды ошибок,
 * session.list / getState / getSnapshot с пагинацией, отклонение записи в
 * read-only сборке и синк-фид с обязательными ack. DSH Desktop не нужен.
 *
 * Запуск: node scripts/smoke-host-bridge.mjs
 */
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../lib/host/", import.meta.url).href;
const { NativeRuntime } = await import(`${ROOT}native.js`);
const { RuntimeServer } = await import(`${ROOT}server.js`);
const { endpointPath } = await import(`${ROOT}endpoint.js`);

// ---------- подставной DSH ----------
const listeners = new Map();
const liveSessions = new Map();
const logs = new Map();

function userMessage(seq, text) {
	return { type: "user/message", seq, time: 1_700_000_000_000 + seq, data: { id: `u${seq}`, source: { kind: "user" }, content: [{ type: "text", text }] } };
}
function assistantMessage(seq, text) {
	return { type: "assistant/message", seq, time: 1_700_000_000_000 + seq, data: { message: { id: `a${seq}`, source: { provider: "deepseek", model: "chat" }, content: [{ type: "text", text }] } } };
}

const liveEvents = [userMessage(0, "вопрос с телефона"), assistantMessage(1, "ответ агента")];
liveSessions.set("live-1", {
	id: "live-1",
	seq: 2,
	header: { id: "live-1", cwd: "C:/work", origin: "user", createdAt: new Date(1_700_000_000_000) },
	snapshotEvents: () => liveEvents
});
logs.set("live-1", { session: { id: "live-1", cwd: "C:/work", createdAt: 1_700_000_000_000 }, events: liveEvents, inheritedEventCount: 0 });
logs.set("cold-1", {
	session: { id: "cold-1", cwd: "C:/cold", createdAt: 1_699_000_000_000 },
	events: [
		userMessage(0, "старый вопрос"),
		{ type: "tool/call", seq: 1, time: 2, data: { callId: "c1", name: "bash", arguments: { command: "ls" } } },
		{ type: "tool/result", seq: 2, time: 3, data: { message: { content: [{ toolCallId: "c1", content: [{ type: "text", text: "файлы" }], isError: false }] } } },
		{ type: "turn/end", seq: 3, time: 4, data: { reason: { kind: "error" } } }
	],
	inheritedEventCount: 0
});
logs.set("empty-1", { session: { id: "empty-1", cwd: "C:/x" }, events: [assistantMessage(0, "без пользователя")], inheritedEventCount: 0 });

// Длинная история: проверяем реальную пагинацию снапшота (потолок 1000 на кадр).
const manyEvents = [userMessage(0, "много инструментов")];
for (let i = 0; i < 1100; i++) {
	manyEvents.push({ type: "tool/call", seq: 1 + i * 2, time: i, data: { callId: `call-${i}`, name: "read", arguments: { file_path: `f${i}.txt` } } });
	manyEvents.push({ type: "tool/result", seq: 2 + i * 2, time: i, data: { message: { content: [{ toolCallId: `call-${i}`, content: [{ type: "text", text: `содержимое ${i}` }], isError: false }] } } });
}
logs.set("many-1", { session: { id: "many-1", cwd: "C:/many" }, events: manyEvents, inheritedEventCount: 0 });

const listEntries = [
	{ header: { id: "live-1", cwd: "C:/work", origin: "user", createdAt: new Date(1_700_000_000_000) }, live: true, persisted: true },
	{ header: { id: "cold-1", cwd: "C:/cold", origin: "user", createdAt: new Date(1_699_000_000_000) }, live: false, persisted: true },
	{ header: { id: "many-1", cwd: "C:/many", origin: "user", createdAt: new Date(1_698_000_000_000) }, live: false, persisted: true },
	{ header: { id: "sub-1", cwd: "C:/work", origin: "subagent" }, live: false, persisted: true },
	{ header: { id: "archived-1", cwd: "C:/work", origin: "user" }, live: false, persisted: true },
	{ header: { id: "empty-1", cwd: "C:/x", origin: "user" }, live: false, persisted: true }
];

const services = {};
// Живой агент только для live-1: так проверяем и «attached», и прерывание.
const cancelled = [];
services.agents = {
	get: (id) => (id === "live-1" ? { id, status: "idle", cancel: (reason) => cancelled.push(reason) } : void 0)
};
const ctx = {
	sessions: { get: (id) => liveSessions.get(id), flush: async () => {} },
	sessionQuery: {
		listSessions: async () => listEntries,
		readSession: async (id) => {
			const log = logs.get(id);
			if (!log) {
				const error = new Error("not found");
				error.code = "SESSION_QUERY_SESSION_NOT_FOUND";
				throw error;
			}
			return log;
		},
		readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title: `Заголовок ${id}` } } }))
	},
	workspaceRegistry: {
		archivedSessionIds: ["archived-1"],
		list: () => [{ id: "ws1", title: "Рабочая папка", path: "C:/work", sessionIds: new Set(["live-1"]) }]
	},
	get: (name) => services[name],
	on: (event, cb) => {
		const set = listeners.get(event) ?? new Set();
		set.add(cb);
		listeners.set(event, set);
		return () => set.delete(cb);
	},
	inject: () => ({ dispose() {} }),
	effect: (fn) => fn(),
	logger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
};
function emit(event, ...args) {
	for (const cb of listeners.get(event) ?? []) cb(...args);
}

/**
 * Живое событие сессии live-1 — по правилам DSH: событие сначала попадает в лог
 * сессии (его отдадут и `snapshotEvents()`, и чтение лога), и только потом о нём
 * сообщает Cordis. Эмитировать событие, которого нет в логе, значит подделывать
 * DSH: реальная проверка должна ловить рассинхрон проекции, а не создавать его.
 */
function emitLiveEvent(event) {
	liveEvents.push(event);
	const session = liveSessions.get("live-1");
	session.seq = Number(event.seq) + 1;
	emit("session/event", session, event);
}

// ---------- клиент, повторяющий bridge.rs ----------
function safe(predicate, value) {
	try {
		return Boolean(predicate(value));
	} catch {
		return false;
	}
}

class Client {
	constructor(port) {
		this.port = port;
		this.next = 0;
		this.pending = new Map();
		this.notifications = [];
		this.closed = false;
		this.waiters = [];
		this.buffer = Buffer.alloc(0);
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.socket = net.connect(this.port, "127.0.0.1");
			this.socket.on("connect", resolve);
			this.socket.on("error", reject);
			this.socket.on("close", () => {
				this.closed = true;
				for (const entry of this.pending.values()) entry.reject(new Error("closed"));
				this.pending.clear();
				this.wake();
			});
			this.socket.on("data", (chunk) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				let index;
				while ((index = this.buffer.indexOf(10)) >= 0) {
					const line = this.buffer.subarray(0, index);
					this.buffer = this.buffer.subarray(index + 1);
					if (!line.length) continue;
					const value = JSON.parse(line.toString("utf8"));
					this.notifications.push(value);
					const entry = value.id !== void 0 && value.id !== null ? this.pending.get(String(value.id)) : void 0;
					if (entry) {
						this.pending.delete(String(value.id));
						entry.resolve(value);
					}
					this.wake();
				}
			});
		});
	}

	wake() {
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) waiter();
	}

	send(value) {
		this.socket.write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
	}

	sendRaw(buffer) {
		this.socket.write(buffer);
	}

	raw(value) {
		return new Promise((resolve, reject) => {
			const id = String(++this.next);
			this.pending.set(id, { resolve, reject });
			this.send({ ...value, jsonrpc: "2.0", id });
		});
	}

	request(method, params = {}) {
		return this.raw({ method, params });
	}

	/**
	 * Краткая сводка полученных кадров. Без неё таймаут ожидания ленты выглядит
	 * как «ничего не пришло», хотя на самом деле фид мог прислать не то или
	 * сообщить об ошибке — а diagnosing по одному сообщению невозможен.
	 */
	summary() {
		return this.notifications.slice(-12).map((n) => {
			if (n.method === "runtime.sync.batch") {
				const ops = n.params.operations.map((op) => (op.kind === "notifications"
					? op.notifications.map((x) => `${x.method}${x.params?.status ? `=${x.params.status}` : ""}${x.params?.outcome ? `/${x.params.outcome}` : ""}`).join(",")
					: op.kind));
				return `batch#${n.params.batchSeq}[${ops.join(" | ")}]`;
			}
			if (n.method) return `${n.method}${n.params?.code ? `(${n.params.code})` : ""}`;
			if (n.error) return `error#${n.id}:${n.error.data?.code}`;
			return `result#${n.id}`;
		}).join(" ");
	}

	/** Ждём кадр, подходящий под предикат, не дольше timeoutMs. */
	async waitFor(predicate, timeoutMs = 3000) {
		const found = this.notifications.find((n) => safe(predicate, n));
		if (found) return found;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && !this.closed) {
			await new Promise((resolve) => {
				this.waiters.push(resolve);
				setTimeout(resolve, 25);
			});
			const hit = this.notifications.find((n) => safe(predicate, n));
			if (hit) return hit;
		}
		throw new Error(`уведомление не получено вовремя (закрыто: ${this.closed}); последние кадры: ${this.summary()}`);
	}

	async result(method, params) {
		const frame = await this.request(method, params);
		if (frame.error) throw new Error(`${method}: ${frame.error.data?.code} ${frame.error.message}`);
		return frame.result;
	}

	end() {
		this.socket.destroy();
	}
}

// ---------- прогон ----------
const home = await mkdtemp(join(tmpdir(), "dsh-phone-bridge-"));
const file = endpointPath(home);
const native = new NativeRuntime(ctx);
const server = new RuntimeServer({ endpointPath: file, native, logger: ctx.logger(), version: "0.5.0-test" });
const endpoint = await server.start();

const results = [];
function step(name, fn) {
	return fn().then(() => {
		results.push(`ok   ${name}`);
	}, (error) => {
		results.push(`FAIL ${name}: ${error.message}`);
		process.exitCode = 1;
	});
}

await step("endpoint.json записан и читается узлом", async () => {
	const text = await readFile(file, "utf8");
	assert.deepEqual(JSON.parse(text), { version: 1, host: "127.0.0.1", port: endpoint.port, token: endpoint.token, pid: process.pid });
	assert.equal(text, `{"version":1,"host":"127.0.0.1","port":${endpoint.port},"token":"${endpoint.token}","pid":${process.pid}}`);
});

await step("первый метод не initialize -> NOT_INITIALIZED и разрыв", async () => {
	const client = new Client(endpoint.port);
	await client.connect();
	const frame = await client.request("ping");
	assert.equal(frame.error.code, -32012);
	assert.equal(frame.error.data.code, "NOT_INITIALIZED");
	await new Promise((resolve) => client.socket.on("close", resolve));
	assert.equal(client.closed, true);
});

await step("неверный токен -> NOT_INITIALIZED", async () => {
	const client = new Client(endpoint.port);
	await client.connect();
	const frame = await client.raw({ method: "initialize", params: { authToken: "неверный-токен-той-же-длины-000000000000", protocolVersion: "1.0", runtime: "dsh", connectorId: "dsh-phone" } });
	assert.equal(frame.error.data.code, "NOT_INITIALIZED");
	client.end();
});

await step("версия протокола 2.0 -> PROTOCOL_VERSION_MISMATCH", async () => {
	const client = new Client(endpoint.port);
	await client.connect();
	const frame = await client.raw({ method: "initialize", params: { authToken: endpoint.token, protocolVersion: "2.0", runtime: "dsh", connectorId: "dsh-phone" } });
	assert.equal(frame.error.data.code, "PROTOCOL_VERSION_MISMATCH");
	client.end();
});

const client = new Client(endpoint.port);
await client.connect();

await step("initialize возвращает контрактный результат", async () => {
	const result = await client.result("initialize", { authToken: endpoint.token, protocolVersion: "1.0", runtime: "dsh", connectorId: "dsh-phone", clientInfo: { name: "smoke", version: "0" } });
	assert.deepEqual(result, {
		identity: { runtime: "dsh", runtimeVersion: "0.5.0-test", bridgeVersion: "0.5.0-test", protocolVersion: "1.0", displayName: "DSH Phone Bridge" },
		storage: { mode: "dsh-native", sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
		features: {
			attachments: false,
			sessionDiscovery: true,
			timelineSuffixRead: false,
			approval: false,
			userQuestions: false,
			readOnly: true,
			snapshotPagination: true,
			syncMode: "events",
			projectionVersion: 2
		}
	});
});

await step("ping, getConfig, getCapabilities, workspace.list", async () => {
	assert.deepEqual(await client.result("ping"), { ok: true });
	assert.deepEqual(await client.result("runtime.getConfig"), { runtime: "dsh", revision: 2, values: {}, metadata: { readOnly: true, storageMode: "dsh-native" } });
	const capabilities = await client.result("runtime.getCapabilities");
	assert.equal(capabilities.runtime, "dsh");
	assert.equal(capabilities.revision, 5);
	assert.equal(capabilities.capabilities.length, 10);
	const byId = new Map(capabilities.capabilities.map((item) => [item.capabilityId, item]));
	assert.equal(byId.get("runtime.config").supported, true);
	// Без sessionController писать нельзя: send_message/interrupt выключены.
	assert.equal(byId.get("session.send_message").supported, false);
	assert.equal(byId.get("session.interrupt").supported, false);
	assert.equal(byId.get("session.steer").supported, false);
	assert.equal(byId.get("session.commands").supported, false);
	assert.equal(byId.get("runtime.attachment").supported, false);
	assert.deepEqual(capabilities.metadata, { readOnly: true, attachments: false, userQuestions: false, approval: false });
	assert.equal(capabilities.sessionId, void 0);
	const workspaces = await client.result("workspace.list");
	assert.deepEqual(workspaces.workspaces, [{ id: "ws1", title: "Рабочая папка", path: "C:/work", sessionIds: ["live-1"] }]);
	// session.getCapabilities с несуществующей сессией — честная ошибка.
	const unknown = await client.request("session.getCapabilities", { sessionId: "sess_unknown" });
	assert.equal(unknown.error.data.code, "SESSION_NOT_FOUND");
});

let livePlatformId;
await step("session.list: субагенты и архив исключены, заголовки прочитаны", async () => {
	const page = await client.result("session.list", { limit: 1000 });
	const ids = page.sessions.map((s) => s.externalSessionId).sort();
	assert.equal(ids.includes("sub-1"), false, "субагент не должен быть в списке");
	assert.equal(ids.includes("archived-1"), false, "архив не должен быть в списке");
	assert.equal(ids.includes("live-1"), true);
	assert.equal(ids.includes("cold-1"), true);
	assert.equal(ids.includes("many-1"), true);
	// Сессия без пользовательских сообщений не видна ни в списке, ни в ленте:
	// это правило сайдбара DSH, и оно обязано совпадать в обоих местах.
	assert.equal(ids.includes("empty-1"), false);
	livePlatformId = page.sessions.find((s) => s.externalSessionId === "live-1").sessionId;
	assert.match(livePlatformId, /^sess_dsh_[0-9a-f]{24}$/);
	const live = page.sessions.find((s) => s.externalSessionId === "live-1");
	assert.equal(live.title, "Заголовок live-1");
	assert.equal(live.runtime, "dsh");
	assert.equal(live.cwd, "C:/work");
	assert.equal(typeof live.orderingTime, "string");
	assert.deepEqual(live.metadata.sync, { requires_timeline_sync: true, changed: true });
	assert.equal(live.metadata.live, true);
	assert.equal(live.metadata.readOnly, true);
	assert.equal(page.nextCursor, null);
});

await step("session.list принимает внешний id и пагинирует курсором", async () => {
	const first = await client.result("session.list", { limit: 1 });
	assert.equal(first.sessions.length, 1);
	if (first.nextCursor) {
		const second = await client.result("session.list", { limit: 1, cursor: first.nextCursor });
		assert.notEqual(second.sessions[0].externalSessionId, first.sessions[0].externalSessionId);
	}
	// Битый курсор — ошибка параметров, а не падение соединения.
	const frame = await client.request("session.list", { limit: 1, cursor: "мусор" });
	assert.equal(frame.error.data.code, "INVALID_PARAMS");
});

await step("session.getState: живая и холодная сессии, архив -> blocked", async () => {
	const live = await client.result("session.getState", { sessionId: livePlatformId });
	assert.equal(live.runtime, "dsh");
	assert.equal(live.externalSessionId, "live-1");
	assert.equal(live.status, "idle");
	assert.deepEqual(live.sourceState.availability, "available");
	assert.equal(live.metadata.attached, true);
	assert.equal(live.metadata.cwd, "C:/work");

	const cold = await client.result("session.getState", { externalSessionId: "cold-1" });
	assert.equal(cold.status, "error", "последний turn/end был error");
	assert.equal(cold.metadata.attached, false);

	const archived = await client.result("session.getState", { externalSessionId: "archived-1" });
	assert.equal(archived.status, "blocked");
	assert.equal(archived.sourceState.availability, "archived");

	// Неизвестная сессия: как и AA, getState не падает, а честно сообщает missing.
	const missing = await client.result("session.getState", { externalSessionId: "нет-такой" });
	assert.equal(missing.status, "blocked");
	assert.equal(missing.sourceState.availability, "missing");
	// А методы, которым сессия нужна для работы, отдают SESSION_NOT_FOUND.
	const notFound = await client.request("session.getSnapshot", { externalSessionId: "нет-такой" });
	assert.equal(notFound.error.data.code, "SESSION_NOT_FOUND");

	// Оба id одновременно и вразнобой — ошибка параметров.
	const clash = await client.request("session.getState", { sessionId: livePlatformId, externalSessionId: "cold-1" });
	assert.equal(clash.error.data.code, "INVALID_PARAMS");

	// session.getCapabilities добавляет scope и sessionId.
	const scoped = await client.result("session.getCapabilities", { externalSessionId: "live-1" });
	assert.equal(scoped.sessionId, livePlatformId);
	assert.equal(scoped.capabilities.every((item) => item.scope === "session"), true);
});

await step("session.getSnapshot: проекция v2, пагинация, watermark", async () => {
	const snapshot = await client.result("session.getSnapshot", { externalSessionId: "cold-1" });
	assert.equal(snapshot.runtime, "dsh");
	assert.equal(snapshot.metadata.projectionVersion, 2);
	assert.equal(snapshot.metadata.totalItems, 2);
	assert.equal(snapshot.complete, true);
	assert.equal(snapshot.snapshotComplete, true);
	assert.equal(snapshot.nextCursor, null);
	assert.equal(snapshot.watermark.seq, 3);
	assert.equal(snapshot.watermark.revision, "projection-2:3");
	const types = snapshot.items.map((i) => `${i.type}/${i.content.kind}`);
	assert.deepEqual(types, ["message/markdown", "tool/command"]);
	const tool = snapshot.items[1];
	assert.equal(tool.status, "done");
	assert.equal(tool.content.command, "ls");
	assert.equal(tool.content.output, "файлы");
	for (const item of snapshot.items) {
		assert.match(item.id, /^dsh_[0-9a-f]{64}$/);
		assert.match(item.contentHash, /^sha256:[0-9a-f]{64}$/);
		assert.equal(item.source.runtime, "dsh");
		assert.equal(item.source.sessionId, "cold-1");
	}
	// limit означает «последние N»: снапшот урезан, complete=false.
	const tail = await client.result("session.getSnapshot", { externalSessionId: "cold-1", limit: 1 });
	assert.equal(tail.items.length, 1);
	assert.equal(tail.items[0].content.kind, "command");
	assert.equal(tail.complete, false);
	assert.equal(tail.snapshotComplete, false);
	assert.equal(tail.nextCursor, null);
	assert.equal(tail.metadata.totalItems, 1);

	// Длинная история pagинируется курсором: не больше 1000 элементов на кадр.
	const page1 = await client.result("session.getSnapshot", { externalSessionId: "many-1" });
	assert.equal(page1.items.length, 1000);
	assert.equal(page1.metadata.totalItems, 1101);
	assert.ok(page1.nextCursor);
	const page2 = await client.result("session.getSnapshot", { externalSessionId: "many-1", cursor: page1.nextCursor });
	assert.equal(page2.items.length, 101);
	assert.equal(page2.nextCursor, null);
	assert.equal(page2.complete, false);
	// Курсор чужой сессии не принимается.
	const foreign = await client.request("session.getSnapshot", { externalSessionId: "cold-1", cursor: page1.nextCursor });
	assert.equal(foreign.error.data.code, "INVALID_PARAMS");
});

await step("session.startTurn без sessionController -> ok:false, соединение живое", async () => {
	const result = await client.result("session.startTurn", { sessionId: livePlatformId, content: "привет", clientMessageId: "c-1" });
	assert.equal(result.ok, false);
	assert.equal(result.code, "UNSUPPORTED_OPERATION");
	assert.equal(result.result.messageAccepted, false);
	assert.equal(result.result.externalSessionId, "live-1");
	// Пустой текст — ошибка параметров.
	const empty = await client.request("session.startTurn", { sessionId: livePlatformId, content: "  ", clientMessageId: "c-2" });
	assert.equal(empty.error.data.code, "INVALID_PARAMS");
	const noId = await client.request("session.startTurn", { sessionId: livePlatformId, content: "текст" });
	assert.equal(noId.error.data.code, "INVALID_PARAMS");
	const attachment = await client.result("session.startTurn", { sessionId: livePlatformId, content: "с картинкой", clientMessageId: "c-3", attachments: [{ id: "a" }] });
	assert.equal(attachment.code, "UNSUPPORTED_OPERATION");
	assert.deepEqual(await client.result("ping"), { ok: true });
});

await step("session.interrupt / updateSelections / notices честно недоступны", async () => {
	const interrupt = await client.request("session.interrupt", { sessionId: livePlatformId });
	// Агент жив: cancel({kind:"user"}) обязан пройти через сервис agents.
	assert.equal(interrupt.error, void 0);
	assert.equal(interrupt.result.accepted, true);
	assert.deepEqual(cancelled.at(-1), { kind: "user" });

	const selections = await client.request("session.updateSelections", { sessionId: livePlatformId, selections: { model: "dsh:model:not-valid" } });
	assert.equal(selections.error.data.code, "INVALID_PARAMS");

	const notices = await client.result("session.getNotices", { sessionId: livePlatformId });
	assert.deepEqual(notices.notices, []);
	const respond = await client.request("session.respondInteraction", { sessionId: livePlatformId, noticeId: "n", actionId: "submit" });
	assert.equal(respond.error.data.code, "UNSUPPORTED_OPERATION");

	const models = await client.request("catalog.listModels");
	assert.equal(models.error.data.code, "UNSUPPORTED_OPERATION");
	const permissions = await client.request("catalog.listPermissions");
	assert.equal(permissions.error.data.code, "UNSUPPORTED_OPERATION");
	const presets = await client.request("catalog.listAgentPresets");
	assert.equal(presets.error.data.code, "UNSUPPORTED_OPERATION");
});

await step("неизвестный метод -> METHOD_NOT_FOUND", async () => {
	const frame = await client.request("session.чегоНет");
	assert.equal(frame.error.code, -32601);
	assert.equal(frame.error.data.code, "METHOD_NOT_FOUND");
	assert.equal(frame.error.data.retryable, false);
});

await step("битый JSON и битый конверт не рвут соединение", async () => {
	client.sendRaw(Buffer.from("{это не json}\n"));
	const parseError = await client.waitFor((n) => n.error?.data?.code === "PARSE_ERROR");
	assert.equal(parseError.id, null);
	client.sendRaw(Buffer.from(`${JSON.stringify({ jsonrpc: "1.0", id: "x", method: "ping" })}\n`));
	const invalid = await client.waitFor((n) => n.error?.data?.code === "INVALID_REQUEST");
	// По JSON-RPC 2.0 при ошибке в самом конверте id обязан быть null.
	assert.equal(invalid.id, null);
	assert.deepEqual(await client.result("ping"), { ok: true });
});

await step("гигантский кадр -> FRAME_TOO_LARGE, поток ресинхронизирован", async () => {
	const huge = Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 97), Buffer.from("\n")]);
	client.sendRaw(huge);
	const frame = await client.waitFor((n) => n.error?.data?.code === "FRAME_TOO_LARGE");
	assert.equal(frame.error.code, -32013);
	assert.deepEqual(await client.result("ping"), { ok: true }, "соединение переживило гигантский кадр");
});

await step("runtime.sync.*: подписка, батчи с ack, живое событие, отписка", async () => {
	const subscribe = await client.result("runtime.sync.subscribe", {});
	assert.equal(subscribe.projectionVersion, 2);
	assert.match(subscribe.streamId, /^[0-9a-f-]{36}$/);

	// Подтверждаем каждый батч, как это делает узел dsh-phone.
	let acked = 0;
	const autoAck = setInterval(() => {
		for (const note of client.notifications) {
			if (note.method !== "runtime.sync.batch") continue;
			if (note.params.batchSeq <= acked) continue;
			acked = note.params.batchSeq;
			// Узел dsh-phone шлёт ack именно запросом (с id и ожиданием ответа),
			// поэтому и здесь id обязателен.
			client.send({ jsonrpc: "2.0", id: `ack-${note.params.batchSeq}`, method: "runtime.sync.ack", params: { streamId: note.params.streamId, batchSeq: note.params.batchSeq } });
		}
	}, 10);
	try {
	const begin = await client.waitFor((n) => n.method === "runtime.sync.batch"
		&& n.params.operations.some((op) => op.kind === "notifications" && op.notifications.some((x) => x.method === "session.inventory.begin")));
	assert.equal(begin.params.projectionVersion, 2);
	const complete = await client.waitFor((n) => n.method === "runtime.sync.batch"
		&& n.params.operations.some((op) => op.kind === "notifications" && op.notifications.some((x) => x.method === "session.inventory.complete")), 5000);
	const inventory = complete.params.operations.flatMap((op) => op.notifications ?? []).find((x) => x.method === "session.inventory.complete");
	assert.equal(inventory.params.complete, true);
	const listed = inventory.params.sessions.map((s) => s.externalSessionId).sort();
	assert.equal(listed.includes("sub-1"), false);
	assert.equal(listed.includes("archived-1"), false);
	assert.equal(listed.includes("live-1"), true);
	assert.equal(listed.includes("empty-1"), false);
	assert.equal(listed.includes("many-1"), true);
	assert.equal(inventory.params.sessions.find((s) => s.externalSessionId === "live-1").sourceState.availability, "available");
	assert.ok(acked >= 1, "батчи должны подтверждаться");

	// Битый ack — ошибка параметров, фид жив.
	const badAck = await client.request("runtime.sync.ack", { streamId: subscribe.streamId, batchSeq: 9999 });
	assert.equal(badAck.error.data.code, "INVALID_PARAMS");
	const wrongStream = await client.request("runtime.sync.ack", { streamId: "не-наш", batchSeq: 1 });
	assert.equal(wrongStream.error.data.code, "INVALID_PARAMS");

	// Первое живое событие: снапшот ленивый, поэтому только сейчас клиент
	// получает полную историю сессии (begin -> items -> commit).
	const snapshotsBefore = client.notifications.flatMap((n) => n.params?.operations ?? []).filter((op) => op.kind === "snapshot.begin").length;
	emitLiveEvent(assistantMessage(2, "новый ответ"));
	const baselineBatch = await client.waitFor((n) => n.method === "runtime.sync.batch" && n.params.operations.some((op) => op.kind === "snapshot.commit"), 8000);
	assert.equal(baselineBatch.params.streamId, subscribe.streamId);
	const committed = baselineBatch.params.operations.find((op) => op.kind === "snapshot.commit");
	assert.equal(committed.sessionId, livePlatformId);
	assert.equal(committed.throughSeq, 2);
	assert.ok(baselineBatch.params.operations.some((op) => op.kind === "snapshot.items" && op.items.length > 0), "снапшот обязан содержать элементы");
	assert.equal(client.notifications.flatMap((n) => n.params?.operations ?? []).filter((op) => op.kind === "snapshot.begin").length, snapshotsBefore + 1);

	// Конец хода: только дельта (turnEnded + состояние), без повторного полного
	// снапшота. Это регрессия на потерю события после ленивого снапшота: если
	// проекция отстала на seq, следующий ход выглядит пропуском и уводит сессию
	// в бесконечные пересборки, а потом в unavailable.
	emitLiveEvent({ type: "turn/end", seq: 3, time: 5, data: { reason: { kind: "completed" } } });
	const turnEnded = await client.waitFor((n) => n.method === "runtime.sync.batch" && n.params.operations.some((op) => op.kind === "notifications"
		&& op.notifications.some((x) => x.method === "session.turnEnded" && x.params.outcome === "completed")), 8000);
	assert.equal(turnEnded.params.operations.flatMap((op) => op.notifications ?? []).find((x) => x.method === "session.turnEnded").params.externalSessionId, "live-1");
	assert.equal(client.notifications.flatMap((n) => n.params?.operations ?? []).filter((op) => op.kind === "snapshot.begin").length, snapshotsBefore + 1,
		"turn/end не должен пересобирать снапшот");

	// Незакрытый approval/asked обязан давать статус waiting_approval: иначе
	// телефон считал бы сессию простаивающей и слал в неё новые сообщения.
	emitLiveEvent({ type: "approval/asked", seq: 4, time: 6, data: { id: "ap-1", tool: "bash" } });
	const waiting = await client.waitFor((n) => n.method === "runtime.sync.batch" && n.params.operations.some((op) => op.kind === "notifications"
		&& op.notifications.some((x) => x.method === "session.state.updated" && x.params.status === "waiting_approval")), 8000);
	assert.equal(waiting.params.operations.flatMap((op) => op.notifications ?? []).find((x) => x.method === "session.state.updated").params.externalSessionId, "live-1");
	// Элемент запроса подтверждения приходит дельтой, а не новым снапшотом.
	await client.waitFor((n) => n.method === "runtime.sync.batch" && n.params.operations.some((op) => op.kind === "notifications"
		&& op.notifications.some((x) => x.method === "timeline.itemUpsert" && x.params.item?.content?.kind === "permission")), 8000);
	assert.equal(client.notifications.flatMap((n) => n.params?.operations ?? []).filter((op) => op.kind === "snapshot.begin").length, snapshotsBefore + 1,
		"approval/asked не должен пересобирать снапшот");
	// session.getState намеренно НЕ сканирует approval/asked: как и у AA, статус
	// апрува приходит лентой (узел по нему шлёт пуш «Нужен твой ответ»), а RPC
	// отдаёт живой статус агента. Расхождение с фидом здесь ожидаемое.
	const rpcState = await client.result("session.getState", { externalSessionId: "live-1" });
	assert.equal(rpcState.status, "idle");

	// Сессия не должна была «сломаться» ни на одном из шагов.
	const finalState = await client.result("session.getState", { externalSessionId: "live-1" });
	assert.equal(finalState.sourceState.availability, "available");

	assert.deepEqual(await client.result("runtime.sync.unsubscribe"), { ok: true });
	await new Promise((resolve) => setTimeout(resolve, 150));
	} finally {
		// Интервал обязан сниматься и при провале: иначе процесс не завершится.
		clearInterval(autoAck);
	}
});

await step("dispose снимает публикацию endpoint.json", async () => {
	client.end();
	await server.close();
	await native.close();
	await assert.rejects(() => readFile(file, "utf8"));
	await rm(home, { recursive: true, force: true });
});

console.log(results.join("\n"));
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
// Завершаемся явно: нас не интересует, держит ли подставной ctx какие-то ручки.
process.exit(process.exitCode ?? 0);
