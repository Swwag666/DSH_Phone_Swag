/**
 * Тесты модуля ошибок. Проверяют то, что обязано совпадать с мостом Agents
 * Anywhere: числовые коды, форму `error` и правила сведения нативных ошибок DSH
 * к публичным. Любое расхождение здесь ломает уже собранный Rust-узел.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BridgeError, codes, errorFrame, publicError, record } from "../lib/host/errors.js";

test("числовые коды совпадают с протоколом AA", () => {
	assert.deepEqual(codes, {
		PARSE_ERROR: -32700,
		INVALID_REQUEST: -32600,
		METHOD_NOT_FOUND: -32601,
		INVALID_PARAMS: -32602,
		INTERNAL_ERROR: -32603,
		UNSUPPORTED_OPERATION: -32001,
		SESSION_NOT_FOUND: -32002,
		REQUEST_TIMEOUT: -32006,
		DSH_SERVICE_UNAVAILABLE: -32007,
		PERSISTENCE_ERROR: -32008,
		PROTOCOL_VERSION_MISMATCH: -32009,
		NOT_INITIALIZED: -32012,
		FRAME_TOO_LARGE: -32013,
		SESSION_ARCHIVED: -32014
	});
});

test("toJSON отдаёт числовой code и строковый code в data", () => {
	const error = new BridgeError("SESSION_NOT_FOUND", "нет сессии");
	assert.deepEqual(error.toJSON(), {
		code: -32002,
		message: "нет сессии",
		data: { code: "SESSION_NOT_FOUND", retryable: false }
	});
	assert.equal(new BridgeError("REQUEST_TIMEOUT", "t", true).toJSON().data.retryable, true);
});

test("неизвестный строковый код не порождает undefined в кадре", () => {
	const error = new BridgeError("SOMETHING_NEW", "x");
	assert.equal(error.toJSON().code, codes.INTERNAL_ERROR);
});

test("publicError пропускает BridgeError без изменений", () => {
	const error = new BridgeError("INVALID_PARAMS", "p");
	assert.equal(publicError(error), error);
});

test("publicError разбирает удалённые ошибки DSH", () => {
	const attachment = publicError({ isDSHRemoteError: true, code: "session/attachment-invalid", details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" } });
	assert.equal(attachment.code, "INVALID_PARAMS");
	const model = publicError({ isDSHRemoteError: true, code: "session/model-unavailable" });
	assert.equal(model.code, "INVALID_PARAMS");
	const preset = publicError({ isDSHRemoteError: true, code: "agent-preset/broken" });
	assert.equal(preset.code, "INVALID_PARAMS");
	const other = publicError({ isDSHRemoteError: true, code: "whatever" });
	assert.equal(other.code, "DSH_SERVICE_UNAVAILABLE");
	assert.equal(other.retryable, true);
});

test("publicError знает коды SessionQuery, отмену и неизвестные ошибки", () => {
	assert.equal(publicError({ code: "SESSION_QUERY_SESSION_NOT_FOUND" }).code, "SESSION_NOT_FOUND");
	assert.equal(publicError({ code: "SESSION_QUERY_PERSISTENCE_FAILED" }).code, "PERSISTENCE_ERROR");
	const aborted = new Error("aborted");
	aborted.name = "AbortError";
	const mapped = publicError(aborted);
	assert.equal(mapped.code, "REQUEST_TIMEOUT");
	assert.equal(mapped.retryable, true);
	const generic = publicError(new Error("внутренний текст DSH"));
	assert.equal(generic.code, "INTERNAL_ERROR");
	// Внутренний текст не должен утекать клиенту.
	assert.equal(generic.message.includes("внутренний текст"), false);
});

test("errorFrame формирует кадр ответа", () => {
	const frame = errorFrame("gw-1", new BridgeError("METHOD_NOT_FOUND", "нет метода"));
	assert.equal(frame.jsonrpc, "2.0");
	assert.equal(frame.id, "gw-1");
	assert.equal(frame.error.code, -32601);
	assert.equal(errorFrame(void 0, new Error("x")).id, null);
});

test("record приводит мусор к объекту", () => {
	assert.deepEqual(record(null), {});
	assert.deepEqual(record(void 0), {});
	assert.deepEqual(record("строка"), {});
	assert.deepEqual(record(5), {});
	assert.deepEqual(record({ a: 1 }), { a: 1 });
	assert.deepEqual(record([1, 2]), [1, 2]);
});
