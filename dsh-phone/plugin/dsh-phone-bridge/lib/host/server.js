/**
 * TCP-сервер моста: loopback, случайный порт, случайный токен на каждый старт.
 *
 * Безопасность здесь не «на всякий случай»: в этом же процессе живут ключи
 * пользователя и его файлы, поэтому
 *  - слушаем только 127.0.0.1 (наружу мост не виден);
 *  - токен сравниваем постоянным по времени и только после проверки длины;
 *  - первый запрос на сокете обязан быть `initialize` — всё остальное рвётся;
 *  - сокет без рукопожатия живёт не дольше 10 с, соединений не больше 16,
 *    запросов в полёте не больше 16 на соединение.
 */
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { BridgeError, errorFrame, publicError, record } from "./errors.js";
import {
	FrameDecoder,
	MAX_WRITE_BUFFER,
	encodeFrame,
	isCancelNotification,
	parseFrame,
	safeMethodName,
	validateHandshake,
	validateRequest,
	validateRequestId
} from "./framing.js";
import { RuntimeRouter } from "./router.js";
import { buildEndpoint, publishEndpoint, releaseEndpoint } from "./endpoint.js";

export const MAX_SOCKETS = 16;
export const MAX_IN_FLIGHT = 16;
export const AUTH_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const PROTOCOL_VERSION = "1.0";

export class RuntimeServer {
	endpointPath;
	native;
	logger;
	version;
	requestTimeoutMs;
	server;
	endpoint;
	sockets = new Set();
	closed = false;
	startTask;
	closeTask;

	constructor({ endpointPath, native, logger, version, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
		this.endpointPath = endpointPath;
		this.native = native;
		this.logger = logger;
		this.version = version;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	start() {
		// Параллельные вызовы start (перезапуск плагина во время загрузки) должны
		// сойтись в одну операцию: два слушателя на одном DSH_HOME — это два
		// endpoint.json и потерянный телефон.
		this.startTask ??= this.open().catch((error) => {
			if (!this.closed && this.startTask) this.startTask = void 0;
			throw error;
		});
		return this.startTask;
	}

	async open() {
		if (this.closed) throw new Error("Мост dsh-phone уже остановлен");
		const token = randomBytes(32).toString("base64url");
		this.server = createServer((socket) => this.accept(socket, token));
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			// Порт 0: ОС сама выбирает свободный, конфликтов с другими службами нет.
			this.server.listen(0, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		this.server.on("error", (error) => {
			this.logger.error("ошибка сервера моста", { error: String(error) });
			for (const socket of this.sockets) socket.destroy();
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Мост DSH не получил TCP-порт");
		const endpoint = buildEndpoint({ port: address.port, token });
		try {
			await publishEndpoint(this.endpointPath, endpoint);
		} catch (error) {
			// Не смогли опубликовать адрес — слушать бессмысленно: телефон не
			// узнает, куда подключаться. Откатываемся полностью.
			for (const socket of this.sockets) socket.destroy();
			await new Promise((resolve) => this.server.close(() => resolve()));
			this.server = void 0;
			throw error;
		}
		this.endpoint = endpoint;
		this.logger.info("мост dsh-phone слушает", { host: endpoint.host, port: endpoint.port, protocolVersion: PROTOCOL_VERSION, projectionVersion: 2 });
		return endpoint;
	}

	close() {
		this.closeTask ??= this.dispose();
		return this.closeTask;
	}

	async dispose() {
		this.closed = true;
		await this.startTask?.catch(() => void 0);
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (this.server?.listening) await new Promise((resolve) => this.server.close(() => resolve()));
		this.server = void 0;
		const endpoint = this.endpoint;
		this.endpoint = void 0;
		if (endpoint) {
			try {
				await releaseEndpoint(this.endpointPath, endpoint);
			} catch (error) {
				this.logger.warn("не удалось снять публикацию endpoint.json", { error: String(error) });
			}
		}
		this.logger.info("мост dsh-phone остановлен");
	}

	accept(socket, token) {
		if (this.closed || this.sockets.size >= MAX_SOCKETS) {
			// Лишние соединения рвём сразу: держать их открытыми значит давать
			// неаутентифицированному процессу повод висеть на нашем порту.
			socket.destroy();
			return;
		}
		const connectionId = randomUUID();
		this.sockets.add(socket);
		socket.setNoDelay?.(true);
		socket.on("error", (error) => this.logger.debug("ошибка сокета моста", { connectionId, error: String(error) }));

		const decoder = new FrameDecoder();
		const inFlight = new Map();
		let router;

		const authTimer = setTimeout(() => {
			this.logger.debug("сокет не аутентифицирован вовремя", { connectionId });
			socket.destroy();
		}, AUTH_TIMEOUT_MS);
		authTimer.unref?.();

		const send = (value) => {
			if (socket.destroyed) return;
			// Клиент перестал читать (телефон уснул): не копим мегабайты в памяти
			// процесса DSH, а рвём соединение — клиент переподключится сам.
			if (socket.writableLength > MAX_WRITE_BUFFER) {
				this.logger.warn("буфер записи сокета переполнен, соединение закрыто", { connectionId });
				socket.destroy();
				return;
			}
			socket.write(encodeFrame(value));
		};
		const fail = (id, error) => {
			try {
				send(errorFrame(id, error));
			} catch (sendError) {
				this.logger.warn("не удалось отправить ошибку моста", { connectionId, error: String(sendError) });
			}
		};

		const dispatch = async (frame) => {
			let id;
			let method = "invalid";
			const startedAt = Date.now();
			try {
				const request = validateRequest(parseFrame(frame));
				method = safeMethodName(request.method);
				if (isCancelNotification(request)) {
					// Отмена — уведомление: она обязана проходить до проверки id,
					// иначе длинный запрос нельзя было бы прервать.
					const target = request.params.id;
					if (router && (typeof target === "string" || typeof target === "number")) inFlight.get(target)?.abort();
					return;
				}
				id = validateRequestId(request.id);
				if (inFlight.has(id)) throw new BridgeError("INVALID_REQUEST", "Повторный идентификатор запроса.");
				if (inFlight.size >= MAX_IN_FLIGHT) throw new BridgeError("INVALID_REQUEST", "Слишком много одновременных запросов.");

				if (!router) {
					if (request.method !== "initialize") throw new BridgeError("NOT_INITIALIZED", "Требуется аутентифицированная инициализация.");
					const handshake = validateHandshake(request.params, token);
					if (!handshake.ok) throw new BridgeError(handshake.code, handshake.message);
					router = new RuntimeRouter({
						native: this.native,
						namespace: handshake.namespace,
						logger: this.logger,
						notify: (batch) => send({ jsonrpc: "2.0", method: "runtime.sync.batch", params: batch }),
						failed: (error, streamId) => {
							const failure = publicError(error).toJSON();
							this.logger.error("синк-фид закрылся с ошибкой", { connectionId, streamId, error: String(error) });
							send({
								jsonrpc: "2.0",
								method: "runtime.error",
								params: { ...failure, data: { ...failure.data, scope: "sync", streamId } }
							});
						}
					});
					clearTimeout(authTimer);
					this.logger.info("соединение моста аутентифицировано", { connectionId, namespace: handshake.namespace, client: record(request.params.clientInfo).name ?? null });
					send({ jsonrpc: "2.0", id, result: this.initializeResult() });
					return;
				}

				const abort = new AbortController();
				inFlight.set(id, abort);
				let cancel = () => {};
				const cancelled = new Promise((_resolve, reject) => {
					cancel = () => reject(abort.signal.reason ?? new Error("cancelled"));
					abort.signal.addEventListener("abort", cancel, { once: true });
				});
				// Таймаут на запрос обязателен: без него зависший сервис DSH
				// навсегда занял бы слот in-flight и соединение встало бы.
				const timeout = setTimeout(() => abort.abort(new BridgeError("REQUEST_TIMEOUT", "Превышено время ожидания ответа DSH.", true)), this.requestTimeoutMs);
				timeout.unref?.();
				try {
					const result = await Promise.race([router.request(request.method, request.params, abort.signal), cancelled]);
					abort.signal.throwIfAborted();
					send({ jsonrpc: "2.0", id, result });
					this.logger.debug("запрос моста выполнен", { connectionId, method, elapsedMs: Date.now() - startedAt });
				} finally {
					clearTimeout(timeout);
					abort.signal.removeEventListener("abort", cancel);
					inFlight.delete(id);
				}
			} catch (error) {
				const failure = publicError(error);
				this.logger.warn("запрос моста не выполнен", { connectionId, method, code: failure.code, elapsedMs: Date.now() - startedAt });
				fail(id, failure);
				// Ошибка до рукопожатия означает, что сокет не аутентифицирован:
				// продолжать разговор с ним нельзя.
				if (!router) socket.end();
			}
		};

		socket.on("data", (chunk) => {
			const { frames, oversized } = decoder.push(chunk);
			for (let i = 0; i < oversized; i++) fail(null, new BridgeError("FRAME_TOO_LARGE", "Запрос превышает предел размера кадра моста."));
			for (const frame of frames) dispatch(frame);
		});

		socket.on("close", () => {
			this.logger.info("соединение моста закрыто", { connectionId, initialized: Boolean(router), pendingRequests: inFlight.size });
			router?.close();
			clearTimeout(authTimer);
			for (const abort of inFlight.values()) abort.abort();
			inFlight.clear();
			this.sockets.delete(socket);
		});
	}

	/** Ответ на `initialize`: идентичность, хранилище и честный набор возможностей. */
	initializeResult() {
		return {
			identity: {
				runtime: "dsh",
				runtimeVersion: this.version,
				bridgeVersion: this.version,
				protocolVersion: PROTOCOL_VERSION,
				displayName: "DSH Phone Bridge"
			},
			storage: { mode: "dsh-native", sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
			features: {
				// Вложения не поддерживаем: у телефона не должно быть соблазна
				// послать картинку и получить текст без неё.
				attachments: false,
				sessionDiscovery: true,
				timelineSuffixRead: false,
				approval: false,
				userQuestions: Boolean(this.native.questions?.available),
				readOnly: Boolean(this.native.readOnly),
				snapshotPagination: true,
				syncMode: "events",
				projectionVersion: 2
			}
		};
	}
}
