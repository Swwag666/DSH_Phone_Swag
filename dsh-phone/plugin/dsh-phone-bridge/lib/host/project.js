/**
 * Проекция «сырые события DSH -> элементы таймлайна» (projectionVersion 2).
 *
 * Модуль намеренно чистый: на входе — immutable-лог DSH ({session, events}),
 * на выходе — массив элементов. Никаких обращений к ctx, к диску и к текущему
 * содержимому файлов: историю нельзя «дочитывать» с диска, иначе в таймлайне
 * появится то, чего в момент события не было.
 *
 * Правила соответствия — те же, что в мосте AA (RUNTIME_READS.md):
 *  - настоящий пользовательский текст            -> message / markdown, role user
 *  - пользовательские сообщения, вставленные плагином -> не выводим
 *  - текст ассистента (стрим и финал)            -> message / markdown, один id
 *  - reasoning                                   -> system / reasoning
 *  - tool-call + tool/result                     -> один элемент tool по callId
 *  - bash/pwsh                                   -> tool / command
 *  - write/edit/str_replace_editor               -> tool / file_change
 *  - web_search                                  -> tool / web_search
 *  - subagent/send_message/...                   -> tool / agent_call
 *  - mcp__*                                      -> tool / mcp
 *  - ask_user_question / exit_plan_mode          -> tool / input_request
 *  - approval/asked + approval/decided           -> один tool / permission
 *  - turn/start, turn/end                        -> служебные (не отдаём клиенту)
 *  - compaction/*                                -> marker / compact
 *  - прочие внутренние события                   -> не выводим
 */
import { BridgeError, record } from "./errors.js";
import { clientMessageId, contentHash, itemId, json, jsonBytes } from "./identity.js";

/** Заглушка для вложений: нативная ссылка сохраняется, платформенный id не выдумываем. */
const ATTACHMENT_PLACEHOLDER = "[изображение: предпросмотр недоступен]";

/** Служебные элементы, которые нужны проекции, но не нужны клиенту. */
export function contentItems(items) {
	return items.filter((item) => item.type !== "turn.start" && item.type !== "turn.end");
}

/** Название последнего заголовка сессии из лога (null, если заголовка нет). */
export function foldTitle(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type === "session/title" && typeof record(event.data).title === "string") return event.data.title;
	}
	return null;
}

/** Последний turn/end: его reason решает, «error» или «idle» у холодной сессии. */
export function lastTurnEndKind(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type === "turn/end") return record(record(event.data).reason).kind;
	}
	return void 0;
}

/** Есть ли в логе настоящее пользовательское сообщение (правило видимости AA). */
export function isUserMessage(event) {
	return event?.type === "user/message" && record(record(event.data).source).kind === "user";
}

/** ---------- содержимое элементов ---------- */

/**
 * Содержимое вызова инструмента. `kind` выбирается по имени инструмента, потому
 * что телефон рендерит команды, правки файлов и поиск по-разному; при этом мы
 * не додумываем данные: нет аргумента — нет поля.
 */
export function toolContent(name, rawArguments) {
	let input = typeof rawArguments === "string" ? rawArguments : json(rawArguments ?? {});
	if (typeof rawArguments === "string") {
		// Аргументы стримятся кусками и в момент tool/call могут быть неполным
		// JSON: оставляем исходную строку, а не бросаем исключение.
		try {
			input = JSON.parse(rawArguments);
		} catch {}
	}
	const args = record(input);
	const content = { kind: "tool_call", title: name, toolName: name, input };
	if (name === "bash" || name === "pwsh") {
		content.kind = "command";
		if (typeof args.command === "string") content.command = args.command;
	} else if (name === "web_search") {
		content.kind = "web_search";
		if (typeof args.query === "string") content.query = args.query;
		if (typeof args.queries === "string") content.query = args.queries;
	} else if (name === "ask_user_question" || name === "exit_plan_mode") {
		content.kind = "input_request";
		// История вопросов только читается: отвечать на старый вопрос нельзя.
		content.readOnly = true;
	} else if (typeof name === "string" && name.startsWith("mcp__")) {
		content.kind = "mcp";
		content.name = name;
	} else {
		const action = {
			subagent: "invoke",
			subagent_fork: "spawn",
			send_message: "send_input",
			wait_agent: "wait",
			interrupt_agent: "close",
			list_agents: "unknown"
		};
		if (action[name]) {
			content.kind = "agent_call";
			content.action = action[name];
			if (typeof args.agent_id === "string") content.targetIds = [args.agent_id];
			else if (typeof args.target === "string") content.targetIds = [args.target];
		}
	}
	return content;
}

/** Текст результата инструмента: блоки склеиваются, изображения — заглушкой. */
export function resultContent(blocks) {
	const values = Array.isArray(blocks) ? blocks : [];
	return {
		output: values.map((block) => {
			const value = record(block);
			if (value.type === "image") return ATTACHMENT_PLACEHOLDER;
			return typeof value.text === "string" ? value.text : "";
		}).filter(Boolean).join("\n"),
		result: json(values)
	};
}

function diffLines(text, prefix) {
	if (!text) return "";
	return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => `${prefix}${line}`).join("\n");
}

/**
 * Обогащение результата: diff берётся ТОЛЬКО из нативной меты DSH. Читать
 * текущий файл с диска, чтобы «восстановить» правку, нельзя — между событием и
 * чтением файл мог измениться, и телефон показал бы выдуманную историю.
 */
export function enrichToolResult(content, meta) {
	const result = { ...content };
	if (meta !== void 0) result.dshResultMeta = json(meta);
	if (content.isError === true) return result;
	const input = record(content.input);
	const diffs = record(meta).diffs;
	const isEditor = ["write", "edit", "str_replace_editor"].includes(String(content.toolName));
	if (isEditor && Array.isArray(diffs) && diffs.length && diffs.every((diff) => {
		const d = record(diff);
		return typeof d.path === "string" && (d.oldText === null || typeof d.oldText === "string") && typeof d.newText === "string";
	})) {
		result.kind = "file_change";
		result.changes = diffs.map((diff) => {
			const d = record(diff);
			return {
				path: d.path,
				kind: d.oldText === null ? "add" : "update",
				diff: [diffLines(d.oldText, "-"), diffLines(d.newText, "+")].filter(Boolean).join("\n"),
				contextual: true
			};
		});
		return result;
	}
	// Для write без меты diff можно собрать честно — из аргументов самого вызова
	// (содержимое файла прислал агент, а не диск).
	if (String(content.toolName) === "write" && typeof input.file_path === "string" && input.file_path.trim() && typeof input.content === "string") {
		const created = typeof content.output === "string" && /^(Created|Updated) file$/m.test(content.output.trim());
		result.kind = "file_change";
		result.changes = [{
			path: input.file_path,
			kind: created && /^Updated file$/m.test(content.output.trim()) ? "update" : "add",
			diff: diffLines(input.content, "+"),
			contextual: false
		}];
	}
	return result;
}

/** ---------- проектор ---------- */

/**
 * Создаёт проектор одной сессии. Один и тот же объект используется и для
 * полного снапшота, и для живого потока: тогда стрим-куски и финальное сообщение
 * получают одинаковые id, и телефон не видит дублей.
 */
export function createProjection(externalId, platformId) {
	let throughSeq = -1;
	const changed = new Map();
	const removed = new Set();
	const items = new Map();
	const steps = new Map();
	const drafts = new Map();
	const pendingDrafts = new Map();
	let turnId = null;
	let turnStart = -1;
	let nextOrder = 0;
	const needsHash = new Set();

	function flushHashes() {
		for (const id of needsHash) {
			const item = items.get(id);
			if (item) item.contentHash = contentHash(item);
		}
		needsHash.clear();
	}

	/** Черновики стрима публикуем пачкой на границе событий, а не на каждый токен. */
	function flushDrafts() {
		for (const [key, values] of pendingDrafts) {
			for (const [index, value] of values) block(value.block, key, index, value.event, "assistant", "running", value.seq);
		}
		pendingDrafts.clear();
	}

	/**
	 * Единственная точка создания/обновления элемента.
	 * @param anchor seq первого события, породившего элемент: порядок в таймлайне
	 * не должен «прыгать», когда стрим-кусок обновляется много раз.
	 */
	function put(kind, key, event, type, status, role, content, index = 0, anchor = Number(event.seq)) {
		const id = itemId(externalId, kind, key);
		const previous = items.get(id);
		const value = {
			id,
			sessionId: platformId,
			type,
			status,
			role,
			turnId: previous ? previous.turnId : turnId,
			orderSeq: previous?.orderSeq ?? ++nextOrder,
			revision: Number(event.seq) + 1,
			contentHash: "",
			content,
			source: {
				runtime: "dsh",
				sessionId: externalId,
				itemId: key,
				itemType: event.type,
				seq: previous?.source.seq ?? anchor,
				lastSeq: Number(event.seq),
				time: event.time
			}
		};
		needsHash.add(id);
		items.set(id, value);
		changed.set(id, value);
		removed.delete(id);
		return value;
	}

	function tool(callId, name, args, event, index = 0, anchor) {
		const id = itemId(externalId, "tool", callId);
		const old = items.get(id);
		// callId и tool-call, и tool/result — один элемент: клиент должен видеть
		// «инструмент выполнен», а не две записи.
		return put("tool", callId, event, "tool", old?.status ?? "running", "assistant", {
			...old?.content,
			...toolContent(name, args),
			callId
		}, index, anchor);
	}

	function result(callId, blocks, failed, event, meta, error) {
		const previous = items.get(itemId(externalId, "tool", callId));
		put("tool", callId, event, "tool", failed ? "failed" : "done", "assistant", enrichToolResult({
			...previous?.content ?? toolContent("tool", {}),
			callId,
			isError: failed,
			...(error !== void 0 ? { error: json(error) } : {}),
			...resultContent(blocks)
		}, meta));
	}

	function block(value, key, index, event, role, status, anchor) {
		const b = record(value);
		switch (b.type) {
			case "text":
				return put("message", `${key}:${index}`, event, role === "system" ? "system" : "message", status, role, {
					kind: role === "system" ? "notice" : "markdown",
					format: "markdown",
					text: b.text
				}, index, anchor);
			case "reasoning":
				return put("reasoning", `${key}:${index}`, event, "system", status, "assistant", { kind: "reasoning", text: b.text }, index, anchor);
			case "image":
				return put("image", `${key}:${index}`, event, "message", status, role, {
					kind: "text",
					format: "text",
					text: ATTACHMENT_PLACEHOLDER,
					dshAttachment: json(b.attachment)
				}, index, anchor);
			case "tool-call":
				return tool(b.id, b.name, b.arguments, event, index, anchor);
			case "tool-result":
				result(b.toolCallId, b.content, b.isError === true, event);
				return;
			default:
				return;
		}
	}

	function remove(id) {
		if (items.delete(id)) {
			changed.delete(id);
			removed.add(id);
		}
	}

	/**
	 * Применить одно событие лога.
	 * @param transient true для стрим-кусков: они не двигают watermark и могут
	 * повторяться, поэтому проверка последовательности seq к ним не применяется.
	 */
	function apply(event, receipt, transient = false) {
		const seq = Number(event.seq);
		if (!transient && seq <= throughSeq) return;
		// Пропуск в seq означает, что мы потеряли часть лога. Молча продолжать
		// нельзя — таймлайн «схлопнется»; синк-фид на этой ошибке пересобирает
		// снапшот сессии заново.
		if (!transient && throughSeq >= 0 && seq !== throughSeq + 1) throw new BridgeError("PERSISTENCE_ERROR", "Пропуск в последовательности событий DSH.", true);
		if (!transient) throughSeq = seq;
		if (event.type !== "assistant/chunk") flushDrafts();
		const data = record(event.data);
		const stepKey = `${String(data.turn)}:${String(data.step)}`;

		if (event.type === "turn/start") {
			turnStart = seq;
			turnId = itemId(externalId, "turn", String(turnStart));
			put("turn.start", String(turnStart), event, "turn.start", "done", "system", { kind: "turn_start", turn: data.turn });
		} else if (event.type === "turn/end") {
			const reason = record(data.reason);
			const status = reason.kind === "error" ? "failed" : ["aborted", "interrupted"].includes(reason.kind) ? "interrupted" : "done";
			// Всё, что осталось «running» в этом повороте, закрываем: агент
			// прерван, и вечно крутящийся спиннер на телефоне — ложь.
			for (const [id, item] of items) {
				if (item.turnId !== turnId || item.status !== "running") continue;
				const closed = {
					...item,
					status: status === "done" ? "interrupted" : status,
					revision: seq + 1,
					source: { ...item.source, lastSeq: seq }
				};
				needsHash.add(id);
				items.set(id, closed);
				changed.set(id, closed);
			}
			put("turn.end", String(turnStart), event, "turn.end", status, "system", { kind: "turn_end", reason: json(reason) });
			turnId = null;
		} else if (event.type === "step/start") {
			steps.set(stepKey, seq);
		} else if (event.type === "user/message") {
			const message = record(data);
			const source = record(message.source);
			// Инъекции плагинов (окружение, скиллы) приходят под ролью user, но
			// человеком не писались — в таймлайн не пускаем.
			if (source.kind !== "user") return;
			const rpcId = source.rpcId;
			const clientId = (typeof rpcId === "string" ? clientMessageId(externalId, rpcId) : void 0)
				?? clientMessageId(externalId, message.id);
			const blocks = Array.isArray(message.content) ? message.content : [];
			blocks.forEach((value, i) => {
				const item = block(value, message.id, i, event, "user", "done");
				if (item) {
					item.source = {
						...item.source,
						messageSource: json(source),
						...(clientId ? { clientMessageId: clientId } : {})
					};
				}
			});
		} else if (event.type === "assistant/chunk") {
			const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`;
			const values = drafts.get(key) ?? new Map();
			drafts.set(key, values);
			const chunk = record(data.chunk);
			if (!("index" in chunk)) return;
			const previous = values.get(chunk.index);
			let value = previous?.block;
			if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
				const type = chunk.type === "text-delta" ? "text" : "reasoning";
				value = { type, text: (value?.type === type ? value.text : "") + chunk.text };
			} else if (chunk.type === "tool-call-delta") {
				const old = value?.type === "tool-call" ? value : void 0;
				value = {
					type: "tool-call",
					id: chunk.id,
					name: chunk.name ?? old?.name ?? "tool",
					// Аргументы копятся строкой: парсить растущий JSON на каждом
					// токене — основная причина деградации на длинных вызовах.
					arguments: (old?.arguments ?? "") + (chunk.argumentsDelta ?? "")
				};
			} else if (chunk.type === "block-end") {
				value = chunk.block;
			}
			if (value) {
				const anchor = previous?.seq ?? seq;
				const entry = { block: value, seq: anchor, event };
				values.set(chunk.index, entry);
				const pending = pendingDrafts.get(key) ?? new Map();
				pending.set(chunk.index, entry);
				pendingDrafts.set(key, pending);
			}
		} else if (event.type === "assistant/attempt") {
			// Новая попытка модели: черновики прошлой уже не станут финалом.
			const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`;
			for (const [index, value] of drafts.get(key) ?? []) {
				const b = record(value.block);
				remove(itemId(externalId, b.type === "tool-call" ? "tool" : b.type === "reasoning" ? "reasoning" : "message", b.type === "tool-call" ? b.id : `${key}:${index}`));
			}
			drafts.delete(key);
		} else if (event.type === "assistant/message") {
			const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`;
			const values = drafts.get(key);
			const message = record(data.message);
			const blocks = Array.isArray(message.content) ? message.content : [];
			const finalCalls = new Set(blocks.flatMap((b) => (record(b).type === "tool-call" ? [record(b).id] : [])));
			for (const [index, value] of values ?? []) {
				const b = record(value.block);
				if (b.type === "tool-call" && !finalCalls.has(b.id)) remove(itemId(externalId, "tool", b.id));
				if (index >= blocks.length && b.type !== "tool-call") {
					remove(itemId(externalId, b.type === "reasoning" ? "reasoning" : b.type === "image" ? "image" : "message", `${key}:${index}`));
				}
			}
			blocks.forEach((value, i) => {
				const item = block(value, key, i, event, "assistant", data.interrupted ? "interrupted" : "done", values?.get(i)?.seq);
				if (item) {
					const source = record(message.source);
					item.source = {
						...item.source,
						messageId: message.id,
						...(typeof source.provider === "string" ? { provider: source.provider } : {}),
						...(typeof source.model === "string" ? { model: source.model } : {})
					};
				}
			});
			drafts.delete(key);
		} else if (event.type === "tool/call") {
			tool(data.callId, data.name, data.arguments, event);
		} else if (event.type === "tool/result") {
			const value = record(record(data.message).content?.[0]);
			result(value.toolCallId, value.content, value.isError === true || Boolean(data.error), event, data.meta, data.error);
		} else if (event.type === "tool/code-dispatch-start" || event.type === "tool/code-dispatch") {
			// Подвызовы run_code — самостоятельные элементы с ссылкой на родителя.
			if (typeof data.subCallId !== "string" || typeof data.name !== "string") return;
			const item = tool(data.subCallId, data.name, data.arguments, event);
			item.content.parentItemId = itemId(externalId, "tool", String(data.parentCallId));
			item.content.rootCallId = String(data.rootCallId);
			if (event.type === "tool/code-dispatch") result(data.subCallId, data.content, data.isError === true, event);
		} else if (event.type === "approval/asked" || event.type === "approval/decided") {
			// Оба события схлопываются в одну запись: история авторизаций
			// читается, но повторно ничего не спрашивает.
			const key = String(data.id);
			put("approval", key, event, "tool", "done", "system", {
				...items.get(itemId(externalId, "approval", key))?.content,
				kind: "permission",
				title: "Запись авторизации инструмента",
				readOnly: true,
				...json(data)
			});
		} else if (String(event.type).startsWith("compaction/")) {
			put("event", String(seq), event, "marker", "done", "system", {
				kind: "compact",
				title: "Сжатие контекста",
				eventType: event.type,
				details: json(data)
			});
		}
		// Всё остальное (request/header, replayState, системные промпты,
		// внутренние информационные события) в таймлайн не проецируется намеренно.
	}

	return {
		apply,
		/**
		 * Живой стрим-кусок вне лога. Применяется только пока watermark не ушёл
		 * вперёд, иначе уже зафиксированное событие будет перезаписано черновиком.
		 */
		stream(turn, step, chunk, time, cursor) {
			if (throughSeq > cursor) return;
			apply({ type: "assistant/chunk", seq: throughSeq, time, data: { turn, step, chunk } }, void 0, true);
		},
		get throughSeq() {
			return throughSeq;
		},
		get dirty() {
			return pendingDrafts.size > 0 || changed.size > 0 || removed.size > 0;
		},
		snapshot() {
			flushDrafts();
			flushHashes();
			return [...items.values()].sort((a, b) => a.orderSeq - b.orderSeq || a.id.localeCompare(b.id));
		},
		drain() {
			flushDrafts();
			flushHashes();
			const delta = { items: [...changed.values()], removed: [...removed] };
			changed.clear();
			removed.clear();
			return delta;
		}
	};
}

// Локальная ссылка, чтобы не тащить в проекцию весь identity-модуль циклом.

/**
 * Проиграть лог в проектор, периодически отдавая управление event loop.
 * Без уступки длинная история (тысячи событий) блокирует главный процесс DSH
 * на сотни миллисекунд — а там же живут RPC, окна и таймеры.
 */
export async function replayHistory(projection, log, signal, sliceMs = 5) {
	const events = Array.isArray(log?.events) ? log.events : [];
	let deadline = Date.now() + sliceMs;
	for (let index = 0; index < events.length; index++) {
		if (index % 128 === 0 && Date.now() >= deadline) {
			await new Promise((resolve) => setImmediate(resolve));
			deadline = Date.now() + sliceMs;
		}
		signal?.throwIfAborted();
		projection.apply(events[index], void 0);
	}
}

/** Полный снапшот истории одной сессии. */
export async function projectHistory(log, platformId, signal) {
	const projection = createProjection(record(log?.session).id ?? "", platformId);
	await replayHistory(projection, log, signal);
	return projection.snapshot();
}

/**
 * Разбить элементы на страницы по лимитам кадра. Возвращает страницы (массивы),
 * а решение «отправлять или нет» оставляет вызывающему: у RPC и у синк-фида
 * разные бюджеты.
 */
export function paginateItems(items, { maxItems = 250, maxBytes = 6291456 } = {}) {
	const pages = [];
	let page = [];
	let bytes = 0;
	for (const item of items) {
		const size = jsonBytes(item);
		if (size > maxBytes) throw new BridgeError("FRAME_TOO_LARGE", "Один элемент истории DSH превышает предел транспорта.");
		if (page.length && (bytes + size > maxBytes || page.length >= maxItems)) {
			pages.push(page);
			page = [];
			bytes = 0;
		}
		page.push(item);
		bytes += size;
	}
	if (page.length) pages.push(page);
	return pages;
}
