/**
 * Ошибки моста. Числовые коды и строковые имена обязаны совпадать с мостом
 * Agents Anywhere: Rust-клиент (bridge.rs) и Python-коннектор AA сравнивают
 * именно `error.data.code`, поэтому любое расхождение ломает уже собранный узел.
 */

/** Числовая половина протокола: то, что уходит в `error.code` кадра JSON-RPC. */
export const codes = {
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
};

/**
 * Ошибка моста. `code` — строковое имя (UNSUPPORTED_OPERATION и т.п.), а не
 * число: число берётся из таблицы `codes` только при сериализации, чтобы в коде
 * нельзя было случайно отправить несуществующий номер.
 */
export class BridgeError extends Error {
	constructor(code, message, retryable = false) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
		this.retryable = retryable;
	}

	/** Форма `error` кадра ответа: число + человекочитаемое сообщение + данные. */
	toJSON() {
		return {
			code: codes[this.code] ?? codes.INTERNAL_ERROR,
			message: this.message,
			data: { code: this.code, retryable: this.retryable }
		};
	}
}

/**
 * Любое значение из чужого кода (событие DSH, params кадра, ошибка сервиса)
 * может быть null/примитивом. Приводим к объекту один раз и дальше не пишем
 * `?.` в каждом обращении: падение на разборе ответа DSH дороже, чем пустой
 * объект.
 */
export function record(value) {
	return value !== null && typeof value === "object" ? value : {};
}

/**
 * Приводит нативную ошибку DSH к публичной. Правило: наружу не уходят ни
 * внутренние тексты DSH, ни стеки — только стабильный код и сообщение, которое
 * можно показать человеку на телефоне.
 */
export function publicError(error) {
	if (error instanceof BridgeError) return error;
	const native = record(error);
	// Удалённый ответ DSH (модель/вложения/пресет): конкретные коды важны,
	// потому что телефон по-разному на них реагирует (перевыбор модели и т.п.).
	if (native.isDSHRemoteError === true) {
		const code = native.code;
		if (code === "session/attachment-invalid") {
			const reason = record(native.details).reason;
			return new BridgeError(
				"INVALID_PARAMS",
				reason === "MODEL_DOES_NOT_SUPPORT_IMAGES"
					? "Выбранная модель DSH не поддерживает изображения."
					: "DSH отклонил вложение: проверьте формат, содержимое и размер."
			);
		}
		if (code === "session/model-unavailable") return new BridgeError("INVALID_PARAMS", "DSH не смог применить выбранную модель. Обновите список моделей.");
		if (typeof code === "string" && code.startsWith("agent-preset/")) return new BridgeError("INVALID_PARAMS", "DSH не смог загрузить выбранный режим агента.");
		return new BridgeError("DSH_SERVICE_UNAVAILABLE", "DSH не смог завершить операцию. Обновите состояние сессии и повторите.", true);
	}
	if (native.code === "SESSION_QUERY_SESSION_NOT_FOUND") return new BridgeError("SESSION_NOT_FOUND", "Сессия DSH больше не существует.");
	if (native.code === "SESSION_QUERY_PERSISTENCE_FAILED") return new BridgeError("PERSISTENCE_ERROR", "DSH не смог безопасно прочитать эту сессию.", true);
	// Отмена и таймаут — не сбой, а ожидаемый исход: помечаем retryable.
	if (error instanceof Error && error.name === "AbortError") return new BridgeError("REQUEST_TIMEOUT", "Запрос отменён или истекло время ожидания.", true);
	return new BridgeError("INTERNAL_ERROR", "DSH не смог выполнить этот запрос.", true);
}

/** Полный кадр ошибки для ответа с известным или неизвестным id. */
export function errorFrame(id, error) {
	return { jsonrpc: "2.0", id: id ?? null, error: publicError(error).toJSON() };
}
