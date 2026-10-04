/**
 * Маршрутизатор методов моста.
 *
 * Два правила, из-за которых код выглядит именно так:
 *  1. Ошибка одного метода не рвёт соединение — клиент получает структурированную
 *     ошибку и продолжает работать (иначе телефон терял бы весь канал из-за
 *     одной нечитаемой сессии).
 *  2. Операции, которые телефон показывает как «действие пользователя»
 *     (отправка, смена модели), при неудаче возвращают НЕ исключение, а
 *     результат `{ok:false, code, message, result}`: узел dsh-phone транслирует
 *     его в текст ошибки на экране, а JSON-RPC-ошибка превратилась бы в
 *     «мост сломан».
 */
import { randomUUID } from "node:crypto";
import { BridgeError, publicError, record } from "./errors.js";
import { jsonBytes, nativeSessionId, parseSelections, sessionId as platformSessionIdOf } from "./identity.js";
import { contentItems, foldTitle, projectHistory } from "./project.js";
import { SyncFeed } from "./sync.js";

/** Время жизни курсора: страница — это временный захват, а не второе хранилище. */
const PAGE_LIFETIME_MS = 120_000;
/** Предел одной страницы снапшота (совпадает с потолком кадра синк-фида). */
const SNAPSHOT_PAGE_ITEMS = 1000;
const SNAPSHOT_PAGE_BYTES = 7340032;

function integer(value, fallback, max) {
	if (value === void 0 || value === null) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new BridgeError("INVALID_PARAMS", `Лимит должен быть целым числом от 1 до ${max}.`);
	}
	return value;
}

export class RuntimeRouter {
	native;
	namespace;
	notify;
	failed;
	logger;
	feed;
	inventory;
	history;

	constructor({ native, namespace, notify, failed, logger }) {
		this.native = native;
		this.namespace = namespace;
		this.notify = notify;
		this.failed = failed;
		this.logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
	}

	close() {
		this.feed?.close();
		this.feed = void 0;
		this.inventory = void 0;
		this.history = void 0;
	}

	async request(method, params, signal) {
		signal?.throwIfAborted?.();
		const p = record(params);
		switch (method) {
			case "runtime.sync.subscribe": {
				// Повторная подписка закрывает предыдущий поток: два фида на одном
				// сокете удвоили бы трафик и рассинхронизировали batchSeq.
				this.close();
				const feed = new SyncFeed(this.native, this.namespace, this.notify, (error) => {
					if (this.feed !== feed) return;
					this.feed = void 0;
					this.failed?.(error, feed.id);
				}, this.logger);
				this.feed = feed;
				setTimeout(() => {
					if (this.feed === feed) feed.start();
				}, 0).unref?.();
				return { streamId: feed.id, projectionVersion: 2 };
			}
			case "runtime.sync.ack": {
				if (!this.feed || p.streamId !== this.feed.id) throw new BridgeError("INVALID_PARAMS", "Неизвестный поток событий.");
				this.feed.ack(p.batchSeq);
				return { ok: true };
			}
			case "runtime.sync.unsubscribe":
				this.close();
				return { ok: true };
			case "runtime.sync.refresh": {
				const id = await this.resolve(p, signal, true);
				this.native.refresh(id);
				return { accepted: true };
			}
			case "session.createAndStart":
			case "session.startTurn":
				return this.startTurn(method, p, signal);
			case "session.interrupt": {
				const id = await this.resolve(p, signal);
				await this.native.interrupt(id);
				return { accepted: true, sessionId: this.platformId(id), externalSessionId: id };
			}
			case "session.updateSelections":
				return this.updateSelections(p, signal);
			case "session.list":
				return this.list(p, signal);
			case "session.getSnapshot":
				return this.snapshot(p, signal);
			case "session.getState":
				return this.state(p, signal);
			case "session.getNotices": {
				const id = await this.resolve(p, signal);
				return { notices: this.native.questions.notices(this.namespace, id) };
			}
			case "session.respondInteraction": {
				const id = await this.resolve(p, signal);
				if (!this.native.questions.available) {
					throw new BridgeError("UNSUPPORTED_OPERATION", "Поток вопросов DSH недоступен: отвечать на вопросы нельзя.");
				}
				if (typeof p.noticeId !== "string" || typeof p.actionId !== "string") {
					throw new BridgeError("INVALID_PARAMS", "Нужны noticeId и actionId.");
				}
				return this.native.questions.respond(this.namespace, id, p.noticeId, p.actionId, p.inputData);
			}
			case "session.getCapabilities": {
				const id = await this.resolve(p, signal);
				return this.native.capabilities(this.platformId(id), id);
			}
			case "catalog.listModels": {
				const catalog = await this.native.catalogs.models(true);
				const query = typeof p.query === "string" ? p.query.toLocaleLowerCase() : "";
				return {
					...catalog,
					models: catalog.models
						.filter((item) => `${item.title} ${item.metadata.providerName} ${item.metadata.model}`.toLocaleLowerCase().includes(query))
						.slice(0, integer(p.limit, 1000, 10000))
				};
			}
			case "catalog.listPermissions":
				return this.native.catalogs.permissions();
			case "catalog.listAgentPresets":
				return this.native.catalogs.agentPresets();
			case "ping":
				return { ok: true };
			case "runtime.getConfig":
				return {
					runtime: "dsh",
					revision: 2,
					values: {},
					metadata: { readOnly: this.native.readOnly, storageMode: "dsh-native" }
				};
			case "runtime.getCapabilities":
				return this.native.capabilities();
			case "workspace.list":
				return { workspaces: this.native.workspaces() };
			default:
				throw new BridgeError("METHOD_NOT_FOUND", "Рантайм DSH не поддерживает этот метод.");
		}
	}

	platformId(externalId) {
		return platformSessionIdOf(this.namespace, externalId);
	}

	/**
	 * Разрешение идентичности сессии.
	 *
	 * Клиент может прислать `sessionId` (платформенный, sess_dsh_*) и/или
	 * `externalSessionId` (нативный id DSH). Если присланы оба — они обязаны
	 * соответствовать друг другу, иначе это попытка обратиться к чужой сессии
	 * через подменный id.
	 */
	async resolve(params, signal, includeUnavailable = false) {
		const p = record(params);
		const externalId = p.externalSessionId;
		if (typeof externalId === "string" && externalId) {
			if (p.sessionId !== void 0 && p.sessionId !== this.platformId(externalId)) {
				throw new BridgeError("INVALID_PARAMS", "Сессия не принадлежит этому namespace рантайма.");
			}
			if (!includeUnavailable) await this.native.source.requireAvailable(externalId);
			return externalId;
		}
		if (typeof p.sessionId !== "string" || !p.sessionId) throw new BridgeError("INVALID_PARAMS", "Требуется идентификатор сессии.");
		await this.native.ensureKnown(p.sessionId, signal);
		let id = this.findExternalId(p.sessionId);
		if (!id) {
			// Одна повторная инвентаризация: сессия могла быть создана этим же
			// клиентом секунду назад и ещё не попасть в кэш записей.
			await this.native.source.refresh(signal);
			id = this.findExternalId(p.sessionId);
		}
		if (!id) throw new BridgeError("SESSION_NOT_FOUND", "Сессия DSH не найдена или не видна.");
		if (!includeUnavailable) await this.native.source.requireAvailable(id);
		return id;
	}

	findExternalId(sessionId) {
		const candidates = this.native.source.candidates();
		const mapped = candidates.find((id) => this.platformId(id) === sessionId);
		if (mapped) return mapped;
		// Телефон после createAndStart открывает чат по тому же «сырому» id,
		// который сам и придумал. Отказывать ему в этом значило бы сломать
		// сценарий создания сессии, поэтому принимаем и нативный id напрямую.
		return candidates.includes(sessionId) ? sessionId : void 0;
	}

	offset(cursor, page) {
		if (typeof cursor !== "string" || !page || page.expires < Date.now()) {
			throw new BridgeError("INVALID_PARAMS", "Курсор чтения истёк. Начните чтение заново.");
		}
		const [id, offset] = cursor.split(":");
		const index = Number(offset);
		if (id !== page.id || !/^\d+$/.test(offset ?? "") || !Number.isSafeInteger(index) || index < 1 || index >= page.values.length) {
			throw new BridgeError("INVALID_PARAMS", "Курсор чтения недействителен.");
		}
		return index;
	}

	/** ---------- session.list ---------- */

	async list(params, signal) {
		const limit = integer(params.limit, 100, 1000);
		let offset = 0;
		if (params.cursor != null) {
			offset = this.offset(params.cursor, this.inventory);
		} else {
			this.inventory = {
				id: randomUUID(),
				values: await this.listSessions(signal),
				expires: Date.now() + PAGE_LIFETIME_MS
			};
		}
		const page = this.inventory;
		const slice = page.values.slice(offset, offset + limit);
		const records = [];
		for (const entry of slice) {
			const id = record(entry.header).id;
			if (!id) continue;
			// Видимость проверяем полностью, как в сайдбаре DSH: результат
			// кэшируется по ревизии лога, поэтому повторные страницы и следующие
			// вызовы списка логов уже не читают. Список и синк-инвентарь обязаны
			// сходиться, иначе телефон показывает сессию, которой нет в ленте.
			try {
				if (await this.native.visible(id)) records.push(entry);
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				// Одна проблемная сессия не должна ронять весь список.
			}
		}
		const titles = await this.readTitles(records.map((item) => record(item.header).id), signal);
		const sessions = records.map((item) => {
			const header = record(item.header);
			const title = titles.get(header.id);
			return {
				runtime: "dsh",
				sessionId: this.platformId(header.id),
				externalSessionId: header.id,
				title: title?.value ?? null,
				cwd: header.cwd ?? null,
				orderingTime: isoTime(header.createdAt),
				metadata: {
					live: Boolean(item.live),
					persisted: Boolean(item.persisted),
					parentSession: header.parentSession ?? null,
					origin: header.origin ?? null,
					readOnly: this.native.readOnly,
					...(title?.failed ? { titleReadFailed: true } : {}),
					sync: { requires_timeline_sync: true, changed: true }
				}
			};
		});
		const next = offset + slice.length;
		return { sessions, nextCursor: next < page.values.length ? `${page.id}:${next}` : null };
	}

	async listSessions(signal) {
		const query = this.native.ctx.sessionQuery;
		if (typeof query?.listSessions !== "function") {
			throw new BridgeError("UNSUPPORTED_OPERATION", "Эта сборка DSH не предоставляет список сессий.");
		}
		signal?.throwIfAborted?.();
		return await query.listSessions(signal) ?? [];
	}

	/**
	 * Заголовки. Официальный `readTitleSnapshots` — единственный честный
	 * источник; если его нет, заголовок остаётся null с явной пометкой, а не
	 * придумывается из текста первого сообщения.
	 */
	async readTitles(ids, signal) {
		const result = new Map();
		const unique = [...new Set(ids.filter(Boolean))];
		if (!unique.length) return result;
		const query = this.native.ctx.sessionQuery;
		if (typeof query?.readTitleSnapshots !== "function") {
			for (const id of unique) result.set(id, { value: null, failed: true });
			return result;
		}
		let titles;
		try {
			titles = await query.readTitleSnapshots(unique, signal) ?? [];
		} catch (error) {
			this.logger.warn("чтение заголовков не удалось", { error: String(error) });
			for (const id of unique) result.set(id, { value: null, failed: true });
			return result;
		}
		for (const id of unique) result.set(id, { value: null, failed: true });
		for (const entry of titles) {
			const item = record(entry);
			if (!item.sessionId) continue;
			if (item.status === "fulfilled") {
				const value = record(item.value);
				const title = record(value.title).title;
				result.set(item.sessionId, { value: typeof title === "string" && title ? title : foldTitle(value.events ?? []) ?? null, failed: false });
			}
		}
		return result;
	}

	/** ---------- session.getSnapshot ---------- */

	async snapshot(params, signal) {
		let offset = 0;
		if (params.cursor != null) {
			if (this.history && !await this.native.visible(this.history.externalId)) {
				this.history = void 0;
				throw new BridgeError("SESSION_NOT_FOUND", "Сессия больше не видна в DSH.");
			}
			offset = this.offset(params.cursor, this.history);
			// Курсор привязан к сессии и захвату. Проверяем только те поля, которые
			// клиент реально прислал: требовать sessionId вместе с cursor означало бы
			// сломать пагинацию у клиента, который шлёт externalSessionId.
			if ((params.sessionId != null && params.sessionId !== this.history.platformId)
				|| (params.externalSessionId != null && params.externalSessionId !== this.history.externalId)) {
				throw new BridgeError("INVALID_PARAMS", "Курсор принадлежит другой сессии.");
			}
		} else {
			const id = await this.resolve(params, signal);
			const log = await this.native.readLog(id);
			signal?.throwIfAborted?.();
			const platformId = this.platformId(id);
			const all = contentItems(await projectHistory(log, platformId, signal));
			const limit = integer(params.limit, Math.max(all.length, 1), 1_000_000);
			// limit означает «последние N»: телефон показывает хвост переписки.
			const values = all.slice(-limit);
			const seq = Number(log.events.at(-1)?.seq ?? -1);
			this.history = {
				id: randomUUID(),
				values,
				expires: Date.now() + PAGE_LIFETIME_MS,
				externalId: id,
				platformId,
				watermark: { seq, revision: `projection-2:${seq}` },
				truncated: values.length < all.length
			};
		}
		const page = this.history;
		const items = [];
		let bytes = 0;
		for (const item of page.values.slice(offset, offset + SNAPSHOT_PAGE_ITEMS)) {
			const size = sizeOf(item);
			if (size > SNAPSHOT_PAGE_BYTES) throw new BridgeError("FRAME_TOO_LARGE", "Один элемент истории DSH превышает предел транспорта.");
			if (bytes + size > SNAPSHOT_PAGE_BYTES) break;
			bytes += size;
			items.push(item);
		}
		const next = offset + items.length;
		const nextCursor = next < page.values.length ? `${page.id}:${next}` : null;
		return {
			sessionId: page.platformId,
			externalSessionId: page.externalId,
			runtime: "dsh",
			items,
			complete: offset === 0 && nextCursor === null && !page.truncated,
			snapshotComplete: !page.truncated,
			nextCursor,
			watermark: page.watermark,
			metadata: { projectionVersion: 2, totalItems: page.values.length, readOnly: this.native.readOnly }
		};
	}

	/** ---------- session.getState ---------- */

	async state(params, signal) {
		const id = await this.resolve(params, signal, true);
		await this.native.ensureKnown(id, signal);
		const platformId = this.platformId(id);
		const sourceState = await this.native.source.state(id);
		if (sourceState.availability !== "available") {
			// Архив/пропажа/нечитаемость: статус blocked, агент не поднимается.
			return {
				runtime: "dsh",
				sessionId: platformId,
				externalSessionId: id,
				status: "blocked",
				selections: {},
				sourceState,
				metadata: { readOnly: true, attached: false }
			};
		}
		let facts;
		try {
			facts = await this.native.stateFacts(id);
		} catch (error) {
			// Нечитаемая конфигурация не должна блокировать статус: телефон
			// показывает состояние агента и просто не знает выбранную модель.
			if (error instanceof Error && error.name === "AbortError") throw error;
			this.logger.warn("чтение конфигурации сессии не удалось", { sessionId: id, error: String(error) });
			facts = { configuration: { selections: {}, metadata: {} }, lastTurnEndKind: void 0 };
		}
		signal?.throwIfAborted?.();
		const liveStatus = this.native.status(id);
		const waiting = this.native.questions.waiting(id);
		return {
			runtime: "dsh",
			sessionId: platformId,
			externalSessionId: id,
			sourceState,
			status: waiting ? "waiting_approval" : liveStatus ?? (facts.lastTurnEndKind === "error" ? "error" : "idle"),
			selections: facts.configuration.selections,
			metadata: {
				...facts.configuration.metadata,
				readOnly: this.native.readOnly,
				attached: liveStatus !== void 0
			}
		};
	}

	/** ---------- отправка сообщения ---------- */

	async startTurn(method, params, signal) {
		const create = method === "session.createAndStart";
		if (typeof params.content !== "string" || !params.content.trim()) {
			throw new BridgeError("INVALID_PARAMS", "Сообщение не может быть пустым.");
		}
		if (typeof params.clientMessageId !== "string" || !params.clientMessageId) {
			throw new BridgeError("INVALID_PARAMS", "Требуется clientMessageId.");
		}
		if (Array.isArray(params.attachments) && params.attachments.length) {
			// Вложения честно не поддерживаем: молча отправить текст без картинки
			// значит обмануть пользователя.
			return this.turnFailure("UNSUPPORTED_OPERATION", "Вложения не поддерживаются этим мостом.", params, create ? params.sessionId : void 0);
		}
		let id;
		try {
			if (create) {
				if (typeof params.sessionId !== "string" || !params.sessionId) throw new BridgeError("INVALID_PARAMS", "Для новой сессии нужен sessionId.");
				id = nativeSessionId(this.namespace, params.sessionId);
			} else {
				id = await this.resolve(params, signal, true);
			}
			await this.native.send(
				id,
				params.content,
				params.clientMessageId,
				typeof params.cwd === "string" ? params.cwd : void 0,
				create,
				parseSelections(params.selections),
				typeof params.agentPreset === "string" ? params.agentPreset : void 0,
				signal
			);
		} catch (error) {
			const failure = publicError(error);
			return this.turnFailure(failure.code, failure.message, params, id, create);
		}
		return { accepted: true, sessionId: this.platformId(id), externalSessionId: id };
	}

	turnFailure(code, message, params, externalId, create = false) {
		const mapped = code === "SESSION_ARCHIVED" ? "session_archived" : code === "SESSION_NOT_FOUND" ? "session_unavailable" : code;
		return {
			ok: false,
			code: mapped,
			message,
			result: {
				sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
				externalSessionId: externalId ?? null,
				created: create,
				messageAccepted: false,
				sourceState: { availability: "unavailable", reason: mapped, observedAt: new Date().toISOString() }
			}
		};
	}

	/** ---------- смена модели/прав ---------- */

	async updateSelections(params, signal) {
		const id = await this.resolve(params, signal);
		const selections = parseSelections(params.selections);
		if (!Object.keys(selections).length) throw new BridgeError("INVALID_PARAMS", "Укажите, что именно изменить.");
		try {
			await this.native.updateSelections(id, selections, signal);
		} catch (error) {
			const failure = publicError(error);
			return {
				ok: false,
				code: failure.code,
				message: failure.message,
				result: { state: await this.state(params, new AbortController().signal).catch(() => null) }
			};
		}
		return { ok: true, result: { state: await this.state(params, signal) } };
	}
}

function sizeOf(item) {
	return jsonBytes(item) + 1;
}

function isoTime(value) {
	const date = value instanceof Date ? value : new Date(value ?? NaN);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
