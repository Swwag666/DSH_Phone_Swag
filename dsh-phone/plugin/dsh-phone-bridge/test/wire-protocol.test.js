/**
 * Проводной тест моста: поднимает настоящий RuntimeServer (framing, auth,
 * envelope, router) с минимальным фейковым native и говорит с ним тем же
 * handshake, который шлёт Rust-узел (bridge.rs::request_initialize).
 *
 * Зачем: совместимость с узлом - это не «примерно те же имена методов», а точный
 * контракт рукопожатия. Если здесь что-то разъедется, телефон молча останется
 * без моста, поэтому договор проверяется отдельным тестом, без DSH и без сети
 * наружу (всё на 127.0.0.1 и случайном порту).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeServer } from "../lib/host/server.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Минимальный native: handshake и ping до сервисов DSH не дотрагиваются. */
function fakeNative() {
	return {
		readOnly: false,
		questions: { available: false, waiting: () => false, notices: () => [] }
	};
}

/** Параметры initialize ровно как в Rust bridge.rs. */
function initParams(token, over = {}) {
	return {
		authToken: token,
		protocolVersion: "1.0",
		runtime: "dsh",
		connectorId: "dsh-phone",
		sessionNamespace: "dsh-phone",
		clientInfo: { name: "dsh-phone-desktop", version: "test" },
		...over
	};
}

async function withServer(run) {
	const dir = await mkdtemp(join(tmpdir(), "dshpb-wire-"));
	const endpointPath = join(dir, "endpoint.json");
	const server = new RuntimeServer({ endpointPath, native: fakeNative(), logger: quiet, version: "0.5.0-test" });
	const endpoint = await server.start();
	try {
		await run({ endpoint, endpointPath, server });
	} finally {
		await server.close();
		await rm(dir, { recursive: true, force: true });
	}
}

/** Клиент с очередью кадров: LF-разделённый JSON, как на проводе. */
function openClient(endpoint) {
	return new Promise((resolve, reject) => {
		const socket = connect(endpoint.port, endpoint.host, () => {
			const frames = [];
			const waiters = [];
			let buffer = Buffer.alloc(0);
			let ended = false;
			socket.on("data", (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				let idx = buffer.indexOf(10);
				while (idx >= 0) {
					const line = buffer.subarray(0, idx).toString("utf8");
					buffer = Buffer.from(buffer.subarray(idx + 1));
					idx = buffer.indexOf(10);
					if (!line.trim()) continue;
					const frame = JSON.parse(line);
					const waiter = waiters.shift();
					if (waiter) waiter(frame);
					else frames.push(frame);
				}
			});
			socket.on("close", () => {
				ended = true;
				while (waiters.length) waiters.shift()(null);
			});
			socket.on("error", () => {});
			const send = (obj) => socket.write(JSON.stringify(obj) + "\n");
			const next = (timeoutMs = 3000) =>
				new Promise((res, rej) => {
					if (frames.length) return res(frames.shift());
					if (ended) return res(null);
					const timer = setTimeout(() => rej(new Error("таймаут ожидания кадра")), timeoutMs);
					timer.unref?.();
					waiters.push((frame) => {
						clearTimeout(timer);
						res(frame);
					});
				});
			resolve({ socket, send, next });
		});
		socket.once("error", reject);
	});
}

async function handshake(endpoint, over) {
	const client = await openClient(endpoint);
	client.send({ jsonrpc: "2.0", id: "init-1", method: "initialize", params: initParams(endpoint.token, over) });
	const frame = await client.next();
	return { client, frame };
}

test("endpoint.json публикует host/port/token/pid версии 1", async () => {
	await withServer(async ({ endpointPath, endpoint }) => {
		const raw = await readFile(endpointPath, "utf8");
		const file = JSON.parse(raw);
		assert.equal(file.version, 1);
		assert.equal(file.host, "127.0.0.1");
		assert.equal(file.port, endpoint.port);
		assert.equal(file.token, endpoint.token);
		assert.equal(file.pid, process.pid);
		// узел читает файл как есть: никакой обвязки, только компактный JSON
		assert.ok(!raw.endsWith("\n"), "файл не должен заканчиваться переводом строки");
	});
});

test("initialize с токеном узла отдаёт identity runtime=dsh", async () => {
	await withServer(async ({ endpoint }) => {
		const { client, frame } = await handshake(endpoint);
		assert.equal(frame.id, "init-1");
		assert.equal(frame.error, undefined);
		assert.equal(frame.result.identity.runtime, "dsh");
		assert.equal(frame.result.identity.protocolVersion, "1.0");
		assert.equal(frame.result.storage.mode, "dsh-native");
		assert.equal(frame.result.features.projectionVersion, 2);
		assert.equal(frame.result.features.snapshotPagination, true);
		client.socket.destroy();
	});
});

test("чужой токен не проходит: NOT_INITIALIZED -32012", async () => {
	await withServer(async ({ endpoint }) => {
		const { client, frame } = await handshake(endpoint, { authToken: "совершенно-другой-токен" });
		assert.equal(frame.error?.code, -32012);
		assert.equal(frame.error?.data?.code, "NOT_INITIALIZED");
		client.socket.destroy();
	});
});

test("первый запрос не initialize - тоже NOT_INITIALIZED", async () => {
	await withServer(async ({ endpoint }) => {
		const client = await openClient(endpoint);
		client.send({ jsonrpc: "2.0", id: "x", method: "ping" });
		const frame = await client.next();
		assert.equal(frame.error?.code, -32012);
		client.socket.destroy();
	});
});

test("protocolVersion 2.x отвергается: PROTOCOL_VERSION_MISMATCH -32009", async () => {
	await withServer(async ({ endpoint }) => {
		const { client, frame } = await handshake(endpoint, { protocolVersion: "2.0" });
		assert.equal(frame.error?.code, -32009);
		assert.equal(frame.error?.data?.code, "PROTOCOL_VERSION_MISMATCH");
		client.socket.destroy();
	});
});

test("runtime не dsh отвергается тем же кодом", async () => {
	await withServer(async ({ endpoint }) => {
		const { client, frame } = await handshake(endpoint, { runtime: "claude" });
		assert.equal(frame.error?.code, -32009);
		client.socket.destroy();
	});
});

test("после handshake работают ping и неизвестный метод", async () => {
	await withServer(async ({ endpoint }) => {
		const { client } = await handshake(endpoint);
		client.send({ jsonrpc: "2.0", id: "gw-1", method: "ping", params: {} });
		const pong = await client.next();
		assert.deepEqual(pong.result, { ok: true });
		assert.equal(pong.error, undefined);

		client.send({ jsonrpc: "2.0", id: "gw-2", method: "session.nope", params: {} });
		const missing = await client.next();
		assert.equal(missing.error?.code, -32601);
		assert.equal(missing.error?.data?.code, "METHOD_NOT_FOUND");
		client.socket.destroy();
	});
});

test("конверт проверяется: одновременный повтор id и запрос без id", async () => {
	await withServer(async ({ endpoint }) => {
		const { client } = await handshake(endpoint);
		// Два одинаковых id одновременно: второй обязан быть отвергнут, иначе
		// ответ нельзя однозначно сопоставить запросу. Последовательный повтор
		// того же id легален (проверяется именно набор запросов в полёте).
		// Одновременность на проводе гарантируется ОДНИМ write: два отдельных
		// socket.write TCP может доставить двумя data-событиями, и тогда первый
		// ping успевает микрозадачно завершиться (pong + inFlight.delete) до
		// dispatch второго — повтора id в полёте уже нет, и оба ответа легально
		// успешны. На Linux CI (Nagle, epoll) split был стабильным флейком.
		const dup = JSON.stringify({ jsonrpc: "2.0", id: "dup", method: "ping", params: {} }) + "\n";
		client.socket.write(dup + dup);
		const a = await client.next();
		const b = await client.next();
		const rejected = [a, b].find((frame) => frame && frame.error);
		assert.equal(rejected?.error?.code, -32600);
		assert.equal(rejected?.error?.data?.code, "INVALID_REQUEST");

		client.send({ jsonrpc: "2.0", method: "ping", params: {} });
		const noId = await client.next();
		assert.equal(noId.error?.code, -32600);
		client.socket.destroy();
	});
});

test("$/cancelRequest принимается как уведомление без ответа", async () => {
	await withServer(async ({ endpoint }) => {
		const { client } = await handshake(endpoint);
		client.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: "нет-такого" } });
		// ответа быть не должно: проверяем, что следующий запрос доходит живым
		client.send({ jsonrpc: "2.0", id: "after-cancel", method: "ping", params: {} });
		const frame = await client.next();
		assert.equal(frame.id, "after-cancel");
		assert.deepEqual(frame.result, { ok: true });
		client.socket.destroy();
	});
});

test("runtime.getConfig отдаёт dsh-native и честный readOnly", async () => {
	await withServer(async ({ endpoint }) => {
		const { client } = await handshake(endpoint);
		client.send({ jsonrpc: "2.0", id: "cfg", method: "runtime.getConfig", params: {} });
		const frame = await client.next();
		assert.equal(frame.result.runtime, "dsh");
		assert.equal(frame.result.metadata.storageMode, "dsh-native");
		assert.equal(frame.result.metadata.readOnly, false);
		client.socket.destroy();
	});
});
