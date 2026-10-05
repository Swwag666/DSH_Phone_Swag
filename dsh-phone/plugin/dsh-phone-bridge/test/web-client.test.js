/**
 * Тест слияния браузерных половин.
 *
 * Грузит НАСТОЯЩИЙ `lib/client.js` (без сборки и без правок исходника) под
 * подставными браузерными глобалами в `node:vm` и проверяет инварианты
 * слияния dsh-draft-sync в dsh-phone-bridge:
 *
 *   - одна заявка на документ (ARM_KEY) и маркер `__dshDraftSyncPlugin` для
 *     asar-патча gui/draftsync-desktop.js;
 *   - ОДНА обёртка window.fetch и ОДНА пара XMLHttpRequest.prototype.open/send
 *     (два слоя и два темпа поллинга - это и есть регрессия, от которой тест);
 *   - один heartbeat на 15 с, который уносит ОБА пейлоада: RPC
 *     session.pluginPing (health.plugin) и ingest type=status (health.pluginBridge);
 *   - оба long-poll'а живут одновременно: /api/events (черновики) и
 *     /api/bridge/poll (команды узла), по одной цепочке каждый;
 *   - ИНВАРИАНТ ЭХА: программная запись (domSend / applyComposerText) никогда
 *     не уходит на узел как черновик пользователя, а пользовательский ввод -
 *     уходит (иначе проверка была бы слепой);
 *   - легаси-защита: со старым dsh-draft-sync в документе движок черновиков не
 *     стартует, мост работает, в консоль уходит громкое предупреждение;
 *   - dispose снимает хуки, чистит ARM-ключ и не оставляет ни таймера, ни
 *     запроса; чужая обёртка поверх нашей переживает dispose (P6).
 *
 * Таймеры и Date.now подменены одними виртуальными часами: тест детерминирован
 * и не спит реальным временем. Таймеры самого стенда (hold пустого long-poll'а)
 * учитываются отдельно и в «утечки» клиента не попадают. Внешних зависимостей
 * нет - только node:test.
 *
 * Чего здесь НЕТ и быть не может без настоящего браузера: поведение Lexical
 * (примет ли редактор execCommand("insertText") за настоящее редактирование и
 * отправит ли ход Enter-keymap), настоящая доставка событий через DOM-дерево с
 * capture/bubble-фазами, реальная видимость вкладки и настоящий
 * MutationObserver. `document.execCommand` здесь - заглушка, которая честно
 * пишет текст в элемент и рассылает input-слушателям: это проверяет НАШУ
 * последовательность вызовов и наш инвариант эха, но не реакцию Lexical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** Harness-id сессии: ровно та форма, которую ловит SESSION_RE в клиенте. */
const SID = "session-11111111-2222-3333-4444-555555555555";
const SID2 = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Сколько виртуальных мс стенд «держит» пустой long-poll команд. */
const POLL_HOLD_MS = 250;

// ---------------------------------------------------------------------------
// Виртуальные часы: один источник времени для таймеров и для Date.now().
// ---------------------------------------------------------------------------

async function drainMicrotasks(rounds = 4) {
	// Микрозадачи vm-реалма лежат в той же очереди jobs, поэтому macrotask-
	// уступка вычищает их целиком (очередь дренируется до пустого состояния).
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function createClock(startMs = 1700000000000) {
	let t = startMs;
	let nextId = 1;
	// Таймеры клиента и таймеры стенда разделены: pending() отвечает на вопрос
	// «не оставил ли движок тикающих хвостов», и hold long-poll'а тут ни при чём.
	const timers = new Map();
	const hostTimers = new Map();

	function put(map, fn, ms, every) {
		const id = nextId++;
		// Минимум 1 мс: браузер клампит вложенные setTimeout, а в виртуальном
		// времени нулевая задержка самовоспроизводящегося цикла (bridge poll
		// после каждого ответа ставит себя на 0 мс) не дала бы часам сдвинуться.
		map.set(id, { fn, at: t + Math.max(1, Number(ms) || 0), every: every || 0 });
		return id;
	}

	return {
		now() { return t; },
		setTimeout(fn, ms) { return put(timers, fn, ms, 0); },
		setInterval(fn, ms) { return put(timers, fn, ms, Math.max(1, Number(ms) || 1)); },
		clearTimeout(id) { timers.delete(id); },
		clearInterval(id) { timers.delete(id); },
		/** Таймер самого стенда; не учитывается в pending(). */
		afterHost(ms, fn) {
			const id = put(hostTimers, fn, ms, 0);
			return { cancel() { hostTimers.delete(id); } };
		},
		/** Сколько таймеров клиента живо: после dispose обязано быть 0. */
		pending() { return timers.size; },
		/** Двигает время, запуская таймеры по порядку и вычищая микрозадачи. */
		async advance(ms) {
			const target = t + ms;
			for (;;) {
				let bestId = 0;
				let best = null;
				let bestMap = null;
				for (const map of [timers, hostTimers]) {
					for (const [id, tm] of map) {
						if (tm.at > target) continue;
						if (!best || tm.at < best.at || (tm.at === best.at && id < bestId)) {
							best = tm; bestId = id; bestMap = map;
						}
					}
				}
				if (!best) break;
				t = best.at;
				if (best.every) best.at = t + best.every;
				else bestMap.delete(bestId);
				best.fn();
				await drainMicrotasks();
			}
			t = target;
			await drainMicrotasks();
		}
	};
}

// ---------------------------------------------------------------------------
// Заглушки DOM/браузера
// ---------------------------------------------------------------------------

class InputEventStub {
	constructor(type, init) { Object.assign(this, { type, bubbles: false, cancelable: false }, init || {}); }
}

class KeyboardEventStub {
	constructor(type, init) { Object.assign(this, { type, bubbles: false, cancelable: false }, init || {}); }
}

function jsonResponse(payload, ok = true, status = 200) {
	return {
		ok,
		status,
		headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
		json: () => Promise.resolve(payload),
		clone() { return jsonResponse(payload, ok, status); }
	};
}

function abortError() {
	const e = new Error("aborted");
	e.name = "AbortError";
	return e;
}

/**
 * Полностью подставной браузер: window === sandbox, один композитор
 * [data-composer-input] (опционально), документ, часы и fetch-роутер, который
 * отвечает на эндпоинты узла dsh-phone формами из server.rs:
 * draft_config -> {ok,token,port,version} (плоский, БЕЗ обёртки result),
 * bridge_poll -> {ok,commands,count,pluginId,ts}, bridge_ingest -> {ok:true},
 * events -> {ts,events:[...]}, rpc -> {ok,result}.
 */
function createHarness(options = {}) {
	const clock = createClock(options.clockStart);
	const harness = {
		clock,
		calls: [],            // каждый fetch: {url, path, query, method, body, at}
		ingests: [],          // {type, data, at}
		rpcs: [],             // {method, params, at}
		logs: [],
		warnings: [],
		errors: [],
		observers: [],
		abortControllers: [],
		aborts: 0,
		execCalls: [],
		rangeTargets: [],
		selectionCalls: [],
		xhrOpens: [],
		xhrSends: [],
		fetchWrites: 0,       // сколько раз перезаписали window.fetch
		xhrOpenWrites: 0,
		xhrSendWrites: 0,
		inFlight: { events: 0, poll: 0 },
		maxInFlight: { events: 0, poll: 0 },
		eventsQueue: [],      // ответы /api/events по очереди
		commands: [],         // команды узла для /api/bridge/poll
		desktopPayloads: {},  // path -> JSON-ответ «десктопа» (для sniff-тестов)
		failResponses: {},    // path -> {ok, status, body}: принудительный сбой узла
		sessionList: [],      // ответ session.list для probeSessionList
		draftResult: null,    // ответ session.getDraft
		effects: [],
		spec: null,
		module: null
	};

	// --- document ---
	const docListeners = [];
	const container = { nodeType: 1, isConnected: true, tagName: "DIV" };
	const body = { nodeType: 1, isConnected: true, tagName: "BODY" };
	const documentElement = { nodeType: 1, isConnected: true, tagName: "HTML" };

	const documentStub = {
		readyState: options.readyState || "complete",
		hidden: false,
		visibilityState: "visible",
		activeElement: body,
		body,
		documentElement,
		container,
		querySelectorCalls: 0,
		listeners: docListeners,
		querySelector(selector) {
			documentStub.querySelectorCalls++;
			if (selector !== "[data-composer-input]") return null;
			if (!harness.composer || !harness.composer.isConnected) return null;
			return harness.composer;
		},
		addEventListener(type, fn) { docListeners.push({ type, fn }); },
		removeEventListener(type, fn) {
			const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
			if (i >= 0) docListeners.splice(i, 1);
		},
		createRange() {
			return { selectNodeContents(node) { harness.rangeTargets.push(node); } };
		},
		// Честная заглушка: пишет текст в сфокусированный элемент и рассылает
		// input-слушателям - ровно то, что в браузере делает нативный ввод.
		execCommand(cmd, ui, text) {
			harness.execCalls.push({ cmd, text });
			if (cmd !== "insertText") return false;
			const node = documentStub.activeElement;
			if (!node || typeof node.dispatchEvent !== "function") return false;
			node.textContent = text;
			node.dispatchEvent(new InputEventStub("input", { bubbles: true, inputType: "insertText", data: text }));
			return true;
		},
		fireVisibility() {
			documentStub.visibilityState = documentStub.hidden ? "hidden" : "visible";
			for (const l of docListeners.slice()) if (l.type === "visibilitychange") l.fn({ type: "visibilitychange" });
		}
	};
	harness.document = documentStub;

	// --- композитор ---
	function makeComposer() {
		const listeners = [];
		const composer = {
			nodeType: 1,
			tagName: "DIV",
			isConnected: true,
			textContent: "",
			parentNode: container,
			listeners,
			events: [],
			focusCount: 0,
			hasAttribute: (name) => name === "data-composer-input",
			getAttribute: (name) => (name === "data-composer-input" ? "" : null),
			addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
			removeEventListener(type, fn) {
				const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
				if (i >= 0) listeners.splice(i, 1);
			},
			dispatchEvent(ev) {
				composer.events.push(ev);
				ev.target = composer;
				for (const l of listeners.slice()) if (l.type === ev.type) l.fn.call(composer, ev);
				return true;
			},
			focus() { composer.focusCount++; documentStub.activeElement = composer; }
		};
		Object.defineProperty(composer, "innerText", { get: () => composer.textContent, configurable: true });
		return composer;
	}
	harness.composer = options.composer === false ? null : makeComposer();
	harness.makeComposer = makeComposer;

	// --- MutationObserver ---
	class MutationObserverStub {
		constructor(callback) {
			this.callback = callback;
			this.targets = [];
			this.disconnects = 0;
			this.observing = false;
			harness.observers.push(this);
		}
		observe(target, init) { this.targets.push({ target, init }); this.observing = true; }
		disconnect() { this.observing = false; this.disconnects++; }
		takeRecords() { return []; }
		/** Имитация мутации DOM (в браузере это делает сам наблюдатель). */
		fire() { this.callback([], this); }
	}

	// --- XMLHttpRequest ---
	function XMLHttpRequestStub() {
		this.listeners = [];
		this.responseText = "";
	}
	XMLHttpRequestStub.prototype.open = function (method, url) { harness.xhrOpens.push({ method, url }); };
	XMLHttpRequestStub.prototype.send = function (body) { harness.xhrSends.push(body); };
	XMLHttpRequestStub.prototype.addEventListener = function (type, fn) { this.listeners.push({ type, fn }); };
	XMLHttpRequestStub.prototype.getResponseHeader = function (name) {
		return String(name).toLowerCase() === "content-type" ? "application/json" : null;
	};
	XMLHttpRequestStub.prototype.fireLoad = function (responseText) {
		this.responseText = responseText;
		for (const l of this.listeners.slice()) if (l.type === "load") l.fn({ type: "load" });
	};
	harness.XMLHttpRequestStub = XMLHttpRequestStub;

	// --- AbortController ---
	class AbortControllerStub {
		constructor() {
			this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
			harness.abortControllers.push(this);
		}
		abort() { this.signal.aborted = true; harness.aborts++; }
	}

	// --- long-poll команд: узел держит пустой запрос и будит его по команде ---
	let pollWaiter = null;

	// Метки времени ленты событий. Узел штампует их своими now_ts() и они
	// монотонны, поэтому курсор since клиента всегда растёт; стенд обязан
	// вести себя так же, иначе проверка курсора проверяла бы артефакт заглушки.
	let eventsTs = clock.now();
	function nextEventsTs() {
		eventsTs = Math.max(eventsTs + 1, clock.now());
		return eventsTs;
	}

	function pollPayload(body) {
		const cmds = harness.commands.splice(0, harness.commands.length);
		return jsonResponse({
			ok: true,
			commands: cmds,
			count: cmds.length,
			pluginId: body && body.pluginId,
			ts: clock.now()
		});
	}

	// --- fetch-роутер ---
	function routeRequest(path, body) {
		if (Object.prototype.hasOwnProperty.call(harness.failResponses, path)) {
			const f = harness.failResponses[path];
			return Promise.resolve(jsonResponse(f.body || { ok: false, error: "forced" }, f.ok === true, f.status || 503));
		}
		if (path === "/api/draft-config") {
			return Promise.resolve(jsonResponse({ ok: true, token: "tok-test", port: 8460, version: "9.9.9-test" }));
		}
		if (path === "/api/rpc") {
			const m = body && body.method;
			harness.rpcs.push({ method: m, params: (body && body.params) || null, at: clock.now() });
			if (m === "session.getDraft") return Promise.resolve(jsonResponse({ ok: true, result: harness.draftResult }));
			if (m === "session.list") return Promise.resolve(jsonResponse({ ok: true, result: { sessions: harness.sessionList } }));
			return Promise.resolve(jsonResponse({ ok: true, result: { saved: true } }));
		}
		if (path === "/api/events") {
			const queued = harness.eventsQueue.shift();
			return Promise.resolve(jsonResponse(queued || { ts: nextEventsTs(), events: [] }));
		}
		if (path === "/api/bridge/poll") {
			// gateway.rs::bridge_poll держит пустую очередь до `wait` секунд и
			// просыпается от rx.changed(), когда команда пришла. Моделируем то же:
			// иначе цепочка команд крутилась бы на каждом виртуальном миллисекунде.
			if (harness.commands.length) return Promise.resolve(pollPayload(body));
			return new Promise((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					resolve(pollPayload(body));
				};
				const handle = clock.afterHost(POLL_HOLD_MS, finish);
				pollWaiter = { cancel: () => handle.cancel(), resolve: finish };
			});
		}
		if (path === "/api/bridge/ingest") {
			harness.ingests.push({ type: body && body.type, data: (body && body.data) || null, at: clock.now() });
			return Promise.resolve(jsonResponse({ ok: true }));
		}
		if (Object.prototype.hasOwnProperty.call(harness.desktopPayloads, path)) {
			return Promise.resolve(jsonResponse(harness.desktopPayloads[path]));
		}
		return Promise.resolve(jsonResponse({ ok: false, error: "not_found" }, false, 404));
	}

	const originalFetch = function fetchStub(url, init) {
		const opts = init || {};
		const u = String(url);
		const method = String(opts.method || "GET").toUpperCase();
		let body = null;
		if (typeof opts.body === "string") {
			try { body = JSON.parse(opts.body); } catch (e) { body = opts.body; }
		}
		if (opts.signal && opts.signal.aborted) return Promise.reject(abortError());
		const path = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
		harness.calls.push({ url: u, path, query: u.split("?")[1] || "", method, body, at: clock.now() });

		// Счётчик одновременных запросов: две живые цепочки одного контура дали
		// бы 2, одна - всегда 1.
		const group = path === "/api/events" ? "events" : path === "/api/bridge/poll" ? "poll" : null;
		if (group) {
			harness.inFlight[group]++;
			harness.maxInFlight[group] = Math.max(harness.maxInFlight[group], harness.inFlight[group]);
		}
		const release = () => { if (group) harness.inFlight[group]--; };
		return routeRequest(path, body).then((r) => { release(); return r; }, (e) => { release(); throw e; });
	};
	harness.originalFetch = originalFetch;

	// --- console ---
	const consoleStub = {
		log: (...args) => harness.logs.push(args),
		info: (...args) => harness.logs.push(args),
		warn: (...args) => harness.warnings.push(args.join(" ")),
		error: (...args) => harness.errors.push(args.join(" ")),
		debug: () => {}
	};

	// --- sandbox ---
	const sandbox = {
		console: consoleStub,
		navigator: { userAgent: "node-test", platform: "test" },
		location: { href: "http://127.0.0.1:43120/" },
		document: documentStub,
		InputEvent: InputEventStub,
		KeyboardEvent: KeyboardEventStub,
		MutationObserver: MutationObserverStub,
		XMLHttpRequest: XMLHttpRequestStub,
		AbortController: AbortControllerStub,
		getSelection: () => ({
			removeAllRanges() { harness.selectionCalls.push("removeAllRanges"); },
			addRange() { harness.selectionCalls.push("addRange"); }
		}),
		setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
		clearTimeout: (id) => clock.clearTimeout(id),
		setInterval: (fn, ms) => clock.setInterval(fn, ms),
		clearInterval: (id) => clock.clearInterval(id)
	};
	// Date.now обязан идти по виртуальным часам: клиент сравнивает now() с
	// кулдаунами (GRACE_MS, IDLE_AFTER_MS, listProbedAt, SESSIONS_FRESH_MS).
	class DateShim extends Date { static now() { return clock.now(); } }
	sandbox.Date = DateShim;

	// Счётчики перезаписи: «обёртку установили дважды» видно именно здесь.
	let fetchValue = originalFetch;
	Object.defineProperty(sandbox, "fetch", {
		configurable: true,
		enumerable: true,
		get() { return fetchValue; },
		set(v) { harness.fetchWrites++; fetchValue = v; }
	});
	const originalXhrOpen = XMLHttpRequestStub.prototype.open;
	const originalXhrSend = XMLHttpRequestStub.prototype.send;
	let openValue = originalXhrOpen;
	let sendValue = originalXhrSend;
	harness.originalXhrOpen = originalXhrOpen;
	harness.originalXhrSend = originalXhrSend;
	Object.defineProperty(XMLHttpRequestStub.prototype, "open", {
		configurable: true,
		get() { return openValue; },
		set(v) { harness.xhrOpenWrites++; openValue = v; }
	});
	Object.defineProperty(XMLHttpRequestStub.prototype, "send", {
		configurable: true,
		get() { return sendValue; },
		set(v) { harness.xhrSendWrites++; sendValue = v; }
	});

	sandbox.window = sandbox;
	vm.createContext(sandbox);
	harness.sandbox = sandbox;

	// --- загрузка настоящего модуля ---
	sandbox.__ModuleLoader__ = {
		mode: "test",
		pendingQueue: [],
		load(registration) {
			// Форма реального загрузчика DSH: {id, factory(require)}, а не {load}.
			harness.spec = registration;
			const req = (specifier) => { throw new Error("внешний require недоступен: " + specifier); };
			harness.module = registration.factory(req);
			return harness.module;
		}
	};
	vm.runInContext(clientSource, sandbox, { filename: "dsh-phone-bridge/lib/client.js" });

	// --- помощники теста ---

	/** Монтирует клиент так, как это делает dsh-client-modules: apply(ctx). */
	harness.mount = () => {
		const ctx = {
			effect(fn, label) {
				const dispose = fn();
				harness.effects.push({ fn, label, dispose });
				return dispose;
			}
		};
		harness.module.apply(ctx);
		return harness.effects;
	};

	/** mount + вычистить микрозадачи (бутстрап и первые итерации обоих циклов). */
	harness.boot = async () => {
		harness.mount();
		await drainMicrotasks();
		return harness;
	};

	/** Запрос «десктопа» через window.fetch - то есть через нашу обёртку. */
	harness.desktopFetch = async (url, init) => {
		const p = sandbox.window.fetch(url, init);
		await drainMicrotasks();
		return p;
	};

	harness.queueCommand = (cmd) => { harness.commands.push(cmd); };
	/** Пачка событий от узла; возвращает ts, которым узел её пометил. */
	harness.queueEvents = (events) => {
		const ts = nextEventsTs();
		harness.eventsQueue.push({ ts, events });
		return ts;
	};
	/** Узел будит long-poll, как только команда легла в очередь. */
	harness.wakePoll = () => {
		if (!pollWaiter) return false;
		const w = pollWaiter;
		pollWaiter = null;
		w.cancel();
		w.resolve();
		return true;
	};

	harness.callsTo = (path) => harness.calls.filter((c) => c.path === path);
	harness.ingestsOf = (type) => harness.ingests.filter((i) => i.type === type);
	harness.rpcsOf = (method) => harness.rpcs.filter((r) => r.method === method);
	harness.draftPushes = () => harness.rpcsOf("session.updateDraft").map((r) => r.params && r.params.text);
	harness.resultFor = (id) => harness.ingestsOf("result").find((i) => i.data && i.data.id === id);

	/** Команда узла -> ответ через ingest(type=result). */
	harness.runCommand = async (cmd) => {
		harness.queueCommand(cmd);
		harness.wakePoll();
		await harness.clock.advance(5);
		await drainMicrotasks();
		return harness.resultFor(cmd.id);
	};

	/** Сколько запросов к пути сделано за окно виртуального времени. */
	harness.rateOver = async (path, ms) => {
		const before = harness.callsTo(path).length;
		await harness.clock.advance(ms);
		return harness.callsTo(path).length - before;
	};

	/** Симуляция ввода пользователя: input-событие, которое писали НЕ мы. */
	harness.userTypes = (text) => {
		harness.composer.textContent = text;
		harness.composer.dispatchEvent(new InputEventStub("input", { bubbles: true, inputType: "insertText", data: text }));
	};

	/** Привязать сессию так, как это делает десктоп: POST с id сессии в теле. */
	harness.openChat = async (sessionId, path = "/api/session/messages") => {
		await harness.desktopFetch("http://127.0.0.1:43120" + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId })
		});
	};

	return harness;
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

test("модуль грузится через __ModuleLoader__ и стартует через ctx.effect", async () => {
	const h = createHarness();
	assert.equal(h.spec.id, "dsh-phone-bridge", "id регистрации загрузчика");
	assert.equal(typeof h.spec.factory, "function", "форма загрузчика - factory, а не load");
	assert.equal(h.module.VERSION, 3, "VERSION bumped: это новое поколение клиента");
	assert.equal(typeof h.module.apply, "function");
	// inject живёт в vm-реалме, поэтому deepEqual с внешним [] не работает:
	// проверяем форму, а не прототип.
	assert.ok(Array.isArray(h.module.inject) && h.module.inject.length === 0, "inject остаётся пустым");

	// Маркеры ставятся при загрузке модуля, ДО старта движка: gui-патч
	// draftsync-desktop.js (строка 17) по __dshDraftSyncPlugin снимается с
	// вооружения, иначе рядом поднялся бы второй движок черновиков.
	assert.equal(h.sandbox.__dshDraftSyncPlugin, true, "маркер для asar-патча обязан остаться");
	assert.equal(h.sandbox.__dshPhoneBridgePlugin, true);
	assert.equal(h.effects.length, 0, "модуль не стартует сам, только через apply");
	assert.equal(h.calls.length, 0, "до apply ни одного запроса");

	await h.boot();

	assert.equal(h.effects.length, 1, "ровно один эффект");
	assert.equal(h.effects[0].label, "dsh-phone-bridge: engine");
	assert.equal(typeof h.effects[0].dispose, "function", "эффект вернул dispose");
	assert.equal(h.sandbox.__dshDraftSyncArmed, "dsh-phone-bridge-plugin", "заявка на документ");
	assert.equal(h.callsTo("/api/draft-config").length, 1, "один бутстрап конфига");
	assert.equal(h.callsTo("/api/draft-config")[0].url, "http://127.0.0.1:8460/api/draft-config");
	assert.equal(h.errors.length, 0, "без console.error");
});

test("одна обёртка fetch и одна пара XHR open/send, повторный старт не наслаивает", async () => {
	const h = createHarness();
	await h.boot();

	// Ровно одна установка каждого хука: это и есть защита от регрессии «два
	// движка в одном документе наворачивают две цепочки перехвата».
	assert.equal(h.fetchWrites, 1, "window.fetch перезаписан один раз");
	assert.notEqual(h.sandbox.window.fetch, h.originalFetch, "обёртка стоит");
	assert.equal(h.xhrOpenWrites, 1, "XHR.open перезаписан один раз");
	assert.equal(h.xhrSendWrites, 1, "XHR.send перезаписан один раз");
	assert.notEqual(h.sandbox.XMLHttpRequest.prototype.open, h.originalXhrOpen);
	assert.notEqual(h.sandbox.XMLHttpRequest.prototype.send, h.originalXhrSend);
	assert.equal(h.sandbox.__dshPhoneBridgeFetch, true, "P9-маркер fetch-хука");
	assert.equal(h.sandbox.__dshPhoneBridgeXhr, true, "P9-маркер XHR-хука");
	assert.equal(h.observers.length, 1, "один MutationObserver");

	// Темп одной цепочки: POLL_BUSY_MS = 60 -> около 10 запросов /api/events
	// за 600 мс. Два движка дали бы вдвое больше.
	const rateBefore = await h.rateOver("/api/events", 600);
	assert.ok(rateBefore >= 6 && rateBefore <= 14, "темп одной цепочки черновиков: " + rateBefore);

	// P10: эффект перезапустили БЕЗ вызова dispose (hot-reload плагина).
	// Предыдущее поколение сносится, новое вооружается - и в любой момент
	// времени слой обёрток ровно один.
	const second = h.effects[0].fn();
	await drainMicrotasks();
	assert.equal(typeof second, "function", "перезапуск эффекта вернул новый dispose");
	assert.equal(h.fetchWrites, 3, "hook -> unhook -> hook, без второго слоя");
	assert.equal(h.xhrOpenWrites, 3);
	assert.equal(h.xhrSendWrites, 3);
	assert.equal(h.observers.length, 2, "по одному наблюдателю на поколение");
	assert.equal(h.observers[0].observing, false, "наблюдатель прошлого поколения отключён");
	assert.equal(h.observers[1].observing, true, "и ровно один живой");
	assert.equal(h.ingestsOf("hello").length, 2, "по одному hello на поколение");

	// Таймеров ровно по одному на подсистему: heartbeat, poll черновиков,
	// watch (командный poll в этот момент висит в long-poll'е, поэтому его
	// паузы в списке нет).
	assert.ok(h.clock.pending() >= 3 && h.clock.pending() <= 4, "таймеры не задвоились: " + h.clock.pending());
	const rateAfter = await h.rateOver("/api/events", 600);
	assert.ok(rateAfter >= 6 && rateAfter <= 14, "темп после перезапуска тот же, цепочка одна: " + rateAfter);

	second();
	await drainMicrotasks();
	assert.equal(h.sandbox.window.fetch, h.originalFetch, "оригинал fetch восстановлен");
	assert.equal(h.sandbox.XMLHttpRequest.prototype.open, h.originalXhrOpen, "оригинал open восстановлен");
	assert.equal(h.sandbox.XMLHttpRequest.prototype.send, h.originalXhrSend, "оригинал send восстановлен");
});

test("P6: чужая обёртка поверх нашей переживает dispose", async () => {
	const h = createHarness();
	await h.boot();

	const thirdPartyFetch = function thirdParty() { return h.originalFetch.apply(null, arguments); };
	h.sandbox.window.fetch = thirdPartyFetch;
	const thirdPartyOpen = function thirdPartyOpen() {};
	h.sandbox.XMLHttpRequest.prototype.open = thirdPartyOpen;

	h.effects[0].dispose();
	await drainMicrotasks();

	// Оригиналы восстанавливаются только если наша обёртка всё ещё наверху цепочки.
	assert.equal(h.sandbox.window.fetch, thirdPartyFetch, "чужой перехватчик fetch не снесён");
	assert.equal(h.sandbox.XMLHttpRequest.prototype.open, thirdPartyOpen, "чужой open не снесён");
	// Пара open/send восстанавливается атомарно, поэтому send остаётся нашим,
	// но он инертен: observeRequest/observeResponse выходят по !alive.
	const ingestsBefore = h.ingests.length;
	const rpcBefore = h.rpcs.length;
	await h.desktopFetch("http://127.0.0.1:43120/api/session/messages", {
		method: "POST",
		body: JSON.stringify({ sessionId: SID })
	});
	assert.equal(h.ingests.length, ingestsBefore, "мёртвый движок ничего не инжестит");
	assert.equal(h.rpcs.length, rpcBefore, "и сессию не привязывает");
});

test("один heartbeat уносит оба пейлоада: session.pluginPing и ingest status", async () => {
	const h = createHarness();
	await h.boot();

	// Рукопожатие - одно на старт.
	const hellos = h.ingestsOf("hello");
	assert.equal(hellos.length, 1, "ровно один hello");
	assert.equal(hellos[0].data.version, 3, "узел положит её в pluginBridge.version");
	assert.equal(hellos[0].data.source, "dsh-phone-bridge/web");
	assert.equal(hellos[0].data.transport, "http-push");
	assert.match(hellos[0].data.pluginId, /^web-[a-z0-9]+$/);

	// Один цикл heartbeat = ОБА запроса: status (health.pluginBridge) и
	// session.pluginPing (health.plugin). Раньше их слали два разных плагина.
	assert.equal(h.ingestsOf("status").length, 1);
	assert.equal(h.rpcsOf("session.pluginPing").length, 1);
	const ping = h.rpcsOf("session.pluginPing")[0].params;
	assert.deepEqual(
		Object.keys(ping).sort(),
		["hasComposer", "hasSession", "origin", "sessionSource", "sessionId", "url"].sort(),
		"поля pluginPing ровно те, что читает узел"
	);
	assert.equal(ping.origin, "dsh-desktop", "ORIGIN_ID менять нельзя: по нему узел и PWA гасят эхо");
	assert.equal(ping.hasComposer, true);
	assert.equal(ping.hasSession, false);
	assert.equal(ping.url, "http://127.0.0.1:43120/");

	await h.clock.advance(15000);
	assert.equal(h.ingestsOf("status").length, 2, "второй status через 15 с");
	assert.equal(h.rpcsOf("session.pluginPing").length, 2, "и второй pluginPing тем же циклом");
	assert.equal(h.ingestsOf("hello").length, 1, "hello не повторяется");

	await h.clock.advance(15000);
	assert.equal(h.ingestsOf("status").length, 3);
	assert.equal(h.rpcsOf("session.pluginPing").length, 3);

	// После dispose не уходит ни один из двух.
	h.effects[0].dispose();
	const statusAfter = h.ingestsOf("status").length;
	const pingAfter = h.rpcsOf("session.pluginPing").length;
	await h.clock.advance(120000);
	assert.equal(h.ingestsOf("status").length, statusAfter, "heartbeat status остановлен");
	assert.equal(h.rpcsOf("session.pluginPing").length, pingAfter, "pluginPing остановлен");
});

test("оба контура живут: /api/events (черновики) и /api/bridge/poll (команды)", async () => {
	const h = createHarness();
	await h.boot();

	const events = h.callsTo("/api/events");
	const polls = h.callsTo("/api/bridge/poll");
	assert.equal(events.length, 1, "черновой long-poll стартовал");
	assert.equal(events[0].query, "since=0&had=1", "курсор since и had=1");
	assert.equal(events[0].method, "GET");
	assert.equal(polls.length, 1, "командный long-poll стартовал");
	assert.equal(polls[0].method, "POST");
	assert.equal(polls[0].body.wait, 25, "POLL_WAIT_S = 25");
	assert.match(polls[0].body.pluginId, /^web-/);
	assert.equal(polls[0].body.token, "tok-test", "токен в теле poll");

	// По одной цепочке на контур: два одновременных запроса означали бы, что
	// движок продублировался (главная болезнь двух плагинов в одном документе).
	assert.equal(h.maxInFlight.events, 1, "одна цепочка /api/events");
	assert.equal(h.maxInFlight.poll, 1, "одна цепочка /api/bridge/poll");

	const eventsRate = await h.rateOver("/api/events", 1000);
	const pollsRate = await h.rateOver("/api/bridge/poll", 1000);
	assert.ok(eventsRate > 1, "черновой цикл продолжается: +" + eventsRate);
	assert.ok(pollsRate > 1, "командный цикл продолжается: +" + pollsRate);
	assert.equal(h.maxInFlight.events, 1);
	assert.equal(h.maxInFlight.poll, 1);
	assert.ok(h.aborts >= 1, "черновой poll отменяется через AbortController");
});

test("session.startTurn: ответ через ingest(result), текст в композиторе, эха в черновиках нет", async () => {
	const h = createHarness();
	await h.boot();
	await h.openChat(SID);

	// Сессия привязана sniff'ом - тот же id мост считает «открытой сессией»:
	// понятие «какая сессия открыта» после слияния одно на оба движка.
	assert.ok(h.rpcsOf("session.getDraft").some((r) => r.params.sessionId === SID), "черновик сессии запрошен");

	const inputsBefore = h.composer.events.filter((e) => e.type === "input").length;
	const res = await h.runCommand({
		id: "cmd-1",
		method: "session.startTurn",
		params: { content: "привет с телефона", externalSessionId: SID }
	});

	assert.ok(res, "ответ на команду отправлен через ingest(type=result)");
	assert.equal(res.data.ok, true);
	assert.equal(res.data.result.accepted, true);
	assert.equal(res.data.result.via, "dom-composer");
	assert.equal(res.data.result.externalSessionId, SID);
	assert.equal(h.composer.textContent, "привет с телефона", "текст записан в композитор");
	assert.ok(h.composer.events.some((e) => e.type === "keydown" && e.key === "Enter"), "Enter отправлен");
	assert.ok(h.execCalls.some((c) => c.cmd === "insertText" && c.text === "привет с телефона"), "запись через insertText");

	// ИНВАРИАНТ ЭХА. Наша запись породила настоящее input-событие (в браузере
	// его породит Lexical), слушатель черновиков на нём сработал - но текст НЕ
	// ушёл на узел как черновик пользователя.
	const inputsAfter = h.composer.events.filter((e) => e.type === "input").length;
	assert.ok(inputsAfter > inputsBefore, "программная запись действительно породила input-событие");
	await h.clock.advance(2000); // с запасом больше PUSH_DELAY_MS = 600
	assert.ok(!h.draftPushes().includes("привет с телефона"), "текст хода не запушен как черновик");

	// Контроль слепоты: пользовательский ввод той же механикой уходит на узел.
	// Без этой проверки предыдущий ассерт ничего бы не доказывал.
	h.userTypes("привет с телефона!");
	await h.clock.advance(700);
	assert.ok(h.draftPushes().includes("привет с телефона!"), "пользовательский ввод пушится как черновик");
	const lastPush = h.rpcsOf("session.updateDraft").slice(-1)[0];
	assert.equal(lastPush.params.origin, "dsh-desktop");
	assert.equal(lastPush.params.sessionId, SID);
});

test("удалённый черновик из /api/events применяется к композитору и не пушится обратно", async () => {
	const h = createHarness();
	await h.boot();
	await h.openChat(SID);

	const ts = h.queueEvents([
		{ type: "draft", data: { externalSessionId: SID2, text: "чужая сессия", origin: "dsh-phone" } },
		{ type: "draft", data: { externalSessionId: SID, text: "собственное эхо", origin: "dsh-desktop" } },
		{ type: "draft", data: { externalSessionId: SID, text: "черновик с телефона", origin: "dsh-phone" } }
	]);
	// Запрос, который заберёт эти события, должен уйти УЖЕ после привязки
	// сессии: иначе его sessionEpoch не совпадёт и текст будет отброшен (P7/D9).
	// 200 мс покрывают и следующий poll (POLL_BUSY_MS = 60), который обязан
	// уйти с обновлённым курсором.
	await h.clock.advance(200);

	assert.equal(h.composer.textContent, "черновик с телефона", "применён только черновик своей сессии");
	assert.ok(
		h.callsTo("/api/events").some((c) => c.query === "since=" + ts + "&had=1"),
		"P2: курсор since сдвинут на ts ответа узла"
	);
	await h.clock.advance(2000);
	assert.ok(!h.draftPushes().includes("черновик с телефона"), "удалённый черновик не вернулся на узел");
	assert.ok(!h.draftPushes().includes("чужая сессия"), "чужая сессия не применена");
	assert.ok(!h.draftPushes().includes("собственное эхо"), "origin dsh-desktop погасил эхо");
});

test("D8: в скрытой вкладке черновик откладывается и применяется на visibilitychange", async () => {
	const h = createHarness();
	await h.boot();
	await h.openChat(SID);

	h.document.hidden = true;
	h.queueEvents([{ type: "draft", data: { externalSessionId: SID, text: "из фоновой вкладки", origin: "dsh-phone" } }]);
	await h.clock.advance(200);
	assert.notEqual(h.composer.textContent, "из фоновой вкладки", "скрытая вкладка не трогает редактор");

	// domSend в скрытой вкладке честно отказывает, а не пишет вслепую.
	const refused = await h.runCommand({ id: "cmd-hidden", method: "session.startTurn", params: { content: "не отправится" } });
	assert.equal(refused.data.ok, false);
	assert.equal(refused.data.error, "tab_hidden");
	assert.notEqual(h.composer.textContent, "не отправится");

	h.document.hidden = false;
	h.document.fireVisibility();
	await drainMicrotasks();
	assert.equal(h.composer.textContent, "из фоновой вкладки", "отложенный черновик применён после возврата");
	await h.clock.advance(2000);
	assert.ok(!h.draftPushes().includes("из фоновой вкладки"), "и не ушёл обратно как черновик");
});

test("один перехват кормит обоих потребителей: fetch и XHR", async () => {
	const h = createHarness();
	await h.boot();

	// ОДИН запрос десктопа: в теле - id сессии (потребитель «черновики»), в
	// ответе - снапшот сессий (потребитель «мост»).
	h.desktopPayloads["/api/session/messages"] = {
		sessions: [{ sessionId: "sess_dsh_a", id: "sess_dsh_a", title: "A", orderingTime: "2026-08-03T10:00:00Z" }]
	};
	await h.openChat(SID, "/api/session/messages");

	assert.ok(h.rpcsOf("session.getDraft").some((r) => r.params.sessionId === SID), "(a) сессия привязана движком черновиков");
	const sessionsIngest = h.ingestsOf("sessions");
	assert.equal(sessionsIngest.length, 1, "(b) снапшот сессий ушёл на узел");
	assert.equal(sessionsIngest[0].data.sessions[0].sessionId, "sess_dsh_a");

	// Кэш моста наполнен тем же перехватом: команда session.list отвечает им.
	const listRes = await h.runCommand({ id: "cmd-list", method: "session.list", params: {} });
	assert.equal(listRes.data.ok, true);
	assert.equal(listRes.data.result.sessions[0].sessionId, "sess_dsh_a");

	// Состояние сессии из ответа десктопа: помнится и отдаётся по session.getState.
	h.desktopPayloads["/api/session/state"] = { type: "state", data: { externalSessionId: SID, status: "idle", sourceState: "idle" } };
	await h.desktopFetch("http://127.0.0.1:43120/api/session/state", { method: "GET" });
	assert.equal(h.ingestsOf("event").length, 1, "событие синк-фида переслано на узел");
	const stateRes = await h.runCommand({ id: "cmd-state", method: "session.getState", params: { externalSessionId: SID } });
	assert.equal(stateRes.data.ok, true);
	assert.equal(stateRes.data.result.status, "idle");

	// Тот же веер через XMLHttpRequest: одна пара open/send, оба потребителя.
	const xhr = new h.XMLHttpRequestStub();
	xhr.open("GET", "http://127.0.0.1:43120/api/session/feed");
	xhr.send(null);
	xhr.fireLoad(JSON.stringify({ type: "turnEnded", data: { externalSessionId: SID2, items: [] } }));
	await drainMicrotasks();
	assert.equal(h.ingestsOf("event").length, 2, "XHR-ответ тоже переслан мостом");

	const xhr2 = new h.XMLHttpRequestStub();
	xhr2.open("POST", "http://127.0.0.1:43120/api/session/select");
	xhr2.send(JSON.stringify({ externalSessionId: SID2 }));
	await drainMicrotasks();
	assert.ok(h.rpcsOf("session.getDraft").some((r) => r.params.sessionId === SID2), "XHR-тело привязало сессию к черновикам");

	// Собственные вызовы узла не нюхаются: иначе ответы нашего же поллинга
	// /api/events замкнули бы петлю (ingest на собственный event).
	assert.equal(h.ingestsOf("event").length, 2, "наши /api/events не превратились в ingest");
	assert.ok(h.callsTo("/api/events").length >= 1, "при этом черновой поллинг шёл");
});

test("легаси-защита: старый dsh-draft-sync владеет черновиками, мост работает", async () => {
	const h = createHarness();
	h.sandbox.__dshDraftSyncArmed = "dsh-draft-sync-plugin";
	await h.boot();
	await h.clock.advance(5000);

	// Движок черновиков не поднят вовсе.
	assert.equal(h.callsTo("/api/events").length, 0, "нет второго long-poll черновиков");
	assert.equal(h.rpcsOf("session.updateDraft").length, 0, "нет второго пуша черновиков");
	assert.equal(h.rpcsOf("session.getDraft").length, 0);
	assert.equal(h.rpcsOf("session.list").length, 0, "probeSessionList тоже выключен");
	assert.equal(h.observers.length, 0, "нет второго MutationObserver");
	assert.equal(h.composer.listeners.length, 0, "input-слушатель на композитор не вешался");
	// Из клиентских таймеров живёт только heartbeat (пауза командного poll
	// может стоять рядом, черновых таймеров нет вовсе).
	assert.ok(h.clock.pending() <= 2, "черновых таймеров нет: " + h.clock.pending());

	// Мост работает целиком.
	assert.equal(h.ingestsOf("hello").length, 1, "hello отправлен");
	assert.ok(h.callsTo("/api/bridge/poll").length >= 1, "командный long-poll жив");
	assert.ok(h.ingestsOf("status").length >= 1, "heartbeat status жив");
	assert.ok(h.rpcsOf("session.pluginPing").length >= 1, "pluginPing жив");
	assert.equal(h.rpcsOf("session.pluginPing")[0].params.hasSession, false, "черновиковая диагностика честно пустая");
	assert.equal(h.rpcsOf("session.pluginPing")[0].params.hasComposer, false, "композитор не отслеживается - честно false");

	// Одно громкое предупреждение с путями миграции.
	assert.equal(h.warnings.length, 1, "ровно одно предупреждение");
	const warn = h.warnings[0];
	assert.match(warn, /dsh-draft-sync/);
	assert.match(warn, /dsh\.profile\.bundles/);
	assert.match(warn, /node_modules/);
	assert.match(warn, /ДВАЖДЫ/);
	assert.equal(h.sandbox.__dshDraftSyncArmed, "dsh-phone-bridge-plugin", "документ заявлен за нами");

	// Отправка хода с телефона работает и без движка черновиков: composerEl()
	// падает на свежий querySelector.
	const legacyTurn = await h.runCommand({
		id: "cmd-legacy",
		method: "session.startTurn",
		params: { content: "ход в легаси-режиме" }
	});
	assert.equal(legacyTurn.data.ok, true);
	assert.equal(h.composer.textContent, "ход в легаси-режиме");
	await h.clock.advance(2000);
	assert.equal(h.rpcsOf("session.updateDraft").length, 0, "черновики так и не включились");
});

test("P3/P9: один наблюдатель, суженный до контейнера, и одна цепочка ретраев", async () => {
	const h = createHarness({ composer: false });
	await h.boot();

	assert.equal(h.observers.length, 1, "ровно один MutationObserver");
	const mo = h.observers[0];
	assert.equal(mo.targets[0].target, h.document.documentElement, "пока композитора нет - наблюдаем за документом");

	// Шквал мутаций не плодит таймеры: debounce схлопывает их в одну проверку.
	for (let i = 0; i < 50; i++) mo.fire();
	assert.ok(h.clock.pending() <= 4, "таймеры не размножились: " + h.clock.pending());

	const queriesBefore = h.document.querySelectorCalls;
	await h.clock.advance(10000);
	const queries = h.document.querySelectorCalls - queriesBefore;
	// Одна цепочка ретраев по WATCH_RETRY_MS=800 даёт ~12 проверок за 10 с.
	// Фан-аут (дефект D5/P3) дал бы сотни.
	assert.ok(queries >= 8 && queries <= 40, "одна цепочка ретраев, а не веер: " + queries);
	assert.ok(h.clock.pending() <= 4, "после 10 с простоя таймеров не накопилось: " + h.clock.pending());

	// Как только композитор появился, наблюдатель сужается до его контейнера,
	// а слушатель заводится ровно один (P9).
	const composer = h.makeComposer();
	h.composer = composer;
	await h.clock.advance(900);
	assert.ok(mo.targets.some((x) => x.target === h.document.container), "наблюдатель сужен до контейнера композитора");
	assert.equal(composer.listeners.length, 1, "P9: один input-слушатель на композиторе");
	assert.equal(composer.listeners[0].type, "input");
	assert.equal(composer.listeners[0].capture, true, "слушатель в capture-фазе, как было в draft-sync");
});

test("честные возможности и честные отказы web-половины", async () => {
	const h = createHarness();
	await h.boot();

	// Две команды одним long-poll'ом: узел отдаёт до 8 штук за раз, и клиент
	// обязан выполнить и ответить на каждую независимо.
	h.queueCommand({ id: "caps", method: "runtime.getCapabilities", params: {} });
	h.queueCommand({ id: "unknown", method: "session.steer", params: {} });
	h.wakePoll();
	await h.clock.advance(5);
	await drainMicrotasks();

	const caps = h.resultFor("caps").data.result;
	assert.equal(caps.runtime, "dsh");
	assert.equal(caps.revision, 5);
	// capabilities - массив из vm-реалма: копируем во внешний, чтобы deepEqual
	// не спотыкался о прототип.
	const supported = Array.from(caps.capabilities).filter((c) => c.supported).map((c) => c.capabilityId).sort();
	assert.deepEqual(supported, ["runtime.config", "session.send_message"], "только то, что web-половина реально умеет");
	assert.equal(caps.metadata.readOnly, false, "композитор есть -> не readOnly");
	assert.equal(caps.metadata.pluginVersion, 3);
	assert.equal(caps.metadata.source, "dsh-phone-bridge/web");
	// Черновики - node-local RPC (session.updateDraft/getDraft), поэтому в
	// документе возможностей их нет и быть не должно.
	assert.ok(!Array.from(caps.capabilities).some((c) => /draft/i.test(c.capabilityId)), "черновики не меняют документ возможностей");

	const unknownRes = h.resultFor("unknown");
	assert.ok(unknownRes, "вторая команда того же long-poll тоже получила ответ");
	assert.equal(unknownRes.data.ok, false);
	assert.equal(unknownRes.data.error, "unsupported_method:session.steer");

	// session_mismatch: id сессии не совпал с открытой в десктопе.
	await h.openChat(SID);
	const mismatch = await h.runCommand({
		id: "mismatch",
		method: "session.startTurn",
		params: { content: "не туда", externalSessionId: SID2 }
	});
	assert.equal(mismatch.data.error, "session_mismatch");
	assert.notEqual(h.composer.textContent, "не туда", "в чужой чат не пишем");

	// content_required и create_unsupported_in_web_half
	const empty = await h.runCommand({ id: "empty", method: "session.startTurn", params: { content: "" } });
	assert.equal(empty.data.error, "content_required");
	const created = await h.runCommand({ id: "create", method: "session.createAndStart", params: { content: "новая" } });
	assert.equal(created.data.error, "create_unsupported_in_web_half");

	// composer_not_found - на стенде без композитора.
	const h2 = createHarness({ composer: false });
	await h2.boot();
	const noComposer = await h2.runCommand({ id: "nocomposer", method: "session.startTurn", params: { content: "некуда" } });
	assert.equal(noComposer.data.error, "composer_not_found");
	const caps2 = await h2.runCommand({ id: "caps2", method: "session.getCapabilities", params: {} });
	assert.equal(caps2.data.ok, true, "session.getCapabilities тоже отвечает");
	assert.equal(caps2.data.result.metadata.readOnly, true, "без композитора честно readOnly");

	// active_session_unknown - открытая сессия неизвестна, а телефон её назвал.
	const h3 = createHarness();
	await h3.boot();
	const unknownSession = await h3.runCommand({
		id: "unknown-session",
		method: "session.startTurn",
		params: { content: "в неизвестную", externalSessionId: SID }
	});
	assert.equal(unknownSession.data.error, "active_session_unknown");
});

test("dispose: хуки сняты, ARM-ключ очищён, оба контура стоят, таймеров не осталось", async () => {
	const h = createHarness();
	await h.boot();
	await h.openChat(SID);
	await h.clock.advance(1000);

	assert.ok(h.clock.pending() > 0, "до dispose таймеры живы");
	assert.equal(h.observers.length, 1);
	assert.ok(h.composer.listeners.length >= 1, "input-слушатель стоит");
	assert.ok(h.document.listeners.some((l) => l.type === "visibilitychange"), "visibilitychange привязан");

	const callsBefore = h.calls.length;
	const dispose = h.effects[0].dispose;
	dispose();
	await drainMicrotasks();

	// Транспорт возвращён хозяину.
	assert.equal(h.sandbox.window.fetch, h.originalFetch);
	assert.equal(h.sandbox.XMLHttpRequest.prototype.open, h.originalXhrOpen);
	assert.equal(h.sandbox.XMLHttpRequest.prototype.send, h.originalXhrSend);
	assert.equal(h.sandbox.__dshPhoneBridgeFetch, false, "P9-маркер сброшен");
	assert.equal(h.sandbox.__dshPhoneBridgeXhr, false);

	// Заявка на документ снята.
	assert.ok(!("__dshDraftSyncArmed" in h.sandbox) || h.sandbox.__dshDraftSyncArmed == null, "ARM-ключ удалён");

	// Слушатели и наблюдатель освобождены (P9/P3).
	assert.equal(h.composer.listeners.length, 0, "input-слушатель снят с композитора");
	assert.equal(h.observers[0].observing, false, "MutationObserver отключён");
	assert.ok(h.observers[0].disconnects >= 1);
	assert.equal(h.document.listeners.filter((l) => l.type === "visibilitychange").length, 0, "visibilitychange отвязан");

	// Ни одного живого таймера: после teardown нечему тикать.
	assert.equal(h.clock.pending(), 0, "все таймеры клиента очищены");

	// И время можно мотать сколько угодно - запросов больше нет.
	await h.clock.advance(300000);
	assert.equal(h.calls.length, callsBefore, "после dispose ни одного запроса");

	// P1: dispose идемпотентен.
	dispose();
	await drainMicrotasks();
	assert.equal(h.calls.length, callsBefore);
	assert.equal(h.clock.pending(), 0);
});

test("P1/P2: перезапуск после dispose перечитывает конфиг, а не наследует его", async () => {
	const h = createHarness();
	await h.boot();
	await h.openChat(SID);
	const firstConfig = h.callsTo("/api/draft-config").length;
	const firstPluginId = h.ingestsOf("hello")[0].data.pluginId;

	h.effects[0].dispose();
	await drainMicrotasks();

	// Новый запуск того же модуля: конфиг читается заново, состояние сброшено.
	h.effects = [];
	h.mount();
	await drainMicrotasks();

	assert.equal(h.callsTo("/api/draft-config").length, firstConfig + 1, "конфиг перечитан");
	assert.equal(h.ingestsOf("hello").length, 2, "новое рукопожатие нового поколения");
	assert.equal(h.ingestsOf("hello")[1].data.pluginId, firstPluginId, "pluginId стабилен на экземпляр вкладки");
	assert.equal(h.rpcsOf("session.pluginPing").slice(-1)[0].params.hasSession, false, "сессия сброшена (P1)");
	assert.equal(h.callsTo("/api/events").slice(-1)[0].query, "since=0&had=1", "курсор since сброшен");
	assert.equal(h.observers.filter((o) => o.observing).length, 1, "живой наблюдатель один");
	const rate = await h.rateOver("/api/events", 600);
	assert.ok(rate >= 6 && rate <= 14, "цепочка черновиков снова одна: " + rate);
});

test("P2: провал long-poll не превращается в горячий цикл и ведёт к ребутстрапу", async () => {
	const h = createHarness();
	await h.boot();

	const pollsBefore = h.callsTo("/api/bridge/poll").length;
	const eventsBefore = h.callsTo("/api/events").length;
	const configBefore = h.callsTo("/api/draft-config").length;

	// Узел «лёг» (401 на оба контура). Раньше web-половина моста этого не
	// замечала вовсе: post() гасит ошибку и возвращает null, цепочка сразу шла
	// по кругу и долбила узел без задержки.
	h.failResponses["/api/bridge/poll"] = { ok: false, status: 401, body: { ok: false, error: "unauthorized" } };
	h.failResponses["/api/events"] = { ok: false, status: 401, body: { ok: false, error: "unauthorized" } };

	await h.clock.advance(2000);
	assert.ok(h.callsTo("/api/bridge/poll").length - pollsBefore <= 1, "командный poll отступил на POLL_RETRY_MS, а не долбит");
	assert.ok(h.callsTo("/api/events").length - eventsBefore <= 1, "черновой poll встал на ребутстрап");

	await h.clock.advance(30000);
	assert.ok(h.callsTo("/api/draft-config").length > configBefore, "после провалов конфиг перечитан (ребутстрап)");
	assert.ok(h.calls.length < 250, "никакого горячего цикла: всего " + h.calls.length + " запросов");

	// Узел вернулся - оба контура поднимаются сами, без перезапуска движка.
	h.failResponses = {};
	await h.clock.advance(15000);
	const pollsHealed = h.callsTo("/api/bridge/poll").length;
	const eventsHealed = h.callsTo("/api/events").length;
	await h.clock.advance(1000);
	assert.ok(h.callsTo("/api/bridge/poll").length > pollsHealed, "командный контур ожил");
	assert.ok(h.callsTo("/api/events").length > eventsHealed, "черновой контур ожил");
	assert.equal(h.maxInFlight.events, 1, "и по-прежнему один");
	assert.equal(h.maxInFlight.poll, 1);
});

test("P8: заявленный asar-патчем документ забирается через его stop-хук", async () => {
	const h = createHarness();
	let stopped = 0;
	h.sandbox.__dshDraftSyncArmed = "dsh-desktop-gui-patch";
	h.sandbox.__dshDesktopDraftSyncStop = () => { stopped++; };

	await h.boot();

	assert.equal(stopped, 1, "gui-патч снят с вооружения нашим stop-вызовом");
	assert.equal(h.sandbox.__dshDesktopDraftSyncStop, null, "stop-хук обнулён");
	assert.equal(h.sandbox.__dshDraftSyncArmed, "dsh-phone-bridge-plugin", "документ перешёл к плагину");
	// Черновики в этом сценарии наши: движок поднят целиком.
	assert.equal(h.callsTo("/api/events").length, 1, "черновой контур работает");
	assert.equal(h.warnings.length, 0, "предупреждение только для легаси-плагина");
	const rate = await h.rateOver("/api/events", 600);
	assert.ok(rate > 1, "и продолжается: +" + rate);
});

test("D4: служебные каналы не угоняют привязанную сессию", async () => {
	const h = createHarness();
	await h.boot();

	// POST c id сессии в теле, но на служебный канал: это не «пользователь
	// открыл чат», поэтому сессию не привязываем (иначе список/переименование
	// уводили бы черновик в чужой чат).
	await h.openChat(SID, "/api/session/list");
	assert.equal(h.rpcsOf("session.getDraft").length, 0, "session/list не привязывает сессию");

	// То же с хвостовым слэшем: apiPathOf нормализует путь перед сравнением.
	await h.openChat(SID, "/api/session/title/");
	assert.equal(h.rpcsOf("session.getDraft").length, 0, "session/title/ тоже служебный");

	// Обычный рабочий вызов сессию привязывает.
	await h.openChat(SID2, "/api/session/messages");
	assert.ok(h.rpcsOf("session.getDraft").some((r) => r.params.sessionId === SID2), "session/messages привязывает");

	// GET без тела не привязывает ничего.
	await h.desktopFetch("http://127.0.0.1:43120/api/session/messages?sessionId=" + SID, { method: "GET" });
	assert.ok(!h.rpcsOf("session.getDraft").some((r) => r.params.sessionId === SID), "GET-запрос не сигнал открытия");
});

test("черновик узла подтягивается при привязке сессии и не затирает локальный текст", async () => {
	const h = createHarness();
	h.draftResult = { text: "черновик из узла", origin: "dsh-phone", updatedAt: 1700000000000 };
	await h.boot();
	await h.openChat(SID);

	assert.equal(h.composer.textContent, "черновик из узла", "пустой композитор принял черновик узла");
	await h.clock.advance(2000);
	assert.ok(!h.draftPushes().includes("черновик из узла"), "принятый черновик не ушёл обратно");

	// Локальное содержимое важнее удалённого: ничего не затираем.
	const h2 = createHarness();
	h2.draftResult = { text: "черновик из узла", origin: "dsh-phone", updatedAt: 1700000000000 };
	await h2.boot();
	h2.composer.textContent = "локальный текст";
	await h2.openChat(SID);
	assert.equal(h2.composer.textContent, "локальный текст", "локальный текст не затёрт");
	await h2.clock.advance(700);
	assert.ok(h2.draftPushes().includes("локальный текст"), "а сам он запушен как черновик десктопа");

	// Собственное эхо из узла (origin dsh-desktop) не применяется.
	const h3 = createHarness();
	h3.draftResult = { text: "моё же эхо", origin: "dsh-desktop", updatedAt: 1700000000000 };
	await h3.boot();
	await h3.openChat(SID);
	assert.equal(h3.composer.textContent, "", "эхо своего же origin не применено");
});
