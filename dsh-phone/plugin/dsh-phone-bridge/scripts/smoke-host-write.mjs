/**
 * Интеграционная проверка хостовой половины моста: путь записи и каталоги.
 *
 * В подставном ctx доступны sessionController, llm, permissionPresets, commands,
 * agentPresets, agents и sessionProjections — то есть всё, чем DSH разрешает
 * писать. Проверяются порядок вызовов сервисов при createAndStart, startTurn,
 * идемпотентность clientMessageId, updateSelections, interrupt, содержимое
 * каталогов и главное: сбой записи возвращается как ok:false с публичным кодом,
 * а не рвёт соединение и не оставляет сессию в полусозданном виде.
 *
 * Запуск: node scripts/smoke-host-write.mjs
 */
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../lib/host/", import.meta.url).href;
const { NativeRuntime } = await import(`${ROOT}native.js`);
const { RuntimeServer } = await import(`${ROOT}server.js`);
const { endpointPath } = await import(`${ROOT}endpoint.js`);

const calls = [];
const live = new Map();
const logs = new Map();
const listeners = new Map();

// Рабочая папка для createAndStart должна существовать: берём TEMP.
const workdir = await mkdtemp(join(tmpdir(), "dsh-phone-cwd-"));

// Состояние конфигурации живёт «в DSH»: official projections читают его оттуда,
// а не из наших полей. Так проверка повторяет реальное поведение.
const configurationState = new Map();
function configOf(id) {
	if (!configurationState.has(id)) configurationState.set(id, {});
	return configurationState.get(id);
}

const services = {
	sessionProjections: {
		snapshot: (session) => {
			const state = configurationState.get(session.id) ?? {};
			return {
				asOfSeq: session.seq,
				values: {
					...(state.model ? { modelSelection: { next: state.model } } : {}),
					...(state.permission ? { permissions: { currentValue: state.permission } } : {}),
					...(state.agentPreset ? { agentPreset: state.agentPreset } : {})
				}
			};
		},
		restore: () => {
			throw new Error("restore не поддерживается заглушкой");
		}
	},
	sessionController: {
		async create(options) {
			calls.push(["create", options]);
			if (options.agentPreset === "broken") throw Object.assign(new Error("preset"), { isDSHRemoteError: true, code: "agent-preset/broken" });
			const events = [];
			configOf(options.sessionId).agentPreset = options.agentPreset;
			live.set(options.sessionId, {
				id: options.sessionId,
				seq: events.length,
				header: { id: options.sessionId, cwd: options.cwd, origin: "user" },
				snapshotEvents: () => events
			});
			logs.set(options.sessionId, { session: { id: options.sessionId, cwd: options.cwd }, events, inheritedEventCount: 0 });
		},
		async resolveAgent(id) {
			calls.push(["resolveAgent", id]);
			const session = live.get(id);
			if (!session) return { error: new Error("no agent") };
			return { agent: { id, session } };
		},
		async prompt(request, signal) {
			calls.push(["prompt", { ...request, content: request.content }]);
			if (request.content[0].text === "упади") throw Object.assign(new Error("remote"), { isDSHRemoteError: true, code: "session/model-unavailable" });
			const session = live.get(request.sessionId);
			session.snapshotEvents().push({
				type: "user/message",
				seq: session.seq++,
				time: Date.now(),
				data: { id: request.requestId, source: { kind: "user", rpcId: request.requestId }, content: request.content }
			});
			return { ok: true };
		},
		async selectModel(request) {
			calls.push(["selectModel", request]);
			configOf(request.sessionId).model = {
				provider: request.provider,
				model: request.model,
				...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {})
			};
		}
	},
	llm: {
		async listProviders() {
			return [{ id: "deepseek", name: "DeepSeek" }];
		},
		async listModels(provider) {
			calls.push(["listModels", provider]);
			return [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner", description: "рассуждения" }];
		},
		async resolveModelInfo(provider, model) {
			return { reasoning: model === "deepseek-reasoner" ? { efforts: [{ id: "high", name: "High" }] } : void 0 };
		},
		async resolveCallConfig(selection) {
			calls.push(["resolveCallConfig", selection]);
			if (selection.model === "нет-такой") throw new Error("unknown model");
			return selection;
		}
	},
	permissionPresets: {
		names: ["plan", "acceptEdits"],
		optionOf: (preset) => ({ name: preset === "plan" ? "План" : "Правки", description: `пресет ${preset}` }),
		set: (session, preset) => {
			calls.push(["permissionPresets.set", session.id, preset]);
			configOf(session.id).permission = preset;
		},
		current: (session) => configOf(session.id)?.permission
	},
	commands: {
		find: (agent, name) => (name === "permission" ? { name } : void 0),
		execute: async (agent, text) => {
			calls.push(["commands.execute", agent.id, text]);
			configOf(agent.id).permission = text.replace("/permission ", "");
			return { result: { kind: "success" } };
		}
	},
	agentPresets: {
		async list() {
			return [{ id: "standard", name: "Обычный" }, { id: "broken", name: "Сломанный", broken: true }];
		}
	},
	agents: { get: (id) => (live.has(id) ? { id, status: "running", cancel: () => calls.push(["cancel", id]) } : void 0) }
};

const ctx = {
	sessions: {
		get: (id) => live.get(id),
		flush: async (session) => calls.push(["flush", session?.id])
	},
	sessionQuery: {
		listSessions: async () => [...live.values()].map((session) => ({ header: session.header, live: true, persisted: true })),
		readSession: async (id) => logs.get(id)
	},
	workspaceRegistry: {
		archivedSessionIds: [],
		list: () => [],
		create: async (path) => {
			calls.push(["workspace.create", path]);
			return { attachSession: async (id) => calls.push(["attachSession", id]) };
		}
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

class Client {
	constructor(port) {
		this.port = port;
		this.next = 0;
		this.pending = new Map();
		this.buffer = Buffer.alloc(0);
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.socket = net.connect(this.port, "127.0.0.1");
			this.socket.on("connect", resolve);
			this.socket.on("error", reject);
			this.socket.on("data", (chunk) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				let i;
				while ((i = this.buffer.indexOf(10)) >= 0) {
					const line = this.buffer.subarray(0, i).toString("utf8");
					this.buffer = this.buffer.subarray(i + 1);
					if (!line) continue;
					const value = JSON.parse(line);
					const entry = value.id != null ? this.pending.get(String(value.id)) : void 0;
					if (entry) {
						this.pending.delete(String(value.id));
						entry(value);
					}
				}
			});
		});
	}

	request(method, params = {}) {
		return new Promise((resolve, reject) => {
			const id = String(++this.next);
			this.pending.set(id, resolve);
			this.socket.write(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8"));
			setTimeout(() => reject(new Error(`timeout ${method}`)), 15_000);
		});
	}

	async result(method, params) {
		const frame = await this.request(method, params);
		if (frame.error) throw new Error(`${method}: ${frame.error.data.code} ${frame.error.message}`);
		return frame.result;
	}

	end() {
		this.socket.destroy();
	}
}

const home = await mkdtemp(join(tmpdir(), "dsh-phone-write-"));
const native = new NativeRuntime(ctx);
const server = new RuntimeServer({ endpointPath: endpointPath(home), native, logger: ctx.logger(), version: "0.5.0-test" });
const endpoint = await server.start();
const client = new Client(endpoint.port);
await client.connect();
await client.result("initialize", { authToken: endpoint.token, protocolVersion: "1.0", runtime: "dsh", connectorId: "dsh-phone" });

const results = [];
async function step(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (error) {
		results.push(`FAIL ${name}: ${error.message}`);
		process.exitCode = 1;
	}
}

await step("capabilities: запись и каталоги включены", async () => {
	const capabilities = await client.result("runtime.getCapabilities");
	const byId = new Map(capabilities.capabilities.map((item) => [item.capabilityId, item]));
	assert.equal(capabilities.metadata.readOnly, false);
	assert.equal(byId.get("session.send_message").supported, true);
	assert.equal(byId.get("session.interrupt").supported, true);
	assert.equal(byId.get("catalog.model").supported, true);
	assert.equal(byId.get("catalog.permission").supported, true);
	assert.equal(byId.get("catalog.effort").supported, true, "reasoner даёт уровень рассуждений");
	// Намеренно не поддерживаем:
	assert.equal(byId.get("session.steer").supported, false);
	assert.equal(byId.get("session.commands").supported, false);
	assert.equal(byId.get("runtime.attachment").supported, false);
	assert.equal(capabilities.metadata.attachments, false);
	const initialize = await client.result("ping");
	assert.deepEqual(initialize, { ok: true });
});

await step("каталоги отдают официальные данные DSH", async () => {
	const models = await client.result("catalog.listModels", {});
	assert.equal(models.runtime, "dsh");
	assert.equal(models.models.length, 2);
	assert.deepEqual(models.metadata.routableProviders, ["deepseek"]);
	const reasoner = models.models.find((m) => m.metadata.model === "deepseek-reasoner");
	assert.equal(reasoner.reasoningItems.length, 1);
	assert.equal(reasoner.enabled, true);
	assert.match(reasoner.selectionId, /^dsh:model:/);
	const filtered = await client.result("catalog.listModels", { query: "chat", limit: 10 });
	assert.equal(filtered.models.length, 1);
	const permissions = await client.result("catalog.listPermissions");
	assert.equal(permissions.revision, 3);
	assert.deepEqual(permissions.permissions.map((p) => p.metadata.preset), ["plan", "acceptEdits"]);
	assert.equal(permissions.permissions[0].title, "План");
	const presets = await client.result("catalog.listAgentPresets");
	assert.equal(presets.presets.length, 2);
	assert.equal(presets.presets[1].enabled, false);
	assert.equal(presets.configField.default, "standard");
	assert.equal(presets.uiField.component, "select");
});

let createdId;
let createdPlatformId;
const initialModels = await client.result("catalog.listModels", {});
await step("session.createAndStart создаёт сессию и отправляет первый текст", async () => {
	calls.length = 0;
	const result = await client.result("session.createAndStart", {
		sessionId: "session-phone-1",
		content: "привет с телефона",
		clientMessageId: "c-create-1",
		cwd: workdir,
		agentPreset: "standard",
		selections: { model: initialModels.models[0].selectionId }
	});
	assert.equal(result.accepted, true);
	createdId = result.externalSessionId;
	createdPlatformId = result.sessionId;
	assert.match(createdId, /^dshp_[0-9a-f]{16}_session-phone-1$/);
	assert.match(createdPlatformId, /^sess_dsh_[0-9a-f]{24}$/);
	const kinds = calls.map((call) => call[0]);
	assert.deepEqual(kinds, ["resolveCallConfig", "create", "workspace.create", "attachSession", "resolveAgent", "selectModel", "flush", "prompt", "flush"]);
	const create = calls.find((call) => call[0] === "create")[1];
	assert.equal(create.sessionId, createdId);
	assert.equal(create.cwd, workdir);
	assert.equal(create.agentPreset, "standard");
	const prompt = calls.find((call) => call[0] === "prompt")[1];
	assert.equal(prompt.sessionId, createdId);
	assert.equal(prompt.mode, "queue");
	assert.deepEqual(prompt.content, [{ type: "text", text: "привет с телефона" }]);
	// requestId детерминирован из clientMessageId: повтор не создаст дубль.
	assert.match(prompt.requestId, /^dshp\.[0-9a-f]{16}\./);
	// Состояние конфигурации читается из официальных проекций DSH.
	const state = await client.result("session.getState", { sessionId: createdPlatformId });
	assert.equal(state.selections.model, initialModels.models[0].selectionId);
	assert.equal(state.metadata.agentPreset, "standard");
	assert.equal(state.metadata.cwd, workdir);
	assert.equal(state.metadata.readOnly, false);
	assert.equal(state.metadata.attached, true);
	assert.equal(state.metadata.modelSelection.model, "deepseek-chat");
});

await step("повторный clientMessageId не отправляет сообщение второй раз", async () => {
	calls.length = 0;
	const result = await client.result("session.startTurn", {
		sessionId: createdPlatformId,
		content: "привет с телефона",
		clientMessageId: "c-create-1"
	});
	assert.equal(result.accepted, true);
	assert.equal(calls.some((call) => call[0] === "prompt"), false, "повтор не должен дойти до prompt");
});

await step("session.startTurn шлёт текст в существующую сессию", async () => {
	calls.length = 0;
	const result = await client.result("session.startTurn", { sessionId: createdPlatformId, content: "второй вопрос", clientMessageId: "c-2" });
	assert.equal(result.accepted, true);
	assert.equal(result.externalSessionId, createdId);
	const prompt = calls.find((call) => call[0] === "prompt")[1];
	assert.deepEqual(prompt.content, [{ type: "text", text: "второй вопрос" }]);
});

await step("сбой prompt -> ok:false с публичным кодом, соединение живое", async () => {
	const result = await client.result("session.startTurn", { sessionId: createdPlatformId, content: "упади", clientMessageId: "c-3" });
	assert.equal(result.ok, false);
	assert.equal(result.code, "INVALID_PARAMS");
	assert.equal(result.result.messageAccepted, false);
	assert.equal(result.result.externalSessionId, createdId);
	assert.deepEqual(await client.result("ping"), { ok: true });
});

await step("недопустимый agentPreset -> ok:false, сессия не создана", async () => {
	const before = calls.filter((call) => call[0] === "create").length;
	const result = await client.result("session.createAndStart", {
		sessionId: "session-phone-broken",
		content: "текст",
		clientMessageId: "c-4",
		cwd: workdir,
		agentPreset: "broken"
	});
	assert.equal(result.ok, false);
	assert.equal(result.code, "INVALID_PARAMS");
	assert.equal(calls.filter((call) => call[0] === "create").length, before);
});

await step("createAndStart с негодным cwd -> ok:false INVALID_PARAMS", async () => {
	const result = await client.result("session.createAndStart", { sessionId: "session-phone-bad", content: "текст", clientMessageId: "c-5", cwd: "relative/path" });
	assert.equal(result.ok, false);
	assert.equal(result.code, "INVALID_PARAMS");
	const missing = await client.result("session.createAndStart", { sessionId: "session-phone-bad2", content: "текст", clientMessageId: "c-6", cwd: join(tmpdir(), "точно-нет-такой-папки-12345") });
	assert.equal(missing.ok, false);
	assert.equal(missing.code, "INVALID_PARAMS");
});

await step("updateSelections меняет модель и права, отдаёт новое состояние", async () => {
	calls.length = 0;
	const models = await client.result("catalog.listModels", {});
	const reasoner = models.models.find((m) => m.metadata.model === "deepseek-reasoner");
	const permissions = await client.result("catalog.listPermissions");
	const result = await client.result("session.updateSelections", {
		sessionId: createdPlatformId,
		selections: { model: reasoner.selectionId, permission: permissions.permissions[1].selectionId }
	});
	assert.equal(result.ok, true);
	assert.equal(result.result.state.sessionId, createdPlatformId);
	assert.equal(result.result.state.selections.model, reasoner.selectionId);
	const kinds = calls.map((call) => call[0]);
	assert.ok(kinds.includes("selectModel"));
	assert.ok(kinds.includes("commands.execute"), "смена прав у живого агента идёт командой /permission");
	assert.deepEqual(calls.find((call) => call[0] === "commands.execute").slice(1), [createdId, "/permission acceptEdits"]);
	// Пустой набор изменений — ошибка параметров, а не тихий успех.
	const empty = await client.request("session.updateSelections", { sessionId: createdPlatformId, selections: {} });
	assert.equal(empty.error.data.code, "INVALID_PARAMS");
});

await step("неудачный updateSelections возвращает ok:false и текущее состояние", async () => {
	const models = await client.result("catalog.listModels", {});
	const bad = models.models[0].selectionId.replace(/.$/, "A");
	const frame = await client.request("session.updateSelections", { sessionId: createdPlatformId, selections: { model: bad } });
	if (frame.error) {
		// Не-канонический selectionId отклоняется ещё до записи.
		assert.equal(frame.error.data.code, "INVALID_PARAMS");
	} else {
		assert.equal(frame.result.ok, false);
		assert.ok(frame.result.result.state);
	}
});

await step("interrupt доходит до agents.cancel", async () => {
	calls.length = 0;
	const result = await client.result("session.interrupt", { sessionId: createdPlatformId });
	assert.equal(result.accepted, true);
	assert.deepEqual(calls.find((call) => call[0] === "cancel"), ["cancel", createdId]);
});

await step("созданная сессия видна в list, getState и getSnapshot", async () => {
	const page = await client.result("session.list", { limit: 100 });
	const found = page.sessions.find((s) => s.externalSessionId === createdId);
	assert.ok(found, "новая сессия должна быть в списке");
	assert.equal(found.sessionId, createdPlatformId);
	assert.equal(found.metadata.live, true);
	const state = await client.result("session.getState", { sessionId: createdPlatformId });
	assert.equal(state.status, "running");
	assert.equal(state.metadata.attached, true);
	const snapshot = await client.result("session.getSnapshot", { sessionId: createdPlatformId });
	assert.equal(snapshot.metadata.projectionVersion, 2);
	assert.ok(snapshot.items.length >= 1);
	assert.equal(snapshot.items[0].role, "user");
	// clientMessageId возвращается клиенту: телефон сопоставляет своё сообщение.
	assert.equal(snapshot.items[0].source.clientMessageId, "c-create-1");
});

client.end();
await server.close();
await native.close();
await rm(home, { recursive: true, force: true });
await rm(workdir, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(process.exitCode ? "WRITE-PATH FAILED" : "WRITE-PATH OK");
process.exit(process.exitCode ?? 0);
