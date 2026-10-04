/**
 * Доступ к сервисам DSH из плагина.
 *
 * Главное правило модуля: любой `ctx.get(...)` может вернуть undefined (сервис
 * ещё не поднят, выгружен, или в этой сборке DSH его нет вовсе). Поэтому каждое
 * обращение защищено, а отсутствие сервиса превращается в честный
 * UNSUPPORTED_OPERATION или в пустой результат — но никогда в падение процесса
 * DSH и никогда в выдуманные данные.
 *
 * Всё, что читает/пишет нативные сессии, живёт здесь; router и sync не знают
 * про cordis вообще.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, record } from "./errors.js";
import {
	decodeModelSelection,
	decodePermissionSelection,
	itemId,
	modelSelectionId,
	permissionSelectionId,
	sessionId as platformSessionId,
	userMessageId
} from "./identity.js";
import { isUserMessage, lastTurnEndKind } from "./project.js";

/** Пределы кэшей: плагин живёт месяцами, неограниченный рост = утечка. */
const MAX_CACHED_LOGS = 8;
const MAX_CACHED_CATALOGS_MS = 30_000;
const MAX_QUESTION_ENTRIES = 128;
const MAX_ACCEPTED_IDS = 512;

/** Логгер, который ничего не делает: используется, если ctx.logger недоступен. */
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function createLogger(ctx, name = "dsh-phone-bridge") {
	try {
		return ctx.logger?.(name) ?? quietLogger;
	} catch {
		return quietLogger;
	}
}

function safeCall(fn, fallback) {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** События живой сессии. Экспортировано: синк-фиду они нужны для статуса. */
export function snapshotEvents(session) {
	if (!session || typeof session.snapshotEvents !== "function") return [];
	return safeCall(() => [...(session.snapshotEvents() ?? [])], []);
}

/**
 * Сон с отменой. Слушатель снимается в любом исходе: иначе каждая попытка
 * переподключения потока вопросов оставляла бы на signal ещё один обработчик.
 */
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

/**
 * Источник сессий: объединяет официальный список (live + persisted) и правила
 * видимости сайдбара DSH. Список читается один раз на подписку/инвентаризацию,
 * дальше его поддерживают нативные события — иначе каждый RPC сканировал бы весь
 * корпус сессий.
 */
export class SessionSource {
	ctx;
	logger;
	records = new Map();
	archived = new Set();
	withUserMessages = new Set();
	/** id -> ревизия лога, в котором пользовательских сообщений точно нет. */
	emptyLogs = new Map();
	failedReads = new Set();
	/** id -> ревизия лога по данным последней инвентаризации (для кэшей). */
	revisions = new Map();
	logs = new Map();
	reads = new Map();
	initialized = false;
	refreshing;
	closed = false;

	constructor(ctx, logger = quietLogger) {
		this.ctx = ctx;
		this.logger = logger;
		this.archived = new Set(safeCall(() => [...(ctx.workspaceRegistry?.archivedSessionIds ?? [])], []));
	}

	async initialize(signal) {
		if (!this.initialized) await this.refresh(signal);
		signal?.throwIfAborted();
	}

	/** Нативное событие: кэш лога протух, а знание о user-message обновилось. */
	observe(session, event) {
		const id = session?.id;
		if (!id) return;
		this.evict(id);
		this.retry(id);
		this.records.set(id, {
			header: session.header ?? record(session),
			live: true,
			persisted: this.records.get(id)?.persisted ?? false
		});
		const hasUser = event ? isUserMessage(event) : snapshotEvents(session).some(isUserMessage);
		if (hasUser) {
			this.withUserMessages.add(id);
			this.emptyLogs.delete(id);
		}
	}

	async refresh(signal) {
		this.refreshing ??= this.refreshRecords(signal).finally(() => {
			this.refreshing = void 0;
		});
		await this.refreshing;
		signal?.throwIfAborted();
	}

	async refreshRecords(signal) {
		const previous = new Map(this.records);
		const listSessions = this.ctx.sessionQuery?.listSessions;
		if (typeof listSessions !== "function") {
			// Без официального запроса мы не имеем права выдумывать список:
			// отдаём только то, что уже видели в живых событиях.
			this.logger.warn("sessionQuery.listSessions недоступен: список сессий неполный");
			this.initialized = true;
			return;
		}
		const entries = await listSessions.call(this.ctx.sessionQuery, signal) ?? [];
		this.revisions.clear();
		for (const id of this.logs.keys()) this.evict(id);
		this.failedReads.clear();
		const listed = new Set(entries.map((entry) => record(entry.header).id));
		for (const [id, entry] of previous) {
			if (this.records.get(id) === entry && !listed.has(id) && !this.ctx.sessions?.get(id)) {
				this.records.delete(id);
				this.withUserMessages.delete(id);
				this.emptyLogs.delete(id);
			}
		}
		for (const entry of entries) {
			const id = record(entry.header).id;
			const current = this.records.get(id);
			if (!current || current === previous.get(id)) this.records.set(id, entry);
		}
		this.archived = new Set(safeCall(() => [...(this.ctx.workspaceRegistry?.archivedSessionIds ?? [])], []));
		this.initialized = true;
	}

	/** Идентичность лога по данным последней инвентаризации. */
	revisionOf(id) {
		const live = this.ctx.sessions?.get(id);
		if (live !== void 0) return `live:${Number(live.seq) - 1}`;
		return this.revisions.get(id);
	}

	/**
	 * Свежая идентичность лога, включая изменения после инвентаризации.
	 * `sessionPersistence.stat` — один файл, а не сканирование всех снапшотов.
	 */
	async freshRevisionOf(id) {
		const live = this.ctx.sessions?.get(id);
		if (live !== void 0) return `live:${Number(live.seq) - 1}`;
		try {
			const snapshot = await this.ctx.get("sessionPersistence")?.stat(id);
			if (!snapshot) {
				this.revisions.delete(id);
				return void 0;
			}
			const revision = String(snapshot.revision);
			this.revisions.set(id, revision);
			return revision;
		} catch {
			this.revisions.delete(id);
			return void 0;
		}
	}

	candidates() {
		return [...new Set([...this.records.keys(), ...this.archived])];
	}

	retry(id) {
		this.failedReads.delete(id);
	}

	markReadFailed(id) {
		this.failedReads.add(id);
		this.logger.warn("чтение сессии недоступно", { sessionId: id });
	}

	evict(id) {
		const cached = this.logs.get(id);
		if (!cached) return;
		this.logs.delete(id);
		try {
			cached.dispose?.();
		} catch {}
	}

	close() {
		this.closed = true;
		for (const id of [...this.logs.keys()]) this.evict(id);
		this.records.clear();
		this.revisions.clear();
		this.emptyLogs.clear();
		this.withUserMessages.clear();
		this.failedReads.clear();
	}

	/**
	 * Открыть immutable-срез лога. Сначала официальный `observeSession` с
	 * projectionMode "none" (полный лог, а не текущий контекст модели), и только
	 * если его нет — `readSession`.
	 */
	async openLog(id) {
		const query = this.ctx.sessionQuery;
		if (!query) throw new BridgeError("DSH_SERVICE_UNAVAILABLE", "Сервис чтения сессий DSH недоступен.", true);
		if (typeof query.observeSession === "function") {
			const observation = await query.observeSession(id, { projectionMode: "none" });
			return {
				header: observation.header ?? record(observation.session),
				events: [...(observation.events ?? [])],
				inheritedEventCount: observation.inheritedEventCount ?? 0,
				// observation — ресурс: держим его, пока он в кэше, и освобождаем
				// при вытеснении, иначе нативный лог остаётся в памяти навсегда.
				retain: () => safeCall(() => observation.retain?.(), void 0),
				dispose: () => safeCall(() => observation[Symbol.dispose]?.(), void 0)
			};
		}
		if (typeof query.readSession === "function") {
			const log = await query.readSession(id);
			return {
				header: record(log.session),
				events: [...(log.events ?? [])],
				inheritedEventCount: log.inheritedEventCount ?? 0,
				dispose: () => {}
			};
		}
		throw new BridgeError("UNSUPPORTED_OPERATION", "Эта сборка DSH не предоставляет чтение истории сессий.");
	}

	/** Прочитать лог с кэшем по идентичности лога (не по времени!). */
	async readLog(id) {
		const pending = this.reads.get(id);
		if (pending) return pending;
		const task = this.loadLog(id);
		this.reads.set(id, task);
		try {
			return await task;
		} finally {
			if (this.reads.get(id) === task) this.reads.delete(id);
		}
	}

	async loadLog(id) {
		const revision = await this.freshRevisionOf(id);
		let cached = this.logs.get(id);
		if (cached && cached.revision !== revision) {
			this.evict(id);
			cached = void 0;
		}
		let handle = cached?.handle;
		if (!handle) handle = await this.openLog(id);
		try {
			const actualRevision = revision;
			const log = {
				session: handle.header,
				events: [...handle.events],
				inheritedEventCount: handle.inheritedEventCount,
				...(actualRevision === void 0 ? {} : { bridgeRevision: actualRevision })
			};
			if (!cached && !this.closed && actualRevision !== void 0) {
				// Кэш ограничен: держим только недавно читавшиеся сессии.
				while (this.logs.size >= MAX_CACHED_LOGS) {
					const oldest = this.logs.keys().next().value;
					if (oldest === void 0) break;
					this.evict(oldest);
				}
				handle.retain?.();
				this.logs.set(id, { revision: actualRevision, handle });
			}
			return log;
		} finally {
			if (!cached && !this.logs.get(id)) handle.dispose?.();
		}
	}

	/**
	 * Видимость сессии по правилам сайдбара DSH.
	 *
	 * Проверка читает лог, но результат кэшируется: `withUserMessages` — навсегда
	 * (пользовательское сообщение из истории не исчезает), `emptyLogs` — до смены
	 * ревизии лога. Поэтому и список сессий, и синк-инвентарь дают один и тот же
	 * ответ, а повторные вызовы почти бесплатны.
	 */
	async visible(id) {
		const live = this.ctx.sessions?.get(id);
		const header = live?.header ?? this.records.get(id)?.header;
		if (!header || header.origin === "subagent" || this.archived.has(id)) return false;
		if (this.failedReads.has(id)) return false;
		if (this.withUserMessages.has(id)) return true;
		// Не живая и не сохранённая — читать нечего.
		if (!live && this.records.get(id)?.persisted === false) return false;
		if (live) {
			// Живая сессия: события уже в памяти, проверка бесплатна.
			if (!snapshotEvents(live).some(isUserMessage)) return false;
			this.withUserMessages.add(id);
			this.emptyLogs.delete(id);
			return true;
		}
		const revision = await this.freshRevisionOf(id);
		if (revision !== void 0 && this.emptyLogs.get(id) === revision) return false;
		let events;
		try {
			events = (await this.readLog(id)).events;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			this.markReadFailed(id);
			return false;
		}
		if (!events.some(isUserMessage)) {
			if (revision !== void 0) this.emptyLogs.set(id, revision);
			return false;
		}
		this.withUserMessages.add(id);
		this.emptyLogs.delete(id);
		return true;
	}

	async state(id) {
		const observedAt = new Date().toISOString();
		if (this.archived.has(id)) return { availability: "archived", reason: "archived_in_dsh", observedAt };
		if (!this.records.has(id) && !this.ctx.sessions?.get(id)) return { availability: "missing", reason: "not_found_in_dsh", observedAt };
		return await this.visible(id)
			? { availability: "available", reason: null, observedAt }
			: {
				availability: "unavailable",
				reason: this.failedReads.has(id) ? "read_failed" : "not_visible_in_dsh",
				observedAt
			};
	}

	async requireAvailable(id) {
		const state = await this.state(id);
		if (state.availability === "archived") throw new BridgeError("SESSION_ARCHIVED", "Сессия архивирована в DSH: восстановите её, чтобы продолжить.");
		if (state.reason === "read_failed") throw new BridgeError("PERSISTENCE_ERROR", "DSH не смог прочитать эту сессию.", true);
		if (state.availability !== "available") throw new BridgeError("SESSION_NOT_FOUND", "Сессия не видна в DSH.");
	}
}

/**
 * Каталоги моделей, прав и режимов агента. Кэшируются коротко: телефон открывает
 * форму нового чата и дёргает оба каталога сразу, а перечитывание провайдеров —
 * сетевой поход в LLM-сервис DSH.
 */
export class RuntimeCatalogs {
	ctx;
	logger;
	changed;
	cached;
	cachedAt = 0;

	constructor(ctx, logger = quietLogger, changed = () => {}) {
		this.ctx = ctx;
		this.logger = logger;
		this.changed = changed;
	}

	invalidate() {
		this.cached = void 0;
		this.cachedAt = 0;
		this.changed();
	}

	async models(force = false) {
		const fresh = this.cached && Date.now() - this.cachedAt < MAX_CACHED_CATALOGS_MS;
		if (this.cached && !force && fresh) return this.cached;
		const catalog = await this.readModels();
		this.cached = catalog;
		this.cachedAt = Date.now();
		return catalog;
	}

	async readModels() {
		const llm = this.ctx.get("llm");
		if (!llm || typeof llm.listProviders !== "function") {
			throw new BridgeError("UNSUPPORTED_OPERATION", "Сервис моделей DSH недоступен.");
		}
		const providers = await llm.listProviders();
		const failures = [];
		const models = (await Promise.all((providers ?? []).map(async (provider) => {
			try {
				const models = await llm.listModels(provider.id);
				return await Promise.all((models ?? []).map(async (model) => {
					const selection = { provider: provider.id, model: model.id };
					const entry = {
						id: modelSelectionId(selection),
						title: model.name || model.id,
						selectionId: modelSelectionId(selection),
						enabled: true,
						...(model.description ? { description: model.description } : {}),
						reasoningItems: [],
						metadata: {
							provider: provider.id,
							providerName: provider.name || provider.id,
							model: model.id,
							modelName: model.name || model.id,
							reasoningEffort: null
						}
					};
					try {
						const info = await llm.resolveModelInfo?.(provider.id, model.id);
						entry.reasoningItems = (record(record(info).reasoning).efforts ?? []).map((effort) => ({
							id: effort.id,
							title: effort.name || effort.id,
							enabled: true,
							selectionId: modelSelectionId({ ...selection, reasoningEffort: effort.id }),
							...(effort.description ? { description: effort.description } : {})
						}));
					} catch {
						// Одна модель без метаданных не должна ронять весь каталог.
						entry.enabled = false;
						entry.disabledReason = "DSH не смог прочитать возможности этой модели.";
					}
					return entry;
				}));
			} catch {
				const message = "DSH не смог загрузить модели этого провайдера. Обновите список.";
				failures.push({ provider: provider.id, name: provider.name, message });
				return (this.cached?.models.filter((item) => item.metadata.provider === provider.id) ?? []).map((item) => ({
					...item,
					enabled: false,
					disabledReason: message
				}));
			}
		}))).flat();
		labelModels(models);
		return {
			runtime: "dsh",
			revision: 0,
			models,
			metadata: { failures, routableProviders: (providers ?? []).map((provider) => provider.id) }
		};
	}

	permissions() {
		const service = this.ctx.get("permissionPresets");
		if (!service || !Array.isArray(service.names)) {
			throw new BridgeError("UNSUPPORTED_OPERATION", "Эта сборка DSH не предоставляет пресеты прав.");
		}
		return {
			runtime: "dsh",
			revision: 3,
			permissions: service.names.map((preset) => {
				const option = safeCall(() => record(service.optionOf?.(preset)), {});
				return {
					id: permissionSelectionId(preset),
					title: option.name ?? preset,
					selectionId: permissionSelectionId(preset),
					description: option.description ?? null,
					enabled: true,
					metadata: { preset }
				};
			})
		};
	}

	async agentPresets() {
		const service = this.ctx.get("agentPresets");
		if (!service || typeof service.list !== "function") {
			throw new BridgeError("UNSUPPORTED_OPERATION", "Эта сборка DSH не предоставляет режимы агента.");
		}
		const presets = (await service.list() ?? []).map((preset) => ({
			id: preset.id,
			name: preset.name || preset.id,
			description: preset.description ?? null,
			enabled: !preset.broken,
			disabledReason: preset.broken ? "Режим не загружается" : null
		}));
		const initial = presets.some((preset) => preset.id === "standard" && preset.enabled) ? "standard" : void 0;
		return {
			runtime: "dsh",
			revision: 3,
			presets,
			configField: {
				type: "string",
				minLength: 1,
				title: "Режим новой сессии",
				description: "Применяется только к создаваемым сессиям.",
				...(initial ? { default: initial } : {}),
				enum: presets.map((preset) => preset.id)
			},
			uiField: {
				component: "select",
				options: presets.map((preset) => ({
					value: preset.id,
					label: preset.name,
					description: preset.description,
					disabled: !preset.enabled,
					disabledReason: preset.disabledReason
				}))
			}
		};
	}
}

/**
 * Подписи моделей. Делаются ПОСЛЕ полного перечня, чтобы фильтрация и пагинация
 * не меняли идентичность и не путали пользователя одинаковыми именами.
 */
function labelModels(models) {
	for (const item of models) {
		const { provider, providerName, model, modelName } = item.metadata;
		const sameName = models.filter((candidate) => candidate.metadata.modelName === modelName);
		const multipleProviders = sameName.some((candidate) => candidate.metadata.provider !== provider);
		const duplicateProviderName = sameName.some((candidate) => candidate.metadata.provider !== provider && candidate.metadata.providerName === providerName);
		const duplicateModelName = sameName.some((candidate) => candidate.metadata.provider === provider && candidate.metadata.model !== model);
		const routeLabel = duplicateProviderName ? `${providerName} / ${provider}` : providerName;
		item.title = `${modelName}${multipleProviders ? ` (${routeLabel})` : ""}${duplicateModelName ? ` [${model}]` : ""}`;
	}
}

/**
 * Конфигурация сессии: модель, права, режим агента. Пишем только официальными
 * сервисами DSH — свой «слой настроек» разошёлся бы с тем, что видит десктоп.
 */
export class RuntimeConfiguration {
	ctx;
	logger;

	constructor(ctx, logger = quietLogger) {
		this.ctx = ctx;
		this.logger = logger;
	}

	get canSelectModel() {
		return Boolean(this.ctx.get("sessionController") && this.ctx.get("llm"));
	}

	get canSelectPermission() {
		return Boolean(this.ctx.get("sessionController") && this.ctx.get("permissionPresets") && this.ctx.get("commands"));
	}

	controller() {
		const controller = this.ctx.get("sessionController");
		if (!controller) throw new BridgeError("UNSUPPORTED_OPERATION", "Для отправки сообщений и смены настроек нужен Session Controller DSH.");
		return controller;
	}

	async agent(id) {
		const controller = this.controller();
		if (typeof controller.resolveAgent !== "function") throw new BridgeError("UNSUPPORTED_OPERATION", "Session Controller DSH не предоставляет активацию сессии.");
		const found = await controller.resolveAgent(id);
		if (!found || "error" in record(found)) throw new BridgeError("DSH_SERVICE_UNAVAILABLE", "DSH не смог активировать эту сессию. Повторите, когда сессия станет доступна.", true);
		return found.agent;
	}

	async validate(selections, initial = false) {
		if (selections.model) {
			if (!this.canSelectModel) this.controller();
			const selection = decodeModelSelection(selections.model);
			try {
				await this.ctx.get("llm").resolveCallConfig({
					provider: selection.provider,
					model: selection.model,
					...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
				});
			} catch {
				throw new BridgeError("INVALID_PARAMS", "DSH отклонил эту модель или уровень рассуждений. Обновите список моделей.");
			}
		}
		if (selections.permission) {
			const preset = decodePermissionSelection(selections.permission);
			const service = this.ctx.get("permissionPresets");
			if (!service || !Array.isArray(service.names) || !service.names.includes(preset)) {
				throw new BridgeError("INVALID_PARAMS", "Этот пресет прав недоступен. Обновите список прав.");
			}
			if (!initial && !this.canSelectPermission) throw new BridgeError("UNSUPPORTED_OPERATION", "DSH не предоставляет команду смены прав для активной сессии.");
		}
	}

	async validatePreset(id) {
		if (id === void 0) return void 0;
		if (typeof id !== "string" || !id || id.length > 256) throw new BridgeError("INVALID_PARAMS", "Выберите режим агента.");
		const presets = this.ctx.get("agentPresets");
		if (!presets || typeof presets.list !== "function") throw new BridgeError("UNSUPPORTED_OPERATION", "Режимы агента DSH недоступны.");
		const preset = (await presets.list() ?? []).find((item) => item.id === id);
		if (!preset || preset.broken) throw new BridgeError("INVALID_PARAMS", "Выбранный режим агента отсутствует или не загружается.");
		return preset.id;
	}

	async apply(agent, selections, initial, signal) {
		signal?.throwIfAborted?.();
		if (selections.model) {
			const requested = decodeModelSelection(selections.model);
			const current = safeCall(() => this.ctx.get("sessionProjections")?.snapshot(agent.session, ["modelSelection"])?.values?.modelSelection?.next, void 0);
			if (!current || modelSelectionId(current) !== selections.model) {
				await this.controller().selectModel({ sessionId: agent.id, ...requested });
			}
		}
		if (selections.permission) {
			const preset = decodePermissionSelection(selections.permission);
			const presets = this.ctx.get("permissionPresets");
			if (initial) {
				if (typeof presets?.set !== "function") throw new BridgeError("UNSUPPORTED_OPERATION", "DSH не позволяет задать пресет прав при создании сессии.");
				presets.set(agent.session, preset);
			} else if (safeCall(() => presets?.current(agent.session), void 0) !== preset) {
				const commands = this.ctx.get("commands");
				if (!commands?.find?.(agent, "permission")) throw new BridgeError("UNSUPPORTED_OPERATION", "Этот агент не предоставляет команду смены прав.");
				const outcome = await commands.execute(agent, `/permission ${preset}`, [], signal);
				if (record(record(outcome).result).kind !== "success") {
					throw new BridgeError("DSH_SERVICE_UNAVAILABLE", "DSH не смог применить пресет прав. Обновите состояние сессии.", true);
				}
			}
		}
		await this.flush(agent?.session);
	}

	/** Сброс на диск: без него десктоп и телефон видят разное состояние. */
	async flush(session) {
		if (!session) return;
		try {
			await this.ctx.sessions?.flush?.(session);
		} catch (error) {
			this.logger.warn("не удалось сбросить сессию на диск", { error: String(error) });
		}
	}

	/**
	 * Состояние конфигурации сессии. Официальные проекции работают и для
	 * «холодных» сессий, не поднимая агента; если проекций нет — честно берём
	 * модель из последнего request/header, а права не выдумываем вовсе.
	 */
	async state(id, log) {
		const live = this.ctx.sessions?.get(id);
		const events = live ? snapshotEvents(live) : (log?.events ?? []);
		const header = live?.header ?? log?.session ?? {};
		const projections = this.ctx.get("sessionProjections");
		let projected;
		if (projections) {
			try {
				projected = live
					? projections.snapshot(live, ["modelSelection", "permissions", "agentPreset"])
					: projections.restore({}, events, 0, header, log?.inheritedEventCount ?? 0).snapshot;
			} catch (error) {
				// Формы аргументов restore — часть внутреннего API DSH: если они
				// изменились, лучше отдать меньше данных, чем упасть.
				this.logger.debug("sessionProjections недоступны для чтения конфигурации", { sessionId: id, error: String(error) });
				projected = void 0;
			}
		}
		const values = record(projected?.values);
		const rawModel = record(values.modelSelection).next;
		const lastUsed = record(values.modelSelection).lastUsed;
		const request = record(record(events.findLast?.((event) => event.type === "request/header")?.data).header).config;
		const model = rawModel ?? modelFromRecord(request);
		const permission = values.permissions?.currentValue;
		const presetEvent = events.findLast?.((event) => event.type === "agent-preset/selected");
		const agentPreset = values.agentPreset ?? (presetEvent ? record(presetEvent.data).agentPreset : header.agentPreset);
		const presets = this.ctx.get("permissionPresets");
		return {
			selections: {
				...(model ? { model: modelSelectionId(model) } : {}),
				...(permission ? { permission: permissionSelectionId(permission) } : {})
			},
			metadata: {
				configurationSeq: Number(projected?.asOfSeq ?? events.at?.(-1)?.seq ?? -1),
				agentPreset: agentPreset ?? null,
				cwd: header.cwd ?? null,
				...(model ? { modelSelection: model } : {}),
				...(permission ? {
					permissionPreset: {
						id: permission,
						name: safeCall(() => presets?.optionOf?.(permission)?.name, void 0) ?? permission,
						selectable: permission !== "custom"
					}
				} : {}),
				...(lastUsed ? { lastUsedModel: lastUsed } : {})
			}
		};
	}
}

function modelFromRecord(value) {
	const model = record(value);
	if (typeof model.provider !== "string" || typeof model.model !== "string") return void 0;
	return {
		provider: model.provider,
		model: model.model,
		...(typeof model.reasoningEffort === "string" ? { reasoningEffort: model.reasoningEffort } : {})
	};
}

/** ---------- вопросы пользователя (ask_user_question) ---------- */

function invalid(message) {
	throw new BridgeError("INVALID_PARAMS", message);
}

/**
 * Контракт inputRequest v1: телефон строит форму по uiSchema, а мы превращаем
 * его ответ обратно в формат DSH. Подписи вариантов (`o_N`) стабильны, тексты —
 * нет: менять их местами нельзя, иначе ответ уйдёт не в тот вариант.
 */
export class QuestionForm {
	questions;

	constructor(value) {
		if (!Array.isArray(value) || !value.length) invalid("DSH не прислал вопросы.");
		const ids = new Set();
		this.questions = value.map((raw) => {
			const q = record(raw);
			if (typeof q.id !== "string" || !q.id || ids.has(q.id) || typeof q.question !== "string" || !q.question.trim() || q.intent != null) invalid("Неподдерживаемое определение вопроса DSH.");
			ids.add(q.id);
			if (q.multiSelect != null && typeof q.multiSelect !== "boolean") invalid("Недопустимый режим выбора.");
			const options = q.options ?? [];
			if (!Array.isArray(options)) invalid("Недопустимые варианты ответа.");
			const labels = new Set();
			for (const option of options) {
				const o = record(option);
				if (typeof o.label !== "string" || !o.label || labels.has(o.label) || (o.description != null && typeof o.description !== "string")) invalid("Недопустимый вариант ответа.");
				labels.add(o.label);
			}
			return {
				id: q.id,
				question: q.question,
				...(typeof q.header === "string" ? { header: q.header } : {}),
				...(typeof q.detail === "string" ? { detail: q.detail } : {}),
				multiSelect: q.multiSelect === true,
				options: options.map((option) => record(option))
			};
		});
	}

	input() {
		const questions = this.questions.map((q) => ({
			id: q.id,
			prompt: q.detail ? `${q.question}\n\n${q.detail}` : q.question,
			...(q.header ? { header: q.header } : {}),
			multiple: q.multiSelect === true,
			allowCustom: true,
			options: q.options.map((o, i) => ({ id: `o_${i}`, label: o.label, ...(o.description ? { description: o.description } : {}) }))
		}));
		return {
			required: true,
			schema: {
				type: "object",
				required: ["answers"],
				additionalProperties: false,
				properties: {
					answers: {
						type: "object",
						required: questions.map((q) => q.id),
						additionalProperties: false,
						properties: Object.fromEntries(questions.map((q) => [q.id, {
							type: "object",
							additionalProperties: false,
							properties: {
								optionIds: {
									type: "array",
									uniqueItems: true,
									items: { type: "string", enum: q.options.map((o, i) => `o_${i}`) },
									...(!q.multiSelect ? { maxItems: 1 } : {})
								},
								customText: { type: "string" }
							}
						}]))
					}
				}
			},
			uiSchema: { component: "inputRequest", version: 1, questions }
		};
	}

	answer(input) {
		const answers = record(record(input).answers);
		if (Object.keys(answers).length !== this.questions.length || Object.keys(answers).some((id) => !this.questions.some((q) => q.id === id))) invalid("Ответьте на все вопросы.");
		return {
			answers: this.questions.map((q) => {
				const a = record(answers[q.id]);
				if (Object.keys(a).some((key) => key !== "optionIds" && key !== "customText")) invalid("Ответ содержит неизвестные поля.");
				const optionIds = a.optionIds ?? [];
				if (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string") || new Set(optionIds).size !== optionIds.length) invalid("Выберите допустимые варианты.");
				if (a.customText != null && typeof a.customText !== "string") invalid("Свой ответ должен быть текстом.");
				const custom = typeof a.customText === "string" ? a.customText.trim() : "";
				if (!optionIds.length && !custom) invalid("Ответьте на все вопросы.");
				if (!q.multiSelect && (optionIds.length > 1 || (optionIds.length > 0 && custom))) invalid("В одиночном выборе допустим один вариант либо свой ответ.");
				const options = new Map(q.options.map((o, i) => [`o_${i}`, o.label]));
				const selected = optionIds.map((id) => {
					if (!options.has(id)) invalid("Ответ содержит неизвестный вариант.");
					return options.get(id);
				});
				return { id: q.id, selected, ...(custom ? { custom } : {}) };
			})
		};
	}
}

/**
 * Локальный потребитель официального Remote-потока вопросов. Мы не подменяем
 * провайдера ответов: если поток недоступен, вопросы честно не поддерживаются.
 */
export class QuestionStream {
	ctx;
	receive;
	changed;
	logger;
	clientId;
	activeContext;
	scope;
	abort = new AbortController();
	task;

	get available() {
		return this.clientId !== void 0;
	}

	constructor(ctx, receive, changed, logger = quietLogger) {
		this.ctx = ctx;
		this.receive = receive;
		this.changed = changed;
		this.logger = logger;
		try {
			this.scope = ctx.inject(["typertGateway", "connection", "userQuestions"], (ready) => {
				this.task = this.run(ready);
				ready.effect(() => async () => {
					// Отменяем цикл чтения: иначе итератор потока переживёт выгрузку
					// плагина и будет держать сервисы DSH живыми.
					this.abort.abort();
					await this.task?.catch(() => void 0);
				}, "dsh-phone-bridge: поток вопросов");
			});
		} catch (error) {
			this.logger.warn("поток вопросов недоступен", { error: String(error) });
		}
	}

	async run(ready) {
		while (!this.abort.signal.aborted) {
			try {
				const stream = await ready.typertGateway.wireStream.open("$events", { args: {} }, this.abort.signal);
				for await (const value of stream) {
					if (this.abort.signal.aborted) break;
					const frame = record(value);
					if (frame.type === "ready" && typeof frame.clientId === "string") {
						this.clientId = frame.clientId;
						this.activeContext = ready;
						this.changed();
					} else await this.receive(frame);
				}
			} catch {
				// Поток рвётся при любом сбое связи: не логируем шумом, просто
				// сбрасываем доступность и пробуем снова.
			} finally {
				this.clientId = void 0;
				this.activeContext = void 0;
				this.changed();
			}
			try {
				await sleep(this.abort.signal, 500);
			} catch {
				break;
			}
		}
	}

	async reply(eventId, outcome) {
		const ctx = this.activeContext;
		const clientId = this.clientId;
		if (!ctx || !clientId) throw new Error("Соединение вопросов DSH недоступно, повторите позже.");
		const rpcId = randomUUID();
		const response = await ctx.connection.createSharedFetchHandler("/api").fetch(new Request("http://127.0.0.1/api/$events/result", {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: AbortSignal.timeout(15_000),
			body: JSON.stringify({
				type: "client-request",
				rpcId,
				method: "$events/result",
				payload: { args: { clientId, eventId, outcome } }
			})
		}));
		const envelope = record(await response.json());
		if (!response.ok || envelope.type !== "server-response" || envelope.rpcId !== rpcId || record(envelope.result).ok !== true) {
			throw new Error("DSH не принял ответ, повторите позже.");
		}
	}

	async close() {
		this.abort.abort();
		try {
			await this.scope?.dispose?.();
		} catch {}
	}
}

/** Хранилище активных вопросов: только те, что принадлежат рантайму моста. */
export class UserQuestions {
	visible;
	changed;
	stream;
	entries = new Map();

	get available() {
		return this.stream.available;
	}

	constructor(ctx, visible, changed, logger = quietLogger) {
		this.visible = visible;
		this.changed = changed;
		this.stream = new QuestionStream(ctx, (frame) => this.receive(frame), changed, logger);
	}

	async receive(frame) {
		if (frame.type === "cancel" && typeof frame.eventId === "string") {
			const entry = this.entries.get(frame.eventId);
			if (entry) {
				entry.withdrawn = true;
				this.update(entry, "closed");
			}
			return;
		}
		if (frame.type !== "waterfall" || typeof frame.eventId !== "string") return;
		if (this.entries.has(frame.eventId)) return;
		let form;
		try {
			if (frame.event === "user-questions/request" && typeof frame.agentId === "string" && await this.visible(frame.agentId)) {
				form = new QuestionForm(frame.request?.questions);
			}
		} catch {
			form = void 0;
		}
		if (!form) {
			// Чужой/неподдерживаемый вопрос обязан уйти дальше по потоку: если
			// промолчать, инструмент DSH зависнет в ожидании ответа навсегда.
			await this.stream.reply(frame.eventId, { kind: "next" }).catch(() => void 0);
			return;
		}
		const entry = { eventId: frame.eventId, agentId: frame.agentId, form, status: "open", withdrawn: false, revision: 1 };
		this.entries.set(entry.eventId, entry);
		this.changed(entry.agentId);
	}

	update(entry, status) {
		if (entry.status === status) return;
		entry.status = status;
		entry.revision++;
		this.changed(entry.agentId);
		// Закрытые записи держим ограниченно: история вопросов не должна расти.
		const closed = [...this.entries.values()].filter((e) => !this.pending(e));
		for (const old of closed.slice(0, Math.max(0, closed.length - MAX_QUESTION_ENTRIES))) this.entries.delete(old.eventId);
	}

	pending(entry) {
		return entry.status === "open" || entry.status === "responding";
	}

	waiting(id) {
		return [...this.entries.values()].some((e) => e.agentId === id && this.pending(e));
	}

	notices(namespace, id) {
		const platformId = platformSessionId(namespace, id);
		return [...this.entries.values()].filter((e) => e.agentId === id).map((e) => {
			const pending = this.pending(e);
			return {
				noticeId: itemId(platformId, "question", e.eventId),
				sessionId: platformId,
				runtime: "dsh",
				type: "interaction",
				interactionType: "input_request",
				title: "Нужен ваш ответ",
				severity: "info",
				status: e.status,
				revision: e.revision,
				responseRequired: pending,
				blocking: pending ? { scope: "session", targetId: platformId } : null,
				source: { runtime: "dsh", component: "dsh.ask_user_question" },
				context: {},
				metadata: { eventId: e.eventId },
				actions: pending
					? [
						{ actionId: "submit", label: "Отправить ответ", style: "primary", input: e.form.input() },
						{ actionId: "cancel", label: "Отмена", style: "secondary" }
					]
					: []
			};
		});
	}

	async respond(namespace, id, noticeId, actionId, input) {
		const entry = [...this.entries.values()].find((e) => e.agentId === id && itemId(platformSessionId(namespace, id), "question", e.eventId) === noticeId);
		if (!entry || entry.status !== "open" || !await this.visible(id)) {
			return { ok: false, code: "dsh_question_not_pending", message: "Вопрос уже обработан или недействителен." };
		}
		let outcome;
		if (actionId === "submit") outcome = { kind: "result", value: entry.form.answer(input) };
		else if (actionId === "cancel") outcome = { kind: "rejected", error: { name: "UserQuestionError", code: "ASK_CANCELLED", message: "Пользователь отменил вопрос." } };
		else return { ok: false, code: "dsh_question_invalid_action", message: "Неизвестное действие вопроса." };
		this.update(entry, "responding");
		try {
			await this.stream.reply(entry.eventId, outcome);
			if (entry.withdrawn) return { ok: false, code: "dsh_question_not_pending", message: "Вопрос обработан на другом устройстве." };
			this.update(entry, actionId === "cancel" ? "cancelled" : "resolved");
			return { ok: true, result: { resolved: true, noticeId, sessionId: platformSessionId(namespace, id) } };
		} catch (error) {
			if (!entry.withdrawn) this.update(entry, "open");
			return { ok: false, code: "dsh_question_unavailable", message: error instanceof Error ? error.message : "Вопросы DSH временно недоступны." };
		}
	}

	observe(id, event) {
		if (event?.type !== "turn/end") return;
		for (const entry of this.entries.values()) if (entry.agentId === id && entry.status === "open") this.update(entry, "expired");
	}

	async close() {
		await this.stream.close();
	}
}

/**
 * Рантайм моста: слушает нативные события DSH и раздаёт их подписчикам
 * (синк-фиду), а также владеет всеми операциями чтения/записи.
 */
export class NativeRuntime {
	ctx;
	logger;
	source;
	catalogs;
	configuration;
	questions;
	listeners = new Set();
	writes = new Map();
	/** clientMessageId -> externalId: защита от повторной отправки того же текста. */
	accepted = new Map();
	syncCheckpoints = new Map();
	/** id -> {revision, value}: кэш фактов конфигурации по идентичности лога. */
	facts = new Map();
	disposables = [];
	closed = false;

	constructor(ctx, logger = createLogger(ctx)) {
		this.ctx = ctx;
		this.logger = logger;
		this.source = new SessionSource(ctx, logger);
		this.catalogs = new RuntimeCatalogs(ctx, logger, () => this.emit({ type: "catalogs" }));
		this.configuration = new RuntimeConfiguration(ctx, logger);
		this.questions = new UserQuestions(ctx, (id) => this.visible(id), (id) => this.emit(id ? { type: "question", id } : { type: "capabilities" }), logger);

		this.track(ctx.on("llm/adapters-updated", () => this.catalogs.invalidate(), { global: true }));
		// Наличие/выгрузка сервисов меняет набор возможностей: сообщаем подписчикам,
		// чтобы телефон не показывал кнопки, которые уже не работают.
		for (const key of ["sessionController", "permissionPresets", "commands", "agentPresets", "attachments", "fileUploads"]) {
			try {
				this.disposables.push(ctx.inject([key], (child) => {
					this.emit({ type: "capabilities" });
					child.effect(() => () => this.emit({ type: "capabilities" }), "dsh-phone-bridge.capabilities");
				}));
			} catch (error) {
				this.logger.debug("inject недоступен для сервиса", { key, error: String(error) });
			}
		}

		this.track(ctx.on("session/created", (session) => {
			this.source.observe(session);
			this.emit({ type: "session", id: session?.id });
		}, { global: true }));
		this.track(ctx.on("session/event", (session, event) => {
			this.source.observe(session, event);
			this.questions.observe(session?.id, event);
			this.emit({ type: "event", id: session?.id, event });
		}, { global: true }));
		this.track(ctx.on("session/disposed", (session) => this.emit({ type: "session", id: session?.id }), { global: true }));

		// Живой стрим: черновики текста/вызовов до финального сообщения.
		const attempts = new Map();
		this.track(ctx.on("agent/assistant-stream", ({ agent, frame }) => {
			const f = record(frame);
			if (f.type === "start") attempts.set(agent.id, f);
			else {
				const attempt = attempts.get(agent.id);
				if (attempt?.attemptId !== f.attemptId) return;
				if (f.type === "chunk") {
					this.emit({
						type: "stream",
						id: agent.id,
						turn: attempt.turn,
						step: attempt.step,
						chunk: f.chunk,
						time: f.time,
						throughSeq: Number(agent.session?.seq ?? 0) - 1
					});
				} else {
					attempts.delete(agent.id);
					// Брошенная попытка означает, что финального сообщения не будет:
					// черновики надо пересобрать из лога.
					if (record(f.outcome).kind === "abandoned") this.emit({ type: "refresh", id: agent.id });
				}
			}
		}, { global: true }));
		this.track(ctx.on("agent/status", ({ agent }) => this.emit({ type: "status", id: agent?.id }), { global: true }));

		this.track(ctx.on("domain/changed", (change) => {
			const c = record(change);
			if (c.domain !== "workspace") return;
			if (c.table === "" && c.operation === "put") {
				const ids = record(c.value).archivedSessionIds;
				if (!Array.isArray(ids)) return;
				const next = new Set(ids.filter((id) => typeof id === "string"));
				if (next.size !== this.source.archived.size || [...next].some((id) => !this.source.archived.has(id))) {
					this.source.archived = next;
					this.emit({ type: "visibility" });
				}
			}
		}));
	}

	track(disposable) {
		if (disposable) this.disposables.push(disposable);
		return disposable;
	}

	watch(callback) {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	emit(change) {
		for (const listener of this.listeners) {
			try {
				listener(change);
			} catch (error) {
				// Сбой одного подписчика не должен ломать доставку остальным.
				this.logger.warn("подписчик синк-фида упал", { error: String(error) });
			}
		}
	}

	refresh(id) {
		for (const checkpoints of this.syncCheckpoints.values()) checkpoints.delete(id);
		this.source.retry(id);
		this.emit({ type: "refresh", id });
	}

	checkpoints(namespace) {
		let map = this.syncCheckpoints.get(namespace);
		if (!map) {
			map = new Map();
			this.syncCheckpoints.set(namespace, map);
		}
		return map;
	}

	get readOnly() {
		return !this.ctx.get("sessionController");
	}

	workspaces() {
		const list = safeCall(() => this.ctx.workspaceRegistry?.list?.() ?? [], []);
		return list.map((w) => {
			const workspace = record(w);
			return {
				id: workspace.id ?? null,
				title: workspace.title ?? null,
				path: workspace.path ?? null,
				sessionIds: safeCall(() => [...(workspace.sessionIds ?? [])], [])
			};
		});
	}

	/** Живой статус агента; undefined означает «сессия не активна». */
	status(id) {
		return safeCall(() => this.ctx.get("agents")?.get?.(id)?.status, void 0);
	}

	async visible(id) {
		try {
			return await this.source.visible(id);
		} catch (error) {
			// Отмену пробрасываем наверх: иначе прерванная инвентаризация тихо
			// «спрячет» все сессии. Прочие сбои чтения — сессия не видна.
			if (error instanceof Error && error.name === "AbortError") throw error;
			return false;
		}
	}

	/** Инвентаризация видимых сессий; `visit` вызывается по ходу, а не в конце. */
	async inventory(signal, visit) {
		await this.source.initialize(signal);
		const result = [];
		for (const entry of [...this.source.records.values()]) {
			signal?.throwIfAborted();
			const id = record(entry.header).id;
			if (!id) continue;
			// Ошибка одной сессии не отменяет инвентаризацию остальных.
			try {
				if (await this.visible(id)) {
					result.push(entry);
					await visit?.(entry);
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				this.logger.warn("инвентаризация сессии не удалась", { sessionId: id, error: String(error) });
			}
		}
		return result;
	}

	async ensureKnown(id, signal) {
		if (this.source.records.has(id) || this.ctx.sessions?.get(id) !== void 0) return;
		await this.source.initialize(signal);
	}

	async readLog(id) {
		await this.source.requireAvailable(id);
		try {
			return await this.source.readLog(id);
		} catch (error) {
			if (!(error instanceof Error && error.name === "AbortError")) this.source.markReadFailed(id);
			throw error;
		}
	}

	/**
	 * Факты конфигурации с кэшем по идентичности лога. `session.getState`
	 * опрашивается узлом раз в секунду на каждую наблюдаемую сессию: без кэша
	 * холодная сессия читалась бы с диска на каждом опросе.
	 */
	async stateFacts(id) {
		const revision = await this.source.freshRevisionOf(id);
		if (revision !== void 0) {
			const cached = this.facts.get(id);
			if (cached !== void 0 && cached.revision === revision) return cached.value;
		}
		const live = this.ctx.sessions?.get(id);
		const log = live !== void 0 ? void 0 : await this.source.readLog(id);
		const events = live ? snapshotEvents(live) : log.events;
		const value = {
			configuration: await this.configuration.state(id, log),
			lastTurnEndKind: lastTurnEndKind(events)
		};
		if (revision !== void 0) {
			// Кэш фактов ограничен: на каждой сессии хранится лишь вывод.
			while (this.facts.size >= MAX_CACHED_LOGS) {
				const oldest = this.facts.keys().next().value;
				if (oldest === void 0) break;
				this.facts.delete(oldest);
			}
			this.facts.delete(id);
			this.facts.set(id, { revision, value });
		}
		return value;
	}

	/**
	 * Набор возможностей. Всё, что мы не умеем, объявлено явно и с причиной:
	 * телефон по этим флагам прячет кнопки, и «молча не работает» хуже, чем
	 * «недоступно».
	 */
	async capabilities(platformId, id) {
		let model = false;
		let catalog;
		if (this.configuration.canSelectModel) {
			try {
				catalog = await this.catalogs.models();
				model = catalog.metadata.routableProviders.length > 0;
			} catch (error) {
				this.logger.debug("каталог моделей недоступен", { error: String(error) });
			}
		}
		const effort = Boolean(catalog?.models.some((item) => item.enabled && item.reasoningItems.some((option) => option.enabled)));
		const writable = Boolean(this.ctx.get("sessionController"));
		const permission = this.configuration.canSelectPermission
			&& (!id || !this.ctx.get("agents")?.get?.(id) || Boolean(this.ctx.get("commands")?.find?.(this.ctx.get("agents").get(id), "permission")));
		const enabled = new Set([
			"runtime.config",
			...(writable ? ["session.send_message", "session.interrupt"] : []),
			...(this.questions.available ? ["session.interaction.approval"] : []),
			...(model ? ["catalog.model"] : []),
			...(effort ? ["catalog.effort"] : []),
			...(permission ? ["catalog.permission"] : [])
			// session.steer, session.commands и runtime.attachment не поддерживаем
			// намеренно: в DSH нет эквивалента, а объявлять их «доступными» значит
			// обещать телефону то, чего нет.
		]);
		const scope = platformId ? "session" : "runtime";
		return {
			runtime: "dsh",
			revision: 5,
			...(platformId ? { sessionId: platformId } : {}),
			capabilities: [
				"runtime.config",
				"session.send_message",
				"session.interrupt",
				"session.steer",
				"session.interaction.approval",
				"catalog.model",
				"catalog.permission",
				"catalog.effort",
				"session.commands",
				"runtime.attachment"
			].map((capabilityId) => ({
				capabilityId,
				runtime: "dsh",
				scope,
				supported: enabled.has(capabilityId),
				available: enabled.has(capabilityId),
				allowed: enabled.has(capabilityId),
				...(enabled.has(capabilityId) ? {} : { unavailableReason: "Эта возможность DSH недоступна." })
			})),
			metadata: {
				readOnly: !writable,
				attachments: false,
				userQuestions: this.questions.available,
				approval: false
			}
		};
	}

	/**
	 * Сообщение уже принято с этим clientMessageId? Проверяем только по данным,
	 * которые уже в памяти (живая сессия или кэш лога): специально читать лог
	 * ради проверки идемпотентности дорого, а повторный requestId DSH отклонит
	 * сам.
	 */
	hasAcceptedMessage(id, messageId) {
		if (this.accepted.get(messageId) === id) return true;
		const live = this.ctx.sessions?.get(id);
		const events = live ? snapshotEvents(live) : safeCall(() => this.source.logs.get(id)?.handle?.events, void 0);
		if (!events) return false;
		const matches = (message) => {
			const m = record(message);
			return m.id === messageId || record(m.source).rpcId === messageId;
		};
		return events.some((event) => (event.type === "user/message"
			? matches(event.data)
			: event.type === "agent/inbox/spliced" && record(event.data).inserted?.some?.(matches)));
	}

	rememberAccepted(id, messageId) {
		// Ограниченный FIFO: память не должна расти от числа отправленных сообщений.
		if (this.accepted.size >= MAX_ACCEPTED_IDS) {
			const oldest = this.accepted.keys().next().value;
			if (oldest !== void 0) this.accepted.delete(oldest);
		}
		this.accepted.set(messageId, id);
	}

	/**
	 * Отправка сообщения (и, при create, создание сессии).
	 * Пишущие операции на одну сессию сериализуются: DSH допускает одного
	 * писателя на сессию (sameSessionWriterLimit = 1), а телефон умеет
	 * отправлять несколько сообщений подряд.
	 */
	async send(id, text, requestId, cwd, create = false, selections = {}, agentPreset, signal = new AbortController().signal, images = []) {
		if (typeof text !== "string" || !text.trim() || text.length > 1_000_000 || typeof requestId !== "string" || !requestId || requestId.length > 512) {
			throw new BridgeError("INVALID_PARAMS", "Нужны текст сообщения и стабильный clientMessageId.");
		}
		if (images.length) throw new BridgeError("UNSUPPORTED_OPERATION", "Вложения не поддерживаются этим мостом.");
		return this.write(id, signal, async () => {
			await this.source.initialize(signal);
			if (!create || this.source.archived.has(id)) await this.source.requireAvailable(id);
			if (!create && !await this.visible(id)) throw new BridgeError("SESSION_NOT_FOUND", "Сессия не видна в DSH.");
			const messageId = userMessageId(id, requestId);
			if (this.hasAcceptedMessage(id, messageId)) return { duplicate: true };
			let path;
			if (create) {
				if (!cwd || !isAbsolute(cwd)) throw new BridgeError("INVALID_PARAMS", "Укажите абсолютный путь рабочей папки.");
				try {
					path = await realpath(cwd);
					if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
				} catch {
					throw new BridgeError("INVALID_PARAMS", "Рабочая папка должна быть доступным каталогом на устройстве с DSH.");
				}
			}
			await this.configuration.validate(selections, create);
			if (create) {
				const preset = await this.configuration.validatePreset(agentPreset);
				await this.configuration.controller().create({ sessionId: id, cwd: path, agentPreset: preset });
				// Привязка к workspace — удобство для сайдбара DSH: если не вышло,
				// сессия всё равно создана, и ронять отправку из-за этого нельзя.
				try {
					const workspace = await this.ctx.workspaceRegistry?.create?.(path);
					await workspace?.attachSession?.(id);
				} catch (error) {
					this.logger.debug("не удалось привязать сессию к workspace", { sessionId: id, error: String(error) });
				}
			}
			const agent = await this.configuration.agent(id);
			await this.configuration.apply(agent, selections, create, signal);
			if (this.closed) throw new BridgeError("DSH_SERVICE_UNAVAILABLE", "Мост DSH закрывается.", true);
			if (!create && !await this.visible(id)) throw new BridgeError("SESSION_NOT_FOUND", "Сессия больше не видна в DSH.");
			await this.configuration.controller().prompt({
				sessionId: id,
				requestId: messageId,
				mode: "queue",
				content: [{ type: "text", text }]
			}, signal);
			this.rememberAccepted(id, messageId);
			await this.configuration.flush(agent.session);
			return { duplicate: false };
		});
	}

	async updateSelections(id, selections, signal) {
		return this.write(id, signal, async () => {
			await this.source.initialize(signal);
			await this.source.requireAvailable(id);
			await this.configuration.validate(selections);
			const agent = await this.configuration.agent(id);
			try {
				await this.configuration.apply(agent, selections, false, signal);
			} finally {
				this.emit({ type: "status", id });
			}
			return this.configuration.state(id);
		});
	}

	async interrupt(id) {
		await this.source.requireAvailable(id);
		const agent = safeCall(() => this.ctx.get("agents")?.get?.(id), void 0);
		if (!agent || typeof agent.cancel !== "function") {
			// Холодная сессия: прерывать нечего. Это не ошибка для пользователя —
			// агент и так не работает.
			return;
		}
		agent.cancel({ kind: "user" });
	}

	/** Очередь записи на сессию: одно одновременное изменение. */
	async write(id, signal, operation) {
		const task = (this.writes.get(id) ?? Promise.resolve()).catch(() => void 0).then(() => {
			signal?.throwIfAborted?.();
			if (this.closed) throw new BridgeError("DSH_SERVICE_UNAVAILABLE", "Мост DSH закрывается.", true);
			return operation();
		});
		this.writes.set(id, task);
		try {
			return await task;
		} finally {
			if (this.writes.get(id) === task) this.writes.delete(id);
		}
	}

	async close() {
		this.closed = true;
		for (const disposable of this.disposables.splice(0)) {
			try {
				if (typeof disposable === "function") disposable();
				else disposable?.dispose?.();
			} catch {}
		}
		this.listeners.clear();
		await this.questions.close().catch(() => void 0);
		await Promise.allSettled([...this.writes.values()]);
		this.writes.clear();
		this.accepted.clear();
		this.facts?.clear();
		this.syncCheckpoints.clear();
		this.source.close();
	}
}
