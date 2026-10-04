/**
 * Каркас кадра: newline-delimited JSON. Модуль намеренно чистый (без net, без
 * DSH), потому что именно здесь живут ограничения, из-за которых процесс не
 * должен умереть: потолок размера кадра, ресинхронизация после «гиганта» и
 * проверка конверта JSON-RPC до того, как мы что-либо исполнили.
 */
import { timingSafeEqual } from "node:crypto";
import { BridgeError, record } from "./errors.js";

/** Потолок одного кадра в обе стороны (8 MiB), как в мосте AA и в bridge.rs. */
export const MAX_FRAME_BYTES = 8388608;
/**
 * Предел буфера записи сокета. Если клиент не читает (телефон уснул на мобильной
 * сети), мы не накапливаем гигабайты в памяти процесса DSH, а рвём соединение.
 */
export const MAX_WRITE_BUFFER = 16777216;
export const LF = 10;

/** Разрешённый формат имени метода: защищаем лог и switch от мусора. */
const METHOD_PATTERN = /^[a-zA-Z$/][a-zA-Z0-9.$/_]{0,79}$/;

/**
 * Накопитель входящих байтов.
 *
 * Почему не `readline`: строка без '\n' росла бы бесконечно. Здесь неполный
 * кадр ограничен MAX_FRAME_BYTES, а при переполнении мы не рвём соединение
 * (клиент мог прислать один мусорный кадр), а переходим в режим пропуска до
 * следующего LF — поток снова синхронизирован.
 */
export class FrameDecoder {
	#buffer = Buffer.alloc(0);
	#discarding = false;

	/** Сколько байт сейчас держим в памяти (для диагностики и тестов). */
	get pending() {
		return this.#buffer.length;
	}

	get discarding() {
		return this.#discarding;
	}

	/**
	 * @returns {{frames: Buffer[], oversized: number}} oversized — число кадров,
	 * отброшенных по размеру (на каждый нужно отправить FRAME_TOO_LARGE).
	 */
	push(chunk) {
		const frames = [];
		let oversized = 0;
		let data = chunk;
		if (this.#discarding) {
			const end = data.indexOf(LF);
			// Ещё внутри гигантского кадра: просто продолжаем сливать байты.
			if (end < 0) return { frames, oversized };
			data = data.subarray(end + 1);
			this.#discarding = false;
		}
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, data]) : Buffer.from(data);
		let newline;
		while ((newline = this.#buffer.indexOf(LF)) >= 0) {
			const frame = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			// Кадр считаем вместе с завершающим LF — так же, как считает клиент.
			if (frame.length + 1 > MAX_FRAME_BYTES) {
				oversized++;
				continue;
			}
			if (frame.length) frames.push(Buffer.from(frame));
		}
		if (this.#buffer.length >= MAX_FRAME_BYTES) {
			// Недописанный кадр уже не влезет: сбрасываем буфер и ждём LF.
			this.#buffer = Buffer.alloc(0);
			this.#discarding = true;
			oversized++;
		}
		return { frames, oversized };
	}

	reset() {
		this.#buffer = Buffer.alloc(0);
		this.#discarding = false;
	}
}

/**
 * Сериализация исходящего кадра. Превышение потолка — ошибка моста, а не повод
 * отправить обрезанный JSON: клиент прочитает его как валидный кадр и потеряет
 * часть данных молча.
 */
export function encodeFrame(value) {
	const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (line.length > MAX_FRAME_BYTES) throw new BridgeError("FRAME_TOO_LARGE", "Ответ превышает предел размера кадра моста.");
	return line;
}

/** Разбор JSON кадра: отдельная ошибка PARSE_ERROR (по стандарту JSON-RPC). */
export function parseFrame(frame) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
	} catch {
		throw new BridgeError("PARSE_ERROR", "Некорректный JSON-кадр.");
	}
}

/**
 * Проверка конверта запроса. Возвращает нормализованный вид или бросает
 * INVALID_REQUEST. Уведомление `$/cancelRequest` разбирается отдельно: у него
 * нет id, и требовать id для него означало бы потерять возможность отмены.
 */
export function validateRequest(raw) {
	const request = record(raw);
	if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new BridgeError("INVALID_REQUEST", "Ожидался объект запроса JSON-RPC 2.0.");
	if (request.params !== void 0 && (request.params === null || Array.isArray(request.params) || typeof request.params !== "object")) {
		throw new BridgeError("INVALID_REQUEST", "params должен быть объектом.");
	}
	return { method: request.method, params: record(request.params), id: request.id };
}

/** Это уведомление об отмене конкретного запроса? */
export function isCancelNotification(request) {
	return request.method === "$/cancelRequest" && request.id === void 0;
}

/**
 * Валидация id запроса: непустая строка или безопасное целое. Всё остальное
 * (float, Infinity, объект, пустая строка) делает сопоставление ответа с
 * запросом ненадёжным, поэтому отклоняется до исполнения метода.
 */
export function validateRequestId(id) {
	if (typeof id === "string" && id.length > 0 && id.length <= 512) return id;
	if (typeof id === "number" && Number.isSafeInteger(id)) return id;
	throw new BridgeError("INVALID_REQUEST", "Требуется идентификатор запроса (строка или целое число).");
}

/** Имя метода для логов: невалидное не должно попадать в diagnostiku как есть. */
export function safeMethodName(method) {
	return METHOD_PATTERN.test(method) ? method : "invalid";
}

/**
 * Первая проверка рукопожатия: params initialize. Вынесено сюда, чтобы правило
 * «первый запрос на сокете обязан быть initialize» было в одном месте и его
 * можно было проверить тестом без сети.
 */
export function validateHandshake(params, token, protocolPattern = /^1\.\d+$/) {
	const supplied = typeof params.authToken === "string" ? Buffer.from(params.authToken) : Buffer.alloc(0);
	const expected = Buffer.from(token);
	// Длина сравнивается до timingSafeEqual: сама функция требует равных длин,
	// а падение на неравных длинах выдало бы длину токена временем ответа.
	if (supplied.length !== expected.length) return { ok: false, code: "NOT_INITIALIZED", message: "Требуется аутентифицированная инициализация." };
	if (!timingSafeEqualPublic(supplied, expected)) return { ok: false, code: "NOT_INITIALIZED", message: "Требуется аутентифицированная инициализация." };
	if (typeof params.protocolVersion !== "string" || !protocolPattern.test(params.protocolVersion) || params.runtime !== "dsh") {
		return { ok: false, code: "PROTOCOL_VERSION_MISMATCH", message: "Мост требует протокол DSH 1.x." };
	}
	const namespace = params.sessionNamespace ?? params.connectorId;
	if (typeof namespace !== "string" || !namespace || namespace.length > 512) {
		return { ok: false, code: "INVALID_PARAMS", message: "Требуется namespace рантайма." };
	}
	return { ok: true, namespace };
}

/**
 * Обёртка над timingSafeEqual: сравнение токена обязано быть постоянным по
 * времени, иначе локальный процесс может по времени ответа подобрать префикс.
 */
function timingSafeEqualPublic(a, b) {
	return timingSafeEqual(a, b);
}
