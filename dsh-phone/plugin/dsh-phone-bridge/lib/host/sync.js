/**
 * Синк-фид: упорядоченный поток операций к одному клиенту.
 *
 * Ключевое отличие от «просто пуша» — каждый батч обязан быть подтверждён
 * (`runtime.sync.ack`) до отправки следующего. Без этого медленный телефон
 * (мобильная сеть, сон приложения) превращался бы в растущую очередь в памяти
 * процесса DSH, а потерянные батчи клиент не смог бы отличить от тишины.
 *
 * Источники обновлений — только нативные события Cordis. Никакого опроса
 * файловой системы: DSH сам сообщает о создании сессии, событии лога, смене
 * статуса агента и архивации.
 */
import { randomUUID } from "node:crypto";
import { BridgeError, record } from "./errors.js";
import { jsonBytes, sessionId as platformSessionIdOf } from "./identity.js";
import { contentItems, createProjection, foldTitle, replayHistory } from "./project.js";
import { snapshotEvents as snapshotEventsOf } from "./native.js";

/** Потолок очереди событий: при переполнении клиент обязан переподписаться. */
const MAX_BUFFER = 10_000;
const MAX_BUFFER_BYTES = 6291456;
/** Один батч не должен превышать полезный размер кадра (8 MiB минус запас). */
const MAX_BATCH_BYTES = 6291456;
const MAX_TRANSMIT_BYTES = 7340032;
/** Пауза между батчами: не забиваем сокет и даём клиенту дышать. */
const PACING_MS = 34;
/** Страница снапшота в фиде: 250 элементов и 6 MiB, как в протоколе AA. */
const SNAPSHOT_PAGE_ITEMS = 250;

class SyncTransportError extends Error {}

function sleep(signal, ms) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new Error("aborted"));
		}
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

export class SyncFeed {
	native;
	namespace;
	notify;
	failed;
	logger;
	ackTimeoutMs;
	id = randomUUID();
	batchSeq = 0;
	queue = [];
	queuedBytes = 0;
	projections = new Map();
	published = new Map();
	failedSessions = new Map();
	sourceAvailability = new Map();
	capture;
	waitAck;
	wake;
	closed = false;
	unwatch;
	abort = new AbortController();
	lastSentAt = -Infinity;
	bufferedOperations;
	bufferedBytes = 0;

	constructor(native, namespace, notify, failed, logger, ackTimeoutMs = 60_000) {
		this.native = native;
		this.namespace = namespace;
		this.notify = notify;
		this.failed = failed;
		this.logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
		this.ackTimeoutMs = ackTimeoutMs;
		this.unwatch = native.watch((change) => this.enqueue(change));
	}

	/**
	 * Приём нативного изменения. Очередь ограничена и по числу, и по байтам:
	 * бесконечный буфер означал бы, что медленный клиент может убить процесс DSH.
	 */
	enqueue(change) {
		if (this.closed) return;
		let value = change;
		try {
			this.queuedBytes += jsonBytes(value);
		} catch (error) {
			// Событие с циклической ссылкой/функцией нельзя сериализовать:
			// заменяем его безопасным «перечитать сессию», а не роняем фид.
			this.logger.warn("событие синк-фида не сериализуется", { error: String(error) });
			if (!("id" in record(value))) return;
			value = { type: "refresh", id: record(value).id };
			this.queuedBytes += 64;
		}
		if (this.queue.length >= MAX_BUFFER || this.queuedBytes > MAX_BUFFER_BYTES) {
			this.fail(new Error("Буфер событий DSH переполнен; переподпишитесь для нового снапшота."));
			return;
		}
		this.queue.push(value);
		this.wake?.();
		this.wake = void 0;
	}

	start() {
		this.logger.info("синк-фид запущен", { streamId: this.id });
		this.run().catch((error) => {
			if (!this.closed) this.fail(error);
		});
	}

	fail(error) {
		this.logger.error("синк-фид остановлен с ошибкой", { streamId: this.id, batchSeq: this.batchSeq, error: String(error) });
		this.close();
		this.failed(error);
	}

	/**
	 * Подтверждение батча. Принимается только seq из уже отправленного диапазона:
	 * «ack из будущего» означал бы, что клиент потерял часть потока.
	 */
	ack(seq) {
		if (!Number.isSafeInteger(seq) || seq < 1 || seq > this.batchSeq) throw new BridgeError("INVALID_PARAMS", "Недопустимое подтверждение потока событий.");
		if (this.waitAck?.seq === seq) {
			const pending = this.waitAck;
			this.waitAck = void 0;
			pending.resolve();
		}
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort();
		this.unwatch?.();
		this.waitAck?.reject(new Error("Синк-фид DSH закрыт"));
		this.waitAck = void 0;
		this.wake?.();
		this.wake = void 0;
		this.queue = [];
		this.queuedBytes = 0;
		this.projections.clear();
		this.published.clear();
		this.failedSessions.clear();
		this.sourceAvailability.clear();
		this.bufferedOperations = void 0;
		this.bufferedBytes = 0;
		this.capture = void 0;
	}

	/** ---------- транспорт ---------- */

	async send(operations) {
		this.abort.signal.throwIfAborted();
		if (this.bufferedOperations) {
			const bytes = jsonBytes(operations);
			if (this.bufferedOperations.length && this.bufferedBytes + bytes > MAX_BATCH_BYTES) await this.flushOperations();
			this.abort.signal.throwIfAborted();
			for (const operation of operations) {
				const previous = this.bufferedOperations.at(-1);
				// Соседние блоки уведомлений склеиваем: один батч на всплеск
				// событий вместо десятка мелких кадров.
				if (previous?.kind === "notifications" && operation.kind === "notifications") previous.notifications.push(...operation.notifications);
				else this.bufferedOperations.push(operation);
			}
			this.bufferedBytes += bytes;
			return;
		}
		await this.transmit(operations);
	}

	async flushOperations() {
		const operations = this.bufferedOperations?.splice(0) ?? [];
		this.bufferedBytes = 0;
		if (operations.length) await this.transmit(operations);
	}

	async transmit(operations) {
		while (Date.now() - this.lastSentAt < PACING_MS) {
			await sleep(this.abort.signal, Math.ceil(PACING_MS - (Date.now() - this.lastSentAt)));
		}
		this.abort.signal.throwIfAborted();
		const batch = { streamId: this.id, batchSeq: ++this.batchSeq, projectionVersion: 2, operations };
		if (jsonBytes(batch) > MAX_TRANSMIT_BYTES) throw new SyncTransportError("Батч синк-фида превышает размер кадра");
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waitAck = void 0;
				reject(new SyncTransportError("Клиент не подтвердил батч событий вовремя"));
			}, this.ackTimeoutMs);
			timer.unref?.();
			this.waitAck = {
				seq: batch.batchSeq,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			};
			this.lastSentAt = Date.now();
			try {
				this.notify(batch);
			} catch (error) {
				clearTimeout(timer);
				this.waitAck = void 0;
				reject(new SyncTransportError("Не удалось доставить батч событий", { cause: error }));
			}
		});
	}

	async notification(method, params) {
		await this.send([{ kind: "notifications", notifications: [{ method, params }] }]);
	}

	/**
	 * Страницы элементов: либо внутрь снапшота (kind = snapshot.items), либо как
	 * отдельные timeline.itemUpsert. Размер и число элементов ограничены, чтобы
	 * ни один кадр не упёрся в потолок транспорта.
	 */
	async items(kind, id, items, snapshotId) {
		let page = [];
		let bytes = 0;
		const sendPage = async () => {
			if (snapshotId) {
				await this.send([{ kind, sessionId: this.platformId(id), items: page, snapshotId }]);
			} else {
				await this.send([{
					kind: "notifications",
					notifications: page.map((item) => ({
						method: "timeline.itemUpsert",
						params: { sessionId: item.sessionId, externalSessionId: id, item }
					}))
				}]);
			}
		};
		for (const item of contentItems(items)) {
			const size = jsonBytes(item);
			if (size > MAX_BATCH_BYTES) throw new SyncTransportError("Элемент таймлайна DSH превышает предел транспорта");
			if (page.length && (bytes + size > MAX_BATCH_BYTES || page.length >= SNAPSHOT_PAGE_ITEMS)) {
				if (!await this.visible(id)) return;
				await sendPage();
				page = [];
				bytes = 0;
			}
			page.push(item);
			bytes += size;
		}
		if (page.length && await this.visible(id)) await sendPage();
	}

	platformId(id) {
		return platformSessionIdOf(this.namespace, id);
	}

	async visible(id) {
		return this.native.visible(id);
	}

	/** ---------- снапшот сессии ---------- */

	async baseline(id) {
		await this.sessionOperation(id, "snapshot", () => this.publishBaseline(id));
	}

	/**
	 * Полный снимок истории одной сессии: begin -> items... -> commit.
	 * Если сессия перестала быть видимой или чтение упало, отправляем abort —
	 * клиент обязан откатить частичный снапшот, а не показать половину истории.
	 */
	async publishBaseline(id) {
		if (!await this.native.visible(id)) {
			await this.unavailable(id);
			return;
		}
		let log;
		try {
			log = await this.native.readLog(id);
		} catch (error) {
			if (this.closed || (error instanceof Error && error.name === "AbortError")) throw error;
			await this.unavailable(id);
			return;
		}
		const platformId = this.platformId(id);
		const projection = createProjection(id, platformId);
		await replayHistory(projection, log, this.abort.signal);
		if (!await this.native.visible(id)) {
			await this.unavailable(id);
			return;
		}
		const snapshotId = randomUUID();
		this.capture = { id, snapshotId };
		await this.send([{
			kind: "snapshot.begin",
			sessionId: platformId,
			snapshotId,
			meta: {
				externalSessionId: id,
				title: foldTitle(log.events),
				sourceState: await this.sourceStateOf(id),
				cwd: record(log.session).cwd ?? null,
				lastActivityAt: isoTime(log.events.at(-1)?.time ?? record(log.session).createdAt)
			},
			throughSeq: projection.throughSeq
		}]);
		const snapshotItems = contentItems(projection.snapshot());
		await this.items("snapshot.items", id, snapshotItems, snapshotId);
		if (!await this.native.visible(id)) {
			await this.send([{ kind: "snapshot.abort", sessionId: platformId, snapshotId }]);
			this.capture = void 0;
			return;
		}
		await this.send([{ kind: "snapshot.commit", sessionId: platformId, snapshotId, totalItems: snapshotItems.length, throughSeq: projection.throughSeq }]);
		this.capture = void 0;
		this.failedSessions.delete(id);
		projection.drain();
		this.projections.set(id, projection);
		this.published.set(id, platformId);
		this.sourceAvailability.set(id, "available");
		await this.state(id, log);
		this.logger.debug("снапшот сессии опубликован", { streamId: this.id, sessionId: id, items: snapshotItems.length });
	}

	/**
	 * Дешёвое состояние источника: без чтения логов. Полная проверка
	 * доступности делается в RPC (session.getState), а фиду достаточно знать,
	 * архивирована сессия или жива.
	 */
	async sourceStateOf(id) {
		const observedAt = new Date().toISOString();
		if (this.native.source.archived.has(id)) return { availability: "archived", reason: "archived_in_dsh", observedAt };
		if (!this.native.source.records.has(id) && !this.native.ctx.sessions?.get(id)) return { availability: "missing", reason: "not_found_in_dsh", observedAt };
		return this.failedSessions.get(id) ?? { availability: "available", reason: null, observedAt };
	}

	async unavailable(id) {
		const source = await this.sourceStateOf(id);
		if (this.sourceAvailability.has(id) && this.sourceAvailability.get(id) !== source.availability) {
			// Меняем статус источника через state.updated: отдельного метода в
			// нашем наборе уведомлений нет, а клиенту важно знать «сессия закрыта».
			await this.notification("session.state.updated", {
				sessionId: this.platformId(id),
				externalSessionId: id,
				status: "blocked",
				selections: {},
				metadata: { readOnly: true, attached: false, sourceState: source }
			});
			this.sourceAvailability.set(id, source.availability);
		}
		this.published.delete(id);
		this.projections.delete(id);
	}

	/** ---------- состояние сессии ---------- */

	async state(id, log) {
		if (!this.published.has(id) || !await this.visible(id)) return;
		const live = this.native.ctx.sessions?.get(id);
		// Ожидающие подтверждения инструмента видны только в живых событиях:
		// без них сессия, стоящая на вопросе DSH, выглядела бы «простаивающей»,
		// а телефон продолжал бы слать в неё новые сообщения.
		const pending = new Set();
		for (const event of live ? snapshotEventsOf(live) : []) {
			const type = String(event?.type ?? "");
			if (type === "approval/asked") pending.add(String(record(event?.data).id));
			else if (type === "approval/decided") pending.delete(String(record(event?.data).id));
		}
		const waiting = this.native.questions.waiting(id);
		const liveStatus = this.native.status(id);
		let configuration = { selections: {}, metadata: {} };
		let lastKind;
		try {
			if (live || log) {
				const facts = await this.native.stateFacts(id);
				configuration = facts.configuration;
				lastKind = facts.lastTurnEndKind;
			}
		} catch (error) {
			if (this.closed || (error instanceof Error && error.name === "AbortError")) throw error;
			// Конфигурация не прочиталась — статус всё равно отдаём, но без
			// выдуманных моделей/прав.
			this.logger.warn("не удалось прочитать конфигурацию для фида", { sessionId: id, error: String(error) });
		}
		await this.notification("session.state.updated", {
			sessionId: this.published.get(id),
			externalSessionId: id,
			status: pending.size || waiting ? "waiting_approval" : liveStatus ?? (lastKind === "error" ? "error" : "idle"),
			selections: configuration.selections,
			metadata: { ...configuration.metadata, readOnly: this.native.readOnly, attached: liveStatus !== void 0 }
		});
	}

	/** ---------- обработка изменений ---------- */

	async sessionOperation(id, phase, operation) {
		try {
			await operation();
		} catch (error) {
			// Транспортные ошибки и отмена идут наверх (фид закрывается), а сбой
			// одной сессии изолируется: остальные продолжают синхронизироваться.
			if (this.closed || error instanceof SyncTransportError || (error instanceof Error && error.name === "AbortError")) throw error;
			this.logger.error("операция синк-фида по сессии не удалась", { streamId: this.id, sessionId: id, phase, error: String(error) });
			this.failedSessions.set(id, { availability: "unavailable", reason: "sync_failed", observedAt: new Date().toISOString() });
			if (this.capture?.id === id) {
				await this.send([{ kind: "snapshot.abort", sessionId: this.platformId(id), snapshotId: this.capture.snapshotId }]).catch(() => void 0);
				this.capture = void 0;
			}
			await this.unavailable(id);
		}
	}

	/**
	 * Догнать проекцию событием, которое только что вызвало пересборку снапшота.
	 *
	 * `session/event` приходит из Cordis раньше, чем наблюдение или persisted-лог
	 * успевают его отдать, поэтому свежий снапшот может не содержать это событие.
	 * Если его просто выбросить (как делает AA), проекция останется на seq раньше,
	 * следующее событие будет выглядеть пропуском — и сессия уйдёт в бесконечный
	 * цикл полных снапшотов, а то и в `unavailable`. Здесь же: лог уже содержит
	 * событие — проверка seq его отсечёт; не содержит — применим поверх, и ids
	 * элементов останутся теми же, потому что они считаются от данных события.
	 * @returns true, если событие применено и клиенту нужен delta.
	 */
	catchUp(id, event) {
		const projection = this.projections.get(id);
		if (!projection || !(Number(event.seq) > projection.throughSeq)) return false;
		try {
			projection.apply(event, void 0);
			return true;
		} catch {
			// Лог и событие расходятся: снапшот авторитетнее, догоним следующим.
			return false;
		}
	}

	async changes(changes) {
		const touched = new Set();
		const statuses = new Set();
		const ended = [];
		let reconcile = false;
		for (const change of changes) {
			if (change.type === "capabilities" || change.type === "catalogs") {
				// Каталоги и возможности клиент перечитывает сам по запросу:
				// пушить их значит дублировать тяжёлые ответы на каждый чих LLM.
				continue;
			}
			if (change.type === "visibility") {
				reconcile = true;
				continue;
			}
			const id = change.id;
			if (!id) continue;
			await this.sessionOperation(id, change.type, async () => {
				if (!await this.visible(id)) {
					if (this.published.has(id)) {
						await this.unavailable(id);
						reconcile = true;
					}
					return;
				}
				if (change.type === "refresh") {
					await this.baseline(id);
					return;
				}
				if (!this.published.has(id)) await this.baseline(id);
				if (!this.published.has(id)) return;
				if (change.type === "question" || change.type === "status" || change.type === "session") {
					statuses.add(id);
					return;
				}
				if (change.type === "stream") {
					this.projections.get(id)?.stream(change.turn, change.step, change.chunk, change.time, change.throughSeq);
					touched.add(id);
					return;
				}
				if (change.type === "event") {
					const event = record(change.event);
					if (["model/selection", "agent-preset/selected", "permission/preset"].includes(event.type)) statuses.add(id);
					if (event.type === "turn/end") {
						const reason = record(record(event.data).reason);
						statuses.add(id);
						ended.push([id, {
							sessionId: this.published.get(id),
							externalSessionId: id,
							sourceObservedAt: isoTime(event.time),
							outcome: reason.kind === "error" ? "failed" : ["aborted", "interrupted"].includes(reason.kind) ? "interrupted" : "completed"
						}]);
					}
					if (["turn/start", "approval/asked", "approval/decided", "request/header", "sandbox/mode", "approval/policy"].includes(event.type)) statuses.add(id);
					const projection = this.projections.get(id);
					if (!projection) {
						await this.baseline(id);
						if (this.catchUp(id, event)) touched.add(id);
						return;
					}
					// Переставляем сессию в конец LRU-порядка: чаще всего работают
					// с одной сессией, и её проекция должна оставаться в памяти.
					this.projections.delete(id);
					this.projections.set(id, projection);
					if (Number(event.seq) <= projection.throughSeq) return;
					try {
						projection.apply(event, void 0);
					} catch {
						// Пропуск в seq: единственный честный выход — пересобрать
						// снапшот сессии целиком.
						await this.baseline(id);
						if (this.catchUp(id, event)) touched.add(id);
						return;
					}
					touched.add(id);
					if (event.type === "session/title") {
						await this.notification("session.meta.upsert", {
							sessionId: this.published.get(id),
							externalSessionId: id,
							title: record(event.data).title ?? null
						});
					}
				} else statuses.add(id);
			});
		}
		for (const id of touched) {
			await this.sessionOperation(id, "timeline", async () => {
				const projection = this.projections.get(id);
				if (!projection || !await this.visible(id)) return;
				const delta = projection.drain();
				if (delta.removed.length) {
					// Удалённые элементы нельзя отозвать отдельной операцией в
					// нашем наборе: пересобираем снапшот сессии.
					await this.baseline(id);
					return;
				}
				await this.items(null, id, delta.items);
			});
		}
		for (const [id, params] of ended) {
			await this.sessionOperation(id, "turnEnded", async () => {
				if (this.published.has(id) && await this.visible(id)) await this.notification("session.turnEnded", params);
			});
		}
		for (const id of statuses) await this.sessionOperation(id, "state", () => this.state(id));
		if (reconcile) await this.reconcile();
	}

	/**
	 * Сверка после изменения видимости (например, архивации в десктопе):
	 * снимаем с публикации то, что больше не видно, и публикуем новое.
	 */
	async reconcile() {
		for (const id of [...this.published.keys()]) {
			if (!await this.visible(id)) await this.sessionOperation(id, "visibility", () => this.unavailable(id));
		}
		const sessions = [];
		for (const id of this.native.source.candidates()) {
			if (!await this.visible(id)) continue;
			sessions.push({ sessionId: this.platformId(id), externalSessionId: id, sourceState: await this.sourceStateOf(id) });
		}
		const scanToken = randomUUID();
		await this.notification("session.inventory.begin", { scanToken });
		await this.notification("session.inventory.complete", { scanToken, complete: true, sessions });
	}

	/** ---------- главный цикл ---------- */

	async run() {
		const scanToken = this.id;
		await this.notification("session.inventory.begin", { scanToken });
		// Инвентаризация идёт «по ходу»: клиент получает сессии до того, как
		// прочитан весь корпус, и может начинать показывать список.
		await this.native.inventory(this.abort.signal, async (entry) => {
			const id = record(entry.header).id;
			if (!id) return;
			// Состояние конфигурации публикуем только для живых сессий: для
			// холодных это чтение лога на каждую сессию, а телефон всё равно
			// запросит getState при открытии чата.
			if (!this.native.ctx.sessions?.get(id)) return;
			this.published.set(id, this.platformId(id));
			this.sourceAvailability.set(id, "available");
			await this.state(id);
		});
		await this.changes(this.takeChanges());
		const sessions = [];
		for (const id of this.native.source.candidates()) {
			if (!await this.visible(id)) continue;
			sessions.push({ sessionId: this.platformId(id), externalSessionId: id, sourceState: await this.sourceStateOf(id) });
		}
		await this.notification("session.inventory.complete", { scanToken, complete: true, sessions });
		this.logger.info("инвентаризация синк-фида завершена", { streamId: this.id, sessions: sessions.length });
		while (!this.closed) {
			if (!this.queue.length) {
				await new Promise((resolve) => {
					this.wake = resolve;
				});
			}
			if (this.closed) break;
			await sleep(this.abort.signal, PACING_MS).catch(() => void 0);
			if (this.closed) break;
			this.bufferedOperations = [];
			await this.changes(this.takeChanges());
			await this.flushOperations();
			this.bufferedOperations = void 0;
		}
	}

	takeChanges() {
		this.queuedBytes = 0;
		return this.queue.splice(0);
	}
}

function isoTime(value) {
	const date = value instanceof Date ? value : new Date(value ?? NaN);
	return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
