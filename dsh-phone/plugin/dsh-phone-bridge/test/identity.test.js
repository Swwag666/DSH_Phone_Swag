/**
 * Тесты идентичности и хешей. Эти формулы — часть протокола: клиент AA и узел
 * dsh-phone пересчитывают их сами, поэтому проверяем не «работает ли», а
 * «совпадает ли с эталоном» (включая точные префиксы и длину хеша).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	canonicalJson,
	clientMessageId,
	contentHash,
	digest,
	itemId,
	jsonBytes,
	modelSelectionId,
	nativeSessionId,
	decodeModelSelection,
	decodePermissionSelection,
	permissionSelectionId,
	parseSelections,
	sessionId,
	userMessageId
} from "../lib/host/identity.js";
import { BridgeError } from "../lib/host/errors.js";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("sessionId: точная формула и формат", () => {
	const id = sessionId("dsh-phone", "session-abc");
	assert.equal(id, `sess_dsh_${sha256("dsh-phone:dsh:session-abc").slice(0, 24)}`);
	assert.match(id, /^sess_dsh_[0-9a-f]{24}$/);
	// Детерминизм и различимость namespace: без этого два устройства увидели бы
	// один и тот же id для разных сессий.
	assert.equal(sessionId("dsh-phone", "session-abc"), id);
	assert.notEqual(sessionId("dsh-phone-2", "session-abc"), id);
	assert.notEqual(sessionId("dsh-phone", "session-abd"), id);
});

test("nativeSessionId принимает только безопасные символы", () => {
	assert.equal(nativeSessionId("ns", "session-1"), `dshp_${sha256("ns").slice(0, 16)}_session-1`);
	for (const bad of ["", "a".repeat(129), "../etc", "with space", "слэш/"]) {
		assert.throws(() => nativeSessionId("ns", bad), (error) => error instanceof BridgeError && error.code === "INVALID_PARAMS", String(bad));
	}
});

test("itemId и contentHash стабильны", () => {
	assert.equal(itemId("ext", "tool", "call-1"), `dsh_${sha256("ext\0tool\0call-1")}`);
	assert.notEqual(itemId("ext", "tool", "call-1"), itemId("ext", "message", "call-1"));
	const item = { type: "message", status: "done", role: "user", content: { kind: "markdown", text: "привет" } };
	const hash = contentHash(item);
	assert.match(hash, /^sha256:[0-9a-f]{64}$/);
	assert.equal(hash, contentHash({ ...item }));
	// Хеш не зависит от порядка ключей и от полей вне {type,status,role,content}.
	assert.equal(hash, contentHash({ ...item, id: "другой", orderSeq: 99, source: { seq: 5 } }));
	assert.notEqual(hash, contentHash({ ...item, status: "running" }));
	assert.notEqual(hash, contentHash({ ...item, content: { kind: "markdown", text: "пока" } }));
});

test("canonicalJson сортирует ключи и нормализует числа", () => {
	assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
	assert.equal(canonicalJson({ a: { d: 1, c: [1, { f: 2, e: 3 }] } }), '{"a":{"c":[1,{"e":3,"f":2}],"d":1}}');
	assert.equal(canonicalJson(null), "null");
	assert.equal(canonicalJson("x"), '"x"');
	assert.equal(canonicalJson(true), "true");
	assert.equal(canonicalJson(0), "0");
	assert.equal(canonicalJson(-0), "0");
	// Экспонента нормализуется: у клиента другой язык и другой формат чисел,
	// поэтому без нормализации хеши не сошлись бы.
	assert.equal(canonicalJson(1e-7), "1e-07");
	assert.equal(canonicalJson(0.00005), "5e-05");
	assert.equal(canonicalJson(123456789012345678901234567890), "1.2345678901234568e+29");
});

test("userMessageId / clientMessageId — обратимая пара", () => {
	const native = userMessageId("ext-1", "c-42");
	assert.match(native, /^dshp\.[0-9a-f]{16}\./);
	assert.equal(clientMessageId("ext-1", native), "c-42");
	assert.equal(clientMessageId("ext-2", native), void 0);
	assert.equal(clientMessageId("ext-1", "aa.что-то"), void 0);
	assert.equal(clientMessageId("ext-1", void 0), void 0);
	// Кириллица и спецсимволы в clientMessageId переживают base64url.
	const unicode = userMessageId("ext-1", "сообщение-№5");
	assert.equal(clientMessageId("ext-1", unicode), "сообщение-№5");
});

test("jsonBytes совпадает с длиной сериализованного JSON", () => {
	const samples = [
		{},
		[],
		null,
		true,
		0,
		-0,
		12345,
		1.5,
		"строка",
		"\"кавычки\" и \\слэш\\",
		"перенос\nстроки\tтабуляция",
		{ a: 1, b: [1, 2, { c: "d" }], e: null },
		{ emoji: "😀", cn: "中文", ru: "русский" },
		{ skip: void 0, keep: 1 }
	];
	for (const sample of samples) {
		assert.equal(jsonBytes(sample), Buffer.byteLength(JSON.stringify(sample)), JSON.stringify(sample));
	}
});

test("jsonBytes детектирует цикл и не-JSON", () => {
	const cyclic = {};
	cyclic.self = cyclic;
	assert.throws(() => jsonBytes(cyclic), /Cyclic/);
	assert.throws(() => jsonBytes(() => {}), /Expected JSON data/);
});

test("modelSelectionId кодирует и декодирует выбор модели", () => {
	const selection = { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" };
	const id = modelSelectionId(selection);
	assert.ok(id.startsWith("dsh:model:"));
	assert.deepEqual(decodeModelSelection(id), selection);
	const withoutEffort = modelSelectionId({ provider: "p", model: "m" });
	assert.deepEqual(decodeModelSelection(withoutEffort), { provider: "p", model: "m" });
});

test("decodeModelSelection отклоняет подделки", () => {
	const id = modelSelectionId({ provider: "p", model: "m" });
	const bad = [
		"dsh:model:notbase64!!",
		"dsh:model:",
		"dsh:permission:abc",
		"",
		"dsh:model:" + Buffer.from(JSON.stringify(["p", "m"])).toString("base64url"),
		"dsh:model:" + Buffer.from(JSON.stringify(["", "m", null])).toString("base64url"),
		"dsh:model:" + Buffer.from(JSON.stringify(["p", "m", null, "extra"])).toString("base64url"),
		"dsh:model:" + Buffer.from(JSON.stringify({ provider: "p" })).toString("base64url")
	];
	for (const value of bad) {
		assert.throws(() => decodeModelSelection(value), (error) => error instanceof BridgeError, String(value));
	}
	// Не-каноническое кодирование той же тройки тоже отклоняется.
	const tampered = id.slice(0, -2) + (id.endsWith("A") ? "BB" : "AA");
	assert.throws(() => decodeModelSelection(tampered), (error) => error instanceof BridgeError);
});

test("permissionSelectionId: custom не переключаем", () => {
	const id = permissionSelectionId("acceptEdits");
	assert.deepEqual(decodePermissionSelection(id), "acceptEdits");
	assert.throws(() => decodePermissionSelection(permissionSelectionId("custom")), (error) => error.code === "INVALID_PARAMS");
	assert.throws(() => decodePermissionSelection(permissionSelectionId("  padded")), (error) => error.code === "INVALID_PARAMS");
	assert.throws(() => decodePermissionSelection(permissionSelectionId("with\nnewline")), (error) => error.code === "INVALID_PARAMS");
});

test("parseSelections принимает только конкретные выборы", () => {
	assert.deepEqual(parseSelections(void 0), {});
	assert.deepEqual(parseSelections({}), {});
	const model = modelSelectionId({ provider: "p", model: "m" });
	assert.deepEqual(parseSelections({ model }), { model });
	assert.deepEqual(parseSelections({ permission: permissionSelectionId("plan") }), { permission: permissionSelectionId("plan") });
	for (const bad of [[], "строка", 5, { effort: "high" }, { model: "" }, { model: 5 }, { unknown: permissionSelectionId("plan") }]) {
		assert.throws(() => parseSelections(bad), (error) => error.code === "INVALID_PARAMS", JSON.stringify(bad));
	}
});

test("digest — это sha256 hex", () => {
	assert.equal(digest("abc"), sha256("abc"));
	assert.match(digest(""), /^[0-9a-f]{64}$/);
});
