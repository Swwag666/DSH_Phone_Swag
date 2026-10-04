/**
 * Проверка жизненного цикла Cordis-сервиса на настоящем cordis.
 *
 * Всё остальное в плагине проверяется без DSH и без cordis, а здесь проверяется
 * ровно то, что без них не проверить: что `apply()` регистрирует сервис, что
 * `static inject` совпадает с реальными сервисами DSH, что `[Service.init]`
 * поднимает мост и публикует endpoint.json, и что dispose форка снимает
 * публикацию и убирает сервис с контекста. Отдельно проверяется устойчивость:
 * если endpoint уже занят живым процессом, плагин обязан остаться загруженным.
 *
 * Требуется доступный `@deepseek-ai/cordis`, поэтому запускать нужно из
 * установленного профиля DSH:
 *   cd %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-phone-bridge
 *   node scripts/smoke-cordis-lifecycle.mjs
 * В отдельной копии плагина скрипт честно печатает SKIP и завершается нулём.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let Context;
let Service;
try {
	({ Context, Service } = await import("@deepseek-ai/cordis"));
} catch {
	console.log("SKIP @deepseek-ai/cordis не разрешается из этого каталога.");
	console.log("SKIP Запусти скрипт из установленного профиля DSH (см. шапку файла).");
	process.exit(0);
}

const { DshPhoneBridgeService, apply, name, version } = await import("../lib/index.js");
const { endpointPath, publishEndpoint, buildEndpoint } = await import("../lib/host/endpoint.js");

const results = [];
async function step(label, fn) {
	try {
		await fn();
		results.push(`ok   ${label}`);
	} catch (error) {
		results.push(`FAIL ${label}: ${error.message}`);
		process.exitCode = 1;
	}
}

/** Минимальный, но честный набор сервисов DSH: только то, что реально читаем. */
function buildContext() {
	const sessions = new Map();
	sessions.set("live-1", {
		id: "live-1",
		seq: 1,
		header: { id: "live-1", cwd: "C:/work", origin: "user", createdAt: new Date() },
		snapshotEvents: () => [{ type: "user/message", seq: 0, time: 1, data: { id: "u", source: { kind: "user" }, content: [{ type: "text", text: "привет" }] } }]
	});
	const ctx = new Context();
	ctx.provide("sessions", sessions);
	ctx.provide("sessionQuery", {
		listSessions: async () => [{ header: { id: "live-1", cwd: "C:/work", origin: "user", createdAt: new Date() }, live: true, persisted: true }],
		readSession: async (id) => ({ session: { id, cwd: "C:/work" }, events: sessions.get(id)?.snapshotEvents() ?? [], inheritedEventCount: 0 })
	});
	ctx.provide("workspaceRegistry", { archivedSessionIds: [], list: () => [] });
	return ctx;
}

async function waitFor(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("условие не выполнилось вовремя");
}

async function exists(path) {
	try {
		await readFile(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

const home = await mkdtemp(join(tmpdir(), "dsh-cordis-home-"));
const file = endpointPath(home);
const ctx = buildContext();

await step("экспорт плагина соответствует ожиданиям загрузчика DSH", async () => {
	assert.equal(name, "dsh-phone-bridge");
	assert.equal(typeof version, "string");
	assert.equal(typeof apply, "function");
	assert.equal(Object.getPrototypeOf(DshPhoneBridgeService), Service, "сервис обязан наследовать Service из cordis");
	assert.deepEqual(DshPhoneBridgeService.inject, ["sessions", "sessionQuery", "workspaceRegistry"]);
	// Service.init — ключ экземплярного метода, поэтому смотрим в прототип.
	assert.equal(typeof DshPhoneBridgeService.prototype[Service.init], "function");
});

let fork;
await step("ctx.plugin поднимает мост и публикует endpoint.json", async () => {
	fork = ctx.plugin(DshPhoneBridgeService, { dshHome: home });
	await waitFor(() => exists(file));
	const endpoint = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(endpoint).sort(), ["host", "pid", "port", "token", "version"]);
	assert.equal(endpoint.host, "127.0.0.1");
	assert.equal(endpoint.pid, process.pid);
	assert.ok(ctx.dshPhoneBridge instanceof DshPhoneBridgeService, "сервис зарегистрирован в контексте");
	assert.deepEqual(ctx.dshPhoneBridge.endpoint(), endpoint);

	// И полноценный обмен по проводам: initialize, ping, session.list.
	const socket = net.connect(endpoint.port, "127.0.0.1");
	await new Promise((resolve, reject) => {
		socket.on("connect", resolve);
		socket.on("error", reject);
	});
	const frames = [];
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		let index;
		while ((index = buffer.indexOf(10)) >= 0) {
			const line = buffer.subarray(0, index).toString("utf8");
			buffer = buffer.subarray(index + 1);
			if (line) frames.push(JSON.parse(line));
		}
	});
	const send = (value) => socket.write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
	const call = async (id, method, params = {}) => {
		send({ jsonrpc: "2.0", id, method, params });
		await waitFor(() => frames.some((frame) => frame.id === id));
		return frames.find((frame) => frame.id === id);
	};
	const initialized = await call("1", "initialize", { authToken: endpoint.token, protocolVersion: "1.0", runtime: "dsh", connectorId: "dsh-phone" });
	assert.equal(initialized.result.identity.runtime, "dsh");
	assert.equal(initialized.result.identity.bridgeVersion, version);
	assert.deepEqual((await call("2", "ping")).result, { ok: true });
	const list = (await call("3", "session.list", { limit: 10 })).result;
	assert.equal(list.sessions.length, 1);
	assert.equal(list.sessions[0].externalSessionId, "live-1");
	socket.destroy();
});

await step("dispose форка закрывает сервер и убирает endpoint.json", async () => {
	if (typeof fork?.dispose === "function") fork.dispose();
	else fork?.[Symbol.dispose]?.();
	await waitFor(async () => !await exists(file));
	assert.equal(ctx.dshPhoneBridge, void 0, "сервис снят с контекста");
});

await step("apply(ctx, config) регистрирует сервис как плагин", async () => {
	const second = await mkdtemp(join(tmpdir(), "dsh-cordis-home2-"));
	const ctx2 = buildContext();
	apply(ctx2, { dshHome: second });
	await waitFor(() => exists(endpointPath(second)));
	assert.ok(ctx2.dshPhoneBridge instanceof DshPhoneBridgeService);
	await ctx2.dshPhoneBridge.server.close();
	await ctx2.dshPhoneBridge.native.close();
	await rm(second, { recursive: true, force: true });
});

await step("занятый endpoint не роняет загрузку плагина", async () => {
	const third = await mkdtemp(join(tmpdir(), "dsh-cordis-home3-"));
	const occupied = endpointPath(third);
	const ctx3 = buildContext();
	// Файл уже принадлежит «живому» процессу (наш pid): перезаписывать нельзя.
	await publishEndpoint(occupied, buildEndpoint({ port: 1, token: "занято", pid: process.pid }));
	const started = ctx3.plugin(DshPhoneBridgeService, { dshHome: third });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.ok(ctx3.dshPhoneBridge instanceof DshPhoneBridgeService, "сервис создан, несмотря на сбой старта");
	assert.equal(JSON.parse(await readFile(occupied, "utf8")).token, "занято", "чужой endpoint не перезаписан");
	assert.equal(ctx3.dshPhoneBridge.endpoint(), null);
	if (typeof started?.dispose === "function") started.dispose();
	else started?.[Symbol.dispose]?.();
	await ctx3.dshPhoneBridge?.server?.dispose?.().catch(() => void 0);
	await rm(third, { recursive: true, force: true });
});

await rm(home, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(process.exitCode ? "CORDIS LIFECYCLE FAILED" : "CORDIS LIFECYCLE OK");
process.exit(process.exitCode ?? 0);
