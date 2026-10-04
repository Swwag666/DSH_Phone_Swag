/**
 * Идентичность и хеши. Эти алгоритмы — часть протокола, а не внутренняя деталь:
 * клиент AA (Python) и узел dsh-phone (Rust) сами пересчитывают contentHash и
 * сравнивают его со своим, поэтому любое отклонение от формул приводит к
 * «расхождению истории» на телефоне. Формулы совпадают с мостом AA, кроме
 * префикса платформенного id сессии: у нас свой namespace, и `aa_*` ветка нам
 * не нужна (её наличие позволило бы чужому клиенту подсовывать свои id).
 */
import { createHash } from "node:crypto";
import { BridgeError, record } from "./errors.js";

export function digest(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Платформенный (namespace'd) id сессии из нативного id DSH. */
export function sessionId(namespace, externalId) {
	return `sess_dsh_${digest(`${namespace}:dsh:${externalId}`).slice(0, 24)}`;
}

/**
 * Обратное направление: по «сырому» id, который придумал клиент (например
 * `session-<uuid>` из формы нового чата), получаем нативный id DSH. Формат
 * проверяем жёстко — этот id уходит в sessionController.create и дальше в путь
 * на диске DSH.
 */
export function nativeSessionId(namespace, platformId) {
	if (typeof platformId !== "string" || !/^[\w-]{1,128}$/.test(platformId)) throw new BridgeError("INVALID_PARAMS", "Недопустимый идентификатор сессии.");
	return `dshp_${digest(namespace).slice(0, 16)}_${platformId}`;
}

/** Детерминированный id элемента таймлайна. */
export function itemId(externalId, kind, businessId) {
	return `dsh_${digest(`${externalId}\0${kind}\0${businessId}`)}`;
}

/**
 * requestId пользовательского сообщения. Префикс свой (`dshp.`), но структура та
 * же, что у AA: по нему мы потом возвращаем клиенту его clientMessageId, чтобы
 * телефон мог сопоставить «своё» сообщение в истории.
 */
export function userMessageId(externalId, clientId) {
	return `dshp.${digest(externalId).slice(0, 16)}.${Buffer.from(clientId).toString("base64url")}`;
}

export function clientMessageId(externalId, nativeId) {
	const prefix = `dshp.${digest(externalId).slice(0, 16)}.`;
	if (typeof nativeId !== "string" || !nativeId.startsWith(prefix)) return;
	const value = Buffer.from(nativeId.slice(prefix.length), "base64url").toString("utf8");
	// Обратная проверка: base64url не инъективен по произвольным байтам, поэтому
	// убеждаемся, что перекодирование даёт тот же id.
	if (value && userMessageId(externalId, value) === nativeId) return value;
}

/**
 * Канонический JSON: сортировка ключей по кодовым точкам и нормализация
 * экспоненты чисел. Нужен потому, что contentHash считается на обеих сторонах
 * канала и должен совпадать побайтово.
 */
export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value).sort((a, b) => {
			const aa = Array.from(a, (c) => c.codePointAt(0));
			const bb = Array.from(b, (c) => c.codePointAt(0));
			for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
			return aa.length - bb.length;
		}).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
	}
	if (typeof value === "number") {
		let text = JSON.stringify(value);
		if (text.includes(".") && Math.abs(value) < 1e-4 && value !== 0) text = value.toExponential();
		return text.replace(/e([+-]?)(\d+)$/, (_, sign, exponent) => `e${sign || "+"}${exponent.padStart(2, "0")}`);
	}
	return JSON.stringify(value);
}

/** Хеш содержимого элемента: считается только по видимым клиенту полям. */
export function contentHash(item) {
	return `sha256:${digest(canonicalJson({ type: item.type, status: item.status, role: item.role, content: item.content }))}`;
}

/**
 * Размер JSON без сериализации копии. Бюджеты кадров (7 MiB на батч/страницу)
 * проверяются на каждом элементе, а аллоцировать по строке на элемент в потоке
 * стриминга — лишняя нагрузка на GC.
 */
export function jsonBytes(value) {
	const seen = new Set();
	function stringBytes(text) {
		let bytes = Buffer.byteLength(text) + 2;
		for (const match of text.matchAll(/[\u0000-\u001f"\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g)) {
			const char = match[0];
			bytes += ["\"", "\\", "\b", "\f", "\n", "\r", "\t"].includes(char) ? 1 : char.charCodeAt(0) < 32 ? 5 : 3;
		}
		return bytes;
	}
	function size(input) {
		if (input === null || input === void 0) return 4;
		if (typeof input === "string") return stringBytes(input);
		if (typeof input === "boolean") return input ? 4 : 5;
		if (typeof input === "number") return Number.isFinite(input) ? String(Object.is(input, -0) ? 0 : input).length : 4;
		if (typeof input !== "object") throw new TypeError("Expected JSON data");
		if (seen.has(input)) throw new TypeError("Cyclic JSON data");
		seen.add(input);
		let bytes = 2, count = 0;
		if (Array.isArray(input)) {
			for (const entry of input) {
				bytes += size(entry);
				count++;
			}
		} else {
			for (const [key, entry] of Object.entries(input)) {
				if (entry === void 0) continue;
				bytes += stringBytes(key) + 1 + size(entry);
				count++;
			}
		}
		seen.delete(input);
		return bytes + Math.max(0, count - 1);
	}
	return size(value);
}

/** Безопасное JSON-преобразование чужих данных: undefined -> undefined. */
export function json(value) {
	return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
}

/** ---------- Идентификаторы выбранных модели и прав ---------- */

export function modelSelectionId(selection) {
	return `dsh:model:${Buffer.from(JSON.stringify([selection.provider, selection.model, selection.reasoningEffort ?? null])).toString("base64url")}`;
}

export function permissionSelectionId(preset) {
	return `dsh:permission:${Buffer.from(preset).toString("base64url")}`;
}

function decode(value, prefix) {
	const body = String(value).slice(prefix.length);
	if (!String(value).startsWith(prefix) || !/^[\w-]+$/.test(body) || body.length > 16384) throw new BridgeError("INVALID_PARAMS", "Недопустимый идентификатор выбора DSH.");
	const text = Buffer.from(body, "base64url").toString("utf8");
	// Проверяем каноничность кодирования: иначе один и тот же выбор можно
	// прислать двумя строками и кэш/сравнения начнут расходиться.
	if (Buffer.from(text).toString("base64url") !== body) throw new BridgeError("INVALID_PARAMS", "Недопустимая кодировка выбора DSH.");
	return text;
}

export function decodeModelSelection(value) {
	let parts;
	try {
		parts = JSON.parse(decode(value, "dsh:model:"));
	} catch {
		throw new BridgeError("INVALID_PARAMS", "Недопустимый выбор модели DSH.");
	}
	if (!Array.isArray(parts) || parts.length !== 3 || !nonempty(parts[0]) || !nonempty(parts[1]) || (parts[2] !== null && !nonempty(parts[2]))) {
		throw new BridgeError("INVALID_PARAMS", "Выбор модели должен содержать провайдера, модель и уровень рассуждений.");
	}
	const selection = { provider: parts[0], model: parts[1], ...(parts[2] === null ? {} : { reasoningEffort: parts[2] }) };
	if (modelSelectionId(selection) !== value) throw new BridgeError("INVALID_PARAMS", "Выбор модели должен использовать каноническую кодировку.");
	return selection;
}

export function decodePermissionSelection(value) {
	const preset = decode(value, "dsh:permission:");
	if (!preset || preset === "custom" || preset.trim() !== preset || /[\r\n]/u.test(preset)) throw new BridgeError("INVALID_PARAMS", "Выберите переключаемый пресет прав DSH.");
	return preset;
}

/**
 * Разбор `selections` из запроса. Пустой объект — валиден (ничего не меняем),
 * а вот неизвестный ключ или пустая строка — ошибка: молча игнорировать выбор
 * пользователя нельзя, он увидит «сохранилось», хотя ничего не применилось.
 */
export function parseSelections(value) {
	if (value === void 0) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("INVALID_PARAMS", "Selections должен быть объектом.");
	const selection = {};
	for (const [key, item] of Object.entries(value)) {
		if (!["model", "permission"].includes(key) || !nonempty(item)) throw new BridgeError("INVALID_PARAMS", "Для изменения конфигурации нужен конкретный идентификатор выбора.");
		if (key === "model") {
			decodeModelSelection(item);
			selection.model = item;
		} else {
			decodePermissionSelection(item);
			selection.permission = item;
		}
	}
	return selection;
}

export function nonempty(value) {
	return typeof value === "string" && value.length > 0;
}
