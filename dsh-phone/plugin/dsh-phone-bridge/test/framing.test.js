/**
 * Тесты кадрирования и проверки конверта. Здесь живут ограничения, которые не
 * дают одному вредному/сбойному клиенту убить процесс DSH, поэтому проверяем их
 * буквально: потолок кадра, ресинхронизацию после «гиганта», склейку кадра из
 * нескольких пакетов и отказ принимать мусор до исполнения метода.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	FrameDecoder,
	MAX_FRAME_BYTES,
	encodeFrame,
	isCancelNotification,
	parseFrame,
	safeMethodName,
	validateHandshake,
	validateRequest,
	validateRequestId
} from "../lib/host/framing.js";
import { BridgeError } from "../lib/host/errors.js";

const frame = (value) => `${JSON.stringify(value)}\n`;

test("encodeFrame добавляет ровно один LF", () => {
	const buffer = encodeFrame({ jsonrpc: "2.0", id: 1, result: { ok: true } });
	assert.equal(buffer.at(-1), 10);
	assert.equal(buffer.toString("utf8").split("\n").length, 2);
});

test("encodeFrame отказывается превышать потолок кадра", () => {
	const big = { payload: "x".repeat(MAX_FRAME_BYTES) };
	assert.throws(() => encodeFrame(big), (error) => error instanceof BridgeError && error.code === "FRAME_TOO_LARGE");
	// Чуть меньше потолка — проходит.
	assert.ok(encodeFrame({ payload: "x".repeat(MAX_FRAME_BYTES - 64) }).length <= MAX_FRAME_BYTES);
});

test("декодер собирает кадр из нескольких пакетов", () => {
	const decoder = new FrameDecoder();
	const text = frame({ jsonrpc: "2.0", id: "a", method: "ping" });
	assert.deepEqual(decoder.push(Buffer.from(text.slice(0, 5))), { frames: [], oversized: 0 });
	const rest = decoder.push(Buffer.from(text.slice(5)));
	assert.equal(rest.frames.length, 1);
	assert.equal(JSON.parse(rest.frames[0].toString()).method, "ping");
	assert.equal(decoder.pending, 0);
});

test("декодер отдаёт несколько кадров из одного пакета", () => {
	const decoder = new FrameDecoder();
	const { frames, oversized } = decoder.push(Buffer.from(frame({ id: 1 }) + frame({ id: 2 }) + frame({ id: 3 })));
	assert.equal(frames.length, 3);
	assert.equal(oversized, 0);
	assert.deepEqual(frames.map((f) => JSON.parse(f.toString()).id), [1, 2, 3]);
});

test("пустые строки не считаются кадрами и не ломают поток", () => {
	const decoder = new FrameDecoder();
	const { frames } = decoder.push(Buffer.from("\n\n" + frame({ id: 1 })));
	assert.equal(frames.length, 1);
});

test("гигантский кадр отбрасывается, поток ресинхронизируется по LF", () => {
	const decoder = new FrameDecoder();
	// Недописанный «гигант»: LF ещё не пришёл, буфер упирается в потолок.
	const first = decoder.push(Buffer.alloc(MAX_FRAME_BYTES, 97));
	assert.equal(first.frames.length, 0);
	assert.equal(first.oversized, 1);
	assert.equal(decoder.discarding, true);
	// Хвост гиганта всё ещё сливается, но следующий валидный кадр уже читается.
	const second = decoder.push(Buffer.from("aaaa\n" + frame({ id: 7 })));
	assert.equal(second.frames.length, 1);
	assert.equal(JSON.parse(second.frames[0].toString()).id, 7);
	assert.equal(decoder.discarding, false);
});

test("гигантский кадр с завершающим LF тоже отбрасывается", () => {
	const decoder = new FrameDecoder();
	const huge = Buffer.alloc(MAX_FRAME_BYTES + 10, 98);
	const payload = Buffer.concat([huge, Buffer.from("\n"), Buffer.from(frame({ id: 9 }))]);
	const { frames, oversized } = decoder.push(payload);
	assert.equal(oversized, 1);
	assert.equal(frames.length, 1);
	assert.equal(JSON.parse(frames[0].toString()).id, 9);
});

test("reset очищает неполный кадр", () => {
	const decoder = new FrameDecoder();
	decoder.push(Buffer.from("{\"partial\":"));
	assert.ok(decoder.pending > 0);
	decoder.reset();
	assert.equal(decoder.pending, 0);
});

test("parseFrame отличает битый JSON от валидного", () => {
	assert.deepEqual(parseFrame(Buffer.from("{\"a\":1}")), { a: 1 });
	assert.throws(() => parseFrame(Buffer.from("{a:1}")), (error) => error.code === "PARSE_ERROR");
	// Невалидный UTF-8 — тоже PARSE_ERROR, а не исключение декодера.
	assert.throws(() => parseFrame(Buffer.from([0xff, 0xfe, 0x0a])), (error) => error.code === "PARSE_ERROR");
});

test("validateRequest требует jsonrpc 2.0, строковый method и object params", () => {
	assert.deepEqual(validateRequest({ jsonrpc: "2.0", method: "ping" }), { method: "ping", params: {}, id: void 0 });
	assert.deepEqual(validateRequest({ jsonrpc: "2.0", method: "ping", params: { a: 1 }, id: "x" }).params, { a: 1 });
	for (const bad of [
		{ method: "ping" },
		{ jsonrpc: "1.0", method: "ping" },
		{ jsonrpc: "2.0", method: 5 },
		{ jsonrpc: "2.0", method: "ping", params: null },
		{ jsonrpc: "2.0", method: "ping", params: [1] },
		{ jsonrpc: "2.0", method: "ping", params: "строка" },
		null,
		"строка"
	]) {
		assert.throws(() => validateRequest(bad), (error) => error.code === "INVALID_REQUEST", JSON.stringify(bad));
	}
});

test("validateRequestId принимает строку и безопасное целое", () => {
	assert.equal(validateRequestId("gw-1"), "gw-1");
	assert.equal(validateRequestId(17), 17);
	for (const bad of [void 0, null, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 10, {}, [], ""]) {
		assert.throws(() => validateRequestId(bad), (error) => error.code === "INVALID_REQUEST", String(bad));
	}
});

test("isCancelNotification узнаёт уведомление об отмене", () => {
	assert.equal(isCancelNotification({ method: "$/cancelRequest", id: void 0, params: { id: "gw-3" } }), true);
	assert.equal(isCancelNotification({ method: "$/cancelRequest", id: 1 }), false);
	assert.equal(isCancelNotification({ method: "ping" }), false);
});

test("safeMethodName не пускает мусор в логи", () => {
	assert.equal(safeMethodName("session.getState"), "session.getState");
	assert.equal(safeMethodName("$/cancelRequest"), "$/cancelRequest");
	assert.equal(safeMethodName("a".repeat(200)), "invalid");
	assert.equal(safeMethodName("метод"), "invalid");
	assert.equal(safeMethodName(""), "invalid");
});

test("validateHandshake: неверный токен и неверный первый метод", () => {
	const token = "abc123";
	const base = { authToken: token, protocolVersion: "1.0", runtime: "dsh", connectorId: "dsh-phone" };
	assert.deepEqual(validateHandshake(base, token), { ok: true, namespace: "dsh-phone" });
	// Та же длина, другие байты: тоже NOT_INITIALIZED, без подсказок.
	assert.equal(validateHandshake({ ...base, authToken: "abc124" }, token).code, "NOT_INITIALIZED");
	assert.equal(validateHandshake({ ...base, authToken: "short" }, token).code, "NOT_INITIALIZED");
	assert.equal(validateHandshake({ ...base, authToken: void 0 }, token).code, "NOT_INITIALIZED");
});

test("validateHandshake: версия протокола и runtime", () => {
	const token = "t".repeat(43);
	const base = { authToken: token, connectorId: "dsh-phone" };
	assert.equal(validateHandshake({ ...base, protocolVersion: "2.0", runtime: "dsh" }, token).code, "PROTOCOL_VERSION_MISMATCH");
	assert.equal(validateHandshake({ ...base, protocolVersion: "1", runtime: "dsh" }, token).code, "PROTOCOL_VERSION_MISMATCH");
	assert.equal(validateHandshake({ ...base, protocolVersion: "1.x", runtime: "dsh" }, token).code, "PROTOCOL_VERSION_MISMATCH");
	assert.equal(validateHandshake({ ...base, protocolVersion: "1.0", runtime: "claude" }, token).code, "PROTOCOL_VERSION_MISMATCH");
	assert.equal(validateHandshake({ ...base, protocolVersion: "1.0", runtime: "dsh" }, token).ok, true);
	assert.equal(validateHandshake({ ...base, protocolVersion: "1.12", runtime: "dsh" }, token).ok, true);
});

test("validateHandshake: namespace из sessionNamespace важнее connectorId", () => {
	const token = "xyz";
	const base = { authToken: token, protocolVersion: "1.0", runtime: "dsh" };
	assert.equal(validateHandshake({ ...base, sessionNamespace: "phone-a", connectorId: "phone-b" }, token).namespace, "phone-a");
	assert.equal(validateHandshake({ ...base, connectorId: "phone-b" }, token).namespace, "phone-b");
	assert.equal(validateHandshake({ ...base, sessionNamespace: "" }, token).code, "INVALID_PARAMS");
	assert.equal(validateHandshake({ ...base, connectorId: "x".repeat(513) }, token).code, "INVALID_PARAMS");
	assert.equal(validateHandshake({ ...base, connectorId: 5 }, token).code, "INVALID_PARAMS");
	assert.equal(validateHandshake(base, token).code, "INVALID_PARAMS");
});
