window.__ModuleLoader__.load({
	id: "dsh-phone-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// P8: маркер для gui-патча dsh-phone/gui/draftsync-desktop.js (строка 17):
		// увидев его, патч снимается с вооружения и не поднимает второй движок
		// черновиков рядом с плагином. Ставится сразу при загрузке модуля, ДО старта.
		window.__dshDraftSyncPlugin = true;
		// маркер этого плагина: две копии движка в одном документе не вооружаются
		window.__dshPhoneBridgePlugin = true;
		//#region engine

		// =====================================================================
		// Браузерная половина dsh-phone-bridge, поколение 3.
		//
		// Один файл делает две работы, которые раньше жили в двух плагинах
		// (dsh-phone-bridge и dsh-draft-sync) и дублировали друг друга в одном
		// документе: два бутстрапа /api/draft-config, две цепочки обёрток
		// window.fetch и XMLHttpRequest, два heartbeat'а, два MutationObserver,
		// два long-poll'а и два независимых писателя в [data-composer-input].
		//
		// Слои (каждый - ровно один экземпляр на документ):
		//   0. константы;
		//   1. общий слой узла: конфиг/токен, post, ingest, nodeRequest,
		//      ОДИН heartbeat на 15 с (RPC session.pluginPing + ingest status),
		//      один engineEpoch/sessionEpoch, один pluginId;
		//   2. общий слой перехвата: ОДНА обёртка fetch и ОДНА пара
		//      XHR open/send, каждый вызов раздаётся обоим потребителям;
		//   3. общий слой композитора: одна запись в Lexical, поверх неё
		//      applyComposerText (черновик с телефона) и domSend (ход с телефона);
		//   4. движок черновиков (бывший dsh-draft-sync, харднинг P1..P10, D8/D9);
		//   5. движок моста (hello, long-poll команд, execCommand, answer);
		//   6. один жизненный цикл: startEngine() -> dispose.
		//
		// Никаких import/export и никаких require соседних файлов: DSH отдаёт
		// этот файл как /plugins/dsh-phone-bridge/client.js и материализует
		// через window.__ModuleLoader__.load({...}) с ленивой CJS-фабрикой.
		// =====================================================================

		// =====================================================================
		// 0. Константы
		// =====================================================================
		var VERSION = 3;              // новое поколение клиента: черновики теперь внутри моста
		var SOURCE = "dsh-phone-bridge/web";
		var NODE_PORT = 8460;
		// :8460 - основной порт узла (http, либо https когда включён TLS).
		// :8461 - loopback-only http, который узел поднимает при TLS, чтобы
		// плагин не терял бутстрап. Перебираем оба, первый живой wins.
		var NODE_BASES = [
			"http://127.0.0.1:" + NODE_PORT,
			"http://127.0.0.1:" + (NODE_PORT + 1),
			"http://localhost:" + NODE_PORT,
			"http://localhost:" + (NODE_PORT + 1)
		];
		var HEARTBEAT_MS = 15000;     // ОДИН интервал на обе задачи
		var RETRY_MS = 5000;          // узел не ответил: повторный бутстрап
		var MAX_PUSH_BYTES = 512 * 1024; // потолок тела push'а на узел

		// --- черновики ---
		// ORIGIN_ID менять нельзя: по нему узел и PWA гасят эхо черновика
		// (dsh-phone/web/draftsync.js::draftSyncDecision сравнивает origin).
		var ORIGIN_ID = "dsh-desktop";
		var PUSH_DELAY_MS = 600;      // debounce пуша черновика
		var POLL_BUSY_MS = 60;        // активный темп: вкладка видима и пользователь рядом
		var POLL_IDLE_MS = 900;       // P2: idle-backoff (скрытая вкладка / нет composer / простой)
		var GRACE_MS = 2500;          // пользователь печатает - удалённый черновик не применяем
		var MAX_TEXT = 10000;
		var WATCH_RETRY_MS = 800;
		var WATCH_CHECK_MS = 1500;    // P3: единственный «health tick» проверки composer
		var MUTATION_DEBOUNCE_MS = 120;
		var IDLE_AFTER_MS = 30000;

		// --- мост ---
		var POLL_WAIT_S = 25;         // long-poll команд: меньше серверного потолка 55 с
		var POLL_RETRY_MS = 3000;     // пауза после провала poll, чтобы не долбить узел
		var POLL_FAIL_LIMIT = 3;      // столько провалов подряд ведут к ребутстрапу конфига
		var SNIFF_DEBOUNCE_MS = 250;  // схлопываем всплеск одинаковых снапшотов
		var SESSIONS_FRESH_MS = 300000; // снапшот сессий старше 5 минут уже не ответ
		var STATE_CACHE_MAX = 64;     // граница роста кэша состояний

		// --- P8: заявка на документ (одна на все варианты установки) ---
		// Ключ остаётся прежним, чтобы asar-патч gui/draftsync-desktop.js
		// по-прежнему снимался с вооружения. Значение - наше, мостовое.
		var ARM_KEY = "__dshDraftSyncArmed";
		var ARM_VALUE = "dsh-phone-bridge-plugin";
		// Значение старого отдельного плагина: если документ уже вооружён им,
		// черновики принадлежат ему (см. legacyDrafts в startEngine).
		var LEGACY_ARM_VALUE = "dsh-draft-sync-plugin";

		// =====================================================================
		// Состояние. Сгруппировано по слоям; всё оно сбрасывается в resetState()
		// (P1: перезапуск движка не должен наследовать чужой конфиг и сессию).
		// =====================================================================

		// --- слой 1: узел ---
		var cfg = null;               // {token, port, version} с /api/draft-config
		var nodeBase = null;
		var alive = false;
		var engineEpoch = 0;          // P1/P4/D9: инкремент на каждый stop -> async-хвосты отбрасываются
		var sessionEpoch = 0;         // P7: инкремент на каждую смену привязки сессии
		var bootstrapping = false;    // P2: single-flight fetchConfig
		var bootHandle = 0;           // P2: id отложенного bootstrap
		var heartbeatTimer = 0;
		var heartbeatEpoch = 0;       // P4: ровно один интервал на поколение движка
		var helloSent = false;        // рукопожатие моста - одно на поколение
		var pluginId = "web-" + Math.random().toString(36).slice(2, 10);
		var legacyDrafts = false;     // документ уже вооружён старым dsh-draft-sync
		var activeStop = null;        // P10: dispose предыдущего запуска эффекта
		var readyHandler = null;      // слушатель DOMContentLoaded текущего поколения

		// --- слой 2: перехват транспорта ---
		var FETCH_KEY = "__dshPhoneBridgeFetch";
		var XHR_KEY = "__dshPhoneBridgeXhr";
		var originalFetch = null;
		var wrappedFetch = null;
		var fetchHooked = false;
		var xhrOpen = null;
		var xhrSend = null;
		var wrappedXhrOpen = null;
		var wrappedXhrSend = null;
		var xhrHooked = false;

		// --- слой 3: композитор ---
		var el = null;                // отслеживаемый [data-composer-input]
		var programmaticWrite = false;// ИНВАРИАНТ ЭХА: прямо сейчас пишем мы, не пользователь
		var applyingRemote = false;   // применяется удалённый черновик
		var pendingRemoteText = null; // D8: текст, отложенный пока вкладка скрыта
		var lastPushedText = null;
		var lastLocalInput = 0;       // ms epoch последнего нажатия клавиши здесь
		var pushTimer = 0;
		var attachedEls = [];         // P9: все узлы, на которые вешали слушатель
		var visibilityBound = false;

		// --- слой 4: черновики ---
		var sessionId = null;         // harness external id, например session-<uuid>
		var since = 0;                // курсор /api/events
		var pollAbort = null;
		var pollHandle = 0;           // P2: id таймера poll-цепочки черновиков
		var pollRunning = false;      // P2: живёт ли цепочка
		var watchHandle = 0;          // P3: единственный retry-таймер поиска composer
		var watchPending = false;     // P3: debounce мутаций
		var mo = null;
		var moTarget = null;          // P3: за чем сейчас наблюдаем
		var lastSniffAt = 0;
		var lastActivityAt = 0;
		var adoptedBy = "";           // "sniff" | "activity" | "list"
		var listProbedAt = 0;
		var listProbeInFlight = false;// P7: один session.list за раз

		// --- слой 5: мост ---
		var bridgePolling = false;    // живёт ли цепочка long-poll команд
		var bridgePollHandle = 0;     // id таймера паузы между итерациями
		var bridgeFailCount = 0;      // провалы poll подряд
		var lastSessionsSig = "";
		var lastSessionsAt = 0;
		var sessionsCache = null;     // {sessions, at} - основа ответа session.list
		var stateCache = {};          // externalSessionId -> {state, at}
		var activeExternalId = null;  // какая сессия открыта в десктопе прямо сейчас

		function log() {
			try {
				var args = Array.prototype.slice.call(arguments);
				args.unshift("[dsh-phone-bridge]");
				console.log.apply(console, args);
			} catch (e) {}
		}

		function now() {
			return Date.now();
		}

		// =====================================================================
		// 1. Общий слой узла: один бутстрап, один транспорт, один heartbeat
		// =====================================================================

		// P2: перебираем базы, первая живая wins. Single-flight обеспечивает
		// bootstrap() через флаг bootstrapping, поэтому цепочка ровно одна.
		function fetchConfig() {
			var i = 0;
			function attempt() {
				if (!alive) return Promise.resolve(null);
				if (i >= NODE_BASES.length) return Promise.resolve(null);
				var base = NODE_BASES[i++];
				return fetch(base + "/api/draft-config", { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (j) {
						if (!alive) return null;
						if (j && j.ok && j.token) {
							nodeBase = base;
							return j;
						}
						return attempt();
					})
					.catch(function () { return attempt(); });
			}
			return attempt();
		}

		// P2: единственный отложенный бутстрап; повторный вызов переносит его,
		// а не плодит вторую цепочку.
		function scheduleBootstrap(delay) {
			if (!alive) return;
			if (bootHandle) clearTimeout(bootHandle);
			var myEpoch = engineEpoch;
			bootHandle = setTimeout(function () {
				bootHandle = 0;
				if (!alive || myEpoch !== engineEpoch) return;
				bootstrap();
			}, delay);
		}

		function bootstrap() {
			if (!alive) return;
			if (cfg && nodeBase) { onNodeReady(); return; }
			if (bootstrapping) return;
			bootstrapping = true;
			var myEpoch = engineEpoch;
			fetchConfig().then(function (j) {
				bootstrapping = false;
				if (!alive || myEpoch !== engineEpoch) return;
				if (!j) {
					// Диагностика из старой web-половины моста: без неё в консоли
					// десктопа тишина, а телефон просто «не видит» DSH.
					log("узел dsh-phone не найден, повтор через " + RETRY_MS + " мс");
					scheduleBootstrap(RETRY_MS);
					return;
				}
				cfg = j;
				log("привязан к узлу dsh-phone", nodeBase, "v" + (j.version || "?"), "pluginId", pluginId);
				onNodeReady();
			}).catch(function () {
				bootstrapping = false;
				if (alive && myEpoch === engineEpoch) scheduleBootstrap(RETRY_MS);
			});
		}

		// Узел найден: поднимаем оба контура. Вызывается из bootstrap, в том
		// числе повторно после ребутстрапа (ротация токена, перезапуск узла),
		// поэтому каждый старт защищён своим guard'ом.
		function onNodeReady() {
			if (!alive || !cfg || !nodeBase) return;
			// Рукопожатие: узел запоминает версию/источник (health.pluginBridge)
			// и считает канал живым. Одно на поколение движка.
			if (!helloSent) {
				helloSent = true;
				ingest("hello", {
					version: VERSION, source: SOURCE, transport: "http-push",
					pluginId: pluginId, capabilities: capabilitiesDoc(), ts: Date.now()
				});
			}
			startHeartbeat(engineEpoch);
			if (sessionId) { loadExistingDraft(); pushDraft(false); }
			if (!legacyDrafts) startDraftPoll();
			startBridgePoll();
		}

		// push на узел (транспорт моста: /api/bridge/ingest и /api/bridge/poll)
		function post(path, body) {
			if (!alive || !cfg || !nodeBase) return Promise.resolve(null);
			var text;
			try { text = JSON.stringify(body); } catch (e) { return Promise.resolve(null); }
			if (text.length > MAX_PUSH_BYTES) return Promise.resolve(null);
			return fetch(nodeBase + path, {
				method: "POST",
				headers: { "content-type": "application/json", "x-dsh-token": cfg.token },
				body: text
			}).then(function (r) { return r.json().catch(function () { return null; }); })
				.catch(function () { return null; });
		}

		function ingest(type, data) {
			// P5-style guard: без конфига нечего отправлять, а rejection наружу
			// не выпускаем (вызывающий код ветвится только по полезной нагрузке).
			if (!alive || !cfg || !nodeBase) return Promise.resolve(null);
			return post("/api/bridge/ingest", { token: cfg.token, type: type, data: data });
		}

		// P5: RPC узла (черновики и диагностика) - тот же путь /api/rpc и тот же
		// заголовок x-dsh-token, что и в dsh-draft-sync. Никогда не строим запрос
		// без конфига и базы (иначе был бы вызов на "null/api/rpc" либо
		// синхронный TypeError на cfg.token) и не выпускаем rejection.
		function nodeRequest(method, params) {
			if (!alive || !cfg || !nodeBase) return Promise.resolve(null);
			try {
				return fetch(nodeBase + "/api/rpc", {
					method: "POST",
					headers: { "content-type": "application/json", "x-dsh-token": cfg.token },
					body: JSON.stringify({ token: cfg.token, method: method, params: params })
				})
					.then(function (r) { return r.ok ? r.json() : null; })
					.catch(function () { return null; });
			} catch (e) {
				return Promise.resolve(null);
			}
		}

		// --- heartbeat: ОДИН интервал на обе задачи ---
		// 1) RPC session.pluginPing - диагностика черновиков: узел обслуживает её
		//    локально (server.rs::rpc, hub.set_plugin_ping) и отдаёт в /api/health
		//    полем "plugin". Без неё дашборд теряет ответ на вопросы «привязана ли
		//    сессия» и «найден ли композитор».
		// 2) ingest type=status - живость канала моста (health.pluginBridge).
		// Оба пейлоада обязаны уходить одним циклом: раньше их слали два плагина.
		function heartbeat() {
			if (!alive || !cfg || !nodeBase) return;
			ingest("status", { connected: true, source: SOURCE, version: VERSION, ts: Date.now() });
			probeSessionList();
			nodeRequest("session.pluginPing", {
				origin: ORIGIN_ID,
				hasSession: !!sessionId,
				sessionId: sessionId || "",
				sessionSource: adoptedBy || "",
				hasComposer: composerAttached(),
				url: String(location.href || "").slice(0, 200)
			}).catch(function () {});
		}

		// P4: ровно один интервал на поколение движка. Эпоха фиксируется на
		// старте, поэтому интервал, переживший свой движок, гасит себя сам.
		function startHeartbeat(epoch) {
			if (!alive || epoch !== engineEpoch) return;
			stopHeartbeat();
			heartbeatEpoch = epoch;
			heartbeat();
			heartbeatTimer = setInterval(function () {
				if (!alive || heartbeatEpoch !== engineEpoch) { stopHeartbeat(); return; }
				heartbeat();
			}, HEARTBEAT_MS);
		}

		function stopHeartbeat() {
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
			heartbeatEpoch = 0;
		}

		// =====================================================================
		// 2. Общий слой перехвата: ОДНА обёртка fetch и ОДНА пара XHR open/send
		//
		// Каждый наблюдаемый вызов раздаётся обоим потребителям:
		//   (a) черновики - привязка активной сессии по телу служебного POST;
		//   (b) мост - снапшоты сессий и состояния из JSON-ответов.
		// P9/P6: обёртки учитываются, а оригинал восстанавливается только если
		// наша обёртка всё ещё наверху цепочки (поздний перехватчик не сношаем).
		// =====================================================================

		// Собственные вызовы узла не нюхаются: иначе ответы нашего же поллинга
		// (/api/events, /api/bridge/poll) и наши push'и попали бы второму
		// потребителю и замкнули петлю. Трафик десктопа идёт на другой origin,
		// поэтому он нюхается целиком.
		function isOwnNodeCall(url) {
			if (!url) return false;
			var u = String(url);
			for (var i = 0; i < NODE_BASES.length; i++) {
				if (u.indexOf(NODE_BASES[i]) === 0) return true;
			}
			return false;
		}

		// потребитель (a): тело запроса. Идентификатор сессии в теле POST -
		// сигнал «пользователь открыл этот чат».
		function observeRequest(url, method, body) {
			if (!alive || isOwnNodeCall(url)) return;
			if (String(url).indexOf("/api/") < 0) return;
			if (String(method || "GET").toUpperCase() !== "POST") return;
			if (typeof body !== "string" || !body) return;
			trackFromUrlAndBody(url, body);
		}

		// потребитель (b): JSON-ответ, прочитанный из Response (fetch)
		function observeResponse(url, res) {
			if (!alive || isOwnNodeCall(url)) return;
			try {
				var ct = (res && res.headers && res.headers.get && res.headers.get("content-type")) || "";
				if (String(ct).indexOf("json") < 0) return;
				if (!res || typeof res.clone !== "function") return;
				res.clone().json().then(function (j) { forward(url, j); }).catch(function () {});
			} catch (e) {}
		}

		// потребитель (b): JSON-ответ, прочитанный из XMLHttpRequest
		function observeXhrResponse(xhr, url) {
			if (!alive || isOwnNodeCall(url)) return;
			try {
				var ct = (xhr.getResponseHeader && xhr.getResponseHeader("content-type")) || "";
				if (String(ct).indexOf("json") < 0) return;
				forward(url, JSON.parse(xhr.responseText));
			} catch (e) {}
		}

		function hookFetch() {
			if (fetchHooked) return;
			var of = window.fetch;
			if (typeof of !== "function") return;
			originalFetch = of;
			wrappedFetch = function (input, init) {
				var url = "";
				try {
					if (typeof input === "string") url = input;
					else if (input && input.url) url = String(input.url);
					observeRequest(url, init && init.method, init && init.body);
				} catch (e) {}
				var p = of.apply(window, arguments);
				// вторая половина веера: снапшоты из ответа (мост)
				try {
					if (p && typeof p.then === "function") {
						p.then(function (res) { observeResponse(url, res); }).catch(function () {});
					}
				} catch (e) {}
				return p;
			};
			window[FETCH_KEY] = true;
			window.fetch = wrappedFetch;
			fetchHooked = true;
		}

		function unhookFetch() {
			window[FETCH_KEY] = false;
			// восстанавливаем только когда наша обёртка всё ещё наверху цепочки;
			// поздний перехватчик (например, слой соединений DSH) остаётся цел
			if (fetchHooked && originalFetch !== null && window.fetch === wrappedFetch) {
				window.fetch = originalFetch;
			}
			fetchHooked = false;
			originalFetch = null;
			wrappedFetch = null;
		}

		// --- XHR: GUI может говорить через XMLHttpRequest вместо window.fetch,
		// поэтому покрываем оба транспорта одной парой обёрток ---
		function hookXhr() {
			if (xhrHooked) return;
			if (typeof window.XMLHttpRequest !== "function") return;
			try {
				var open = window.XMLHttpRequest.prototype.open;
				var send = window.XMLHttpRequest.prototype.send;
				if (typeof open !== "function" || typeof send !== "function") return;
				wrappedXhrOpen = function (method, url) {
					try {
						this.__dshBridgeUrl = String(url || "");
						this.__dshBridgeMethod = String(method || "GET");
					} catch (e) {}
					return open.apply(this, arguments);
				};
				wrappedXhrSend = function (body) {
					var self = this;
					var url = "";
					var method = "";
					try {
						url = self.__dshBridgeUrl || "";
						method = self.__dshBridgeMethod || "GET";
					} catch (e) {}
					// (a) черновики: id сессии в теле
					try { observeRequest(url, method, body); } catch (e) {}
					// (b) мост: снапшот из ответа
					try {
						if (typeof self.addEventListener === "function") {
							self.addEventListener("load", function () { observeXhrResponse(self, url); });
						}
					} catch (e) {}
					return send.apply(this, arguments);
				};
				// присваиваем парой и только когда обе обёртки созданы, чтобы
				// частичный сбой не оставил open захуканным без send
				xhrOpen = open;
				xhrSend = send;
				window.XMLHttpRequest.prototype.open = wrappedXhrOpen;
				window.XMLHttpRequest.prototype.send = wrappedXhrSend;
				window[XHR_KEY] = true;
				xhrHooked = true;
			} catch (e) {
				xhrOpen = null;
				xhrSend = null;
				wrappedXhrOpen = null;
				wrappedXhrSend = null;
				xhrHooked = false;
			}
		}

		function unhookXhr() {
			window[XHR_KEY] = false;
			if (!xhrHooked) {
				xhrOpen = null;
				xhrSend = null;
				wrappedXhrOpen = null;
				wrappedXhrSend = null;
				return;
			}
			xhrHooked = false;
			try {
				// P6: восстанавливаем пару, только пока наши обёртки наверху
				// цепочки. Если кто-то обернул после нас, его обёртка остаётся.
				var topIsOurs = window.XMLHttpRequest.prototype.open === wrappedXhrOpen &&
					window.XMLHttpRequest.prototype.send === wrappedXhrSend;
				if (topIsOurs && xhrOpen && xhrSend) {
					window.XMLHttpRequest.prototype.open = xhrOpen;
					window.XMLHttpRequest.prototype.send = xhrSend;
				}
			} catch (e) {}
			xhrOpen = null;
			xhrSend = null;
			wrappedXhrOpen = null;
			wrappedXhrSend = null;
		}

		// =====================================================================
		// 3. Общий слой композитора
		//
		// И черновик с телефона, и ход с телефона пишут в ОДИН элемент
		// [data-composer-input], поэтому запись сделана одним помощником
		// writeComposer(), а applyComposerText() и domSend() - надстройки над ним.
		//
		// ИНВАРИАНТ ЭХА: programmaticWrite. Текст, записанный в композитор НАМИ,
		// никогда не уходит на узел как черновик пользователя. Флаг ставится в
		// обоих программных путях записи - applyComposerText() и domSend() - и
		// проверяется в schedulePush(). Без него Lexical-событие от нашей же
		// записи возвращало бы текст обратно на телефон, а телефон показывал бы
		// его как чужой черновик: это и есть эхо-цикл из аудита (два движка в
		// одном документе применяли текст друг друга). Второй пояс -
		// lastPushedText: он делает повторный пуш того же текста бессмысленным,
		// поэтому инвариант держится и для асинхронных хвостов Lexical.
		// =====================================================================

		function composerAttached() {
			return !!(el && el.nodeType === 1 && el.hasAttribute && el.hasAttribute("data-composer-input") && el.isConnected);
		}

		// Отслеживаемый композитор, а если движок черновиков его ещё не нашёл
		// (или выключен легаси-защитой) - свежий запрос к документу. Мосту
		// композитор нужен в любом случае: от него зависят canSend() и domSend().
		function composerEl() {
			if (composerAttached()) return el;
			try { return document.querySelector("[data-composer-input]"); } catch (e) { return null; }
		}

		function composerText(node) {
			var n = node || el;
			if (!n) return "";
			// innerText сохраняет переносы абзацев, textContent склеивает их
			var t = (typeof n.innerText === "string" ? n.innerText : n.textContent) || "";
			return t.slice(0, MAX_TEXT);
		}

		function setComposerContent(node, text) {
			// запасной путь: полная замена содержимого без пляски с кареткой
			node.textContent = text;
			node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		}

		// Общая запись в Lexical: фокус/выделение/execCommand("insertText") с
		// D8-веткой focusFree и запасным путём через InputEvent.
		// forceFocus=true нужен domSend: чтобы Enter обработался keymap'ом
		// композитора, фокус обязан быть на нём. applyComposerText фокус не
		// забирает, если пользователь печатает в другом поле.
		function writeComposer(node, text, forceFocus) {
			var active = document.activeElement;
			// D8: забираем фокус только когда им никто не владеет. Если
			// пользователь печатает в другом поле, заменяем содержимое без
			// execCommand и без перемещения каретки.
			var focusFree = !!(active && active !== node && active !== document.body && active !== document.documentElement);
			var ok = false;
			if (forceFocus || !focusFree) {
				node.focus();
				var sel = window.getSelection();
				var range = document.createRange();
				range.selectNodeContents(node);
				sel.removeAllRanges();
				sel.addRange(range);
				// insertText идёт через нативный конвейер ввода, поэтому Lexical
				// видит изменение как настоящее событие редактирования. execCommand
				// deprecated - пробуем его первым только потому, что это единственный
				// путь, который Lexical наблюдает как настоящее редактирование.
				try {
					ok = !!(document.execCommand && document.execCommand("insertText", false, text));
				} catch (e2) {
					ok = false;
				}
			}
			if (!ok) setComposerContent(node, text);
			return ok;
		}

		// Применение удалённого черновика (узел -> десктоп).
		function applyComposerText(text) {
			var node = el;
			if (!node) return;
			// D8: никогда не трогаем редактор, который пользователь не видит -
			// откладываем текст и применяем его на visibilitychange вместо того,
			// чтобы воровать фокус в фоновой вкладке.
			if (typeof document === "object" && document.hidden) {
				pendingRemoteText = text;
				return;
			}
			pendingRemoteText = null;
			applyingRemote = true;
			programmaticWrite = true; // ИНВАРИАНТ ЭХА: вызов 1 из 2
			try {
				writeComposer(node, text, false);
				if (!text) {
					// стёртый черновик: сбрасываем состояние плейсхолдера
					node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
				}
			} catch (e) {
				log("apply failed", e && e.message);
			} finally {
				lastPushedText = text;
				applyingRemote = false;
				programmaticWrite = false;
			}
		}

		// Отправка хода с телефона: запись в композитор + Enter.
		function domSend(text) {
			var node = composerEl();
			if (!node || !node.isConnected) return { ok: false, error: "composer_not_found" };
			if (document.hidden) return { ok: false, error: "tab_hidden" };
			programmaticWrite = true; // ИНВАРИАНТ ЭХА: вызов 2 из 2
			try {
				writeComposer(node, text, true);
				// записанный нами текст не должен уйти на узел как черновик
				lastPushedText = composerText(node);
			} catch (e) {
				return { ok: false, error: "composer_write_failed" };
			} finally {
				programmaticWrite = false;
			}
			// Enter обрабатывает keymap композитора на его root-элементе.
			try {
				node.dispatchEvent(new KeyboardEvent("keydown", {
					key: "Enter", code: "Enter", keyCode: 13, which: 13,
					bubbles: true, cancelable: true
				}));
			} catch (e3) {
				return { ok: false, error: "enter_dispatch_failed" };
			}
			return { ok: true };
		}

		// --- видимость: общая для черновиков (D8) и темпа поллинга (P2) ---
		function onVisibilityChange() {
			if (!alive) return;
			if (document.hidden) return;
			// D8: flush черновика, который мы отказались применять в скрытой вкладке
			if (pendingRemoteText !== null) {
				var text = pendingRemoteText;
				pendingRemoteText = null;
				if (!applyingRemote && text !== composerText()) applyComposerText(text);
			}
			// hidden -> visible: сразу возвращаем активный темп
			if (pollRunning && pollHandle) {
				clearTimeout(pollHandle);
				pollHandle = 0;
				draftPollLoop();
			}
		}

		function bindVisibility() {
			if (visibilityBound) return;
			visibilityBound = true;
			try { document.addEventListener("visibilitychange", onVisibilityChange); } catch (e) { visibilityBound = false; }
		}

		function unbindVisibility() {
			if (!visibilityBound) return;
			visibilityBound = false;
			try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (e) {}
		}

		// =====================================================================
		// 4. Движок черновиков (бывший dsh-draft-sync)
		// =====================================================================

		function pushDraft(force) {
			if (legacyDrafts) return;
			if (!alive || !cfg || !nodeBase || !sessionId || !el) return;
			var text = composerText();
			if (!force && text === lastPushedText) return;
			lastPushedText = text;
			var myEpoch = engineEpoch;
			nodeRequest("session.updateDraft", { sessionId: sessionId, text: text, origin: ORIGIN_ID })
				.then(function (j) {
					if (!alive || myEpoch !== engineEpoch) return;
					if (j && j.ok) return;
					// токен ротировал или узел перезапустился: перечитываем конфиг один раз
					log("push отклонён, перечитываю конфиг");
					lastPushedText = null;
					cfg = null;
					nodeBase = null;
					scheduleBootstrap(RETRY_MS);
				})
				.catch(function () {});
		}

		function schedulePush() {
			if (legacyDrafts) return;
			// ИНВАРИАНТ ЭХА: наша собственная запись (domSend / applyComposerText)
			// черновиком пользователя не считается и на узел не уходит.
			if (!alive || applyingRemote || programmaticWrite) return;
			lastLocalInput = now();
			if (pushTimer) clearTimeout(pushTimer);
			pushTimer = setTimeout(function () {
				pushTimer = 0;
				pushDraft(false);
			}, PUSH_DELAY_MS);
		}

		function sameTarget(data) {
			if (!sessionId) return false;
			if (data.externalSessionId === sessionId) return true;
			return data.sessionId === sessionId;
		}

		// D9/P7: события сверяются с сессией и эпохой движка, которые были
		// актуальны на момент отправки запроса, поэтому ребайнд или перезапуск
		// движка в полёте больше не может применить устаревший текст.
		function handleEvents(events, reqEpoch, reqSessionEpoch, reqSessionId) {
			if (legacyDrafts) return;
			if (!alive || reqEpoch !== engineEpoch || reqSessionEpoch !== sessionEpoch) return;
			for (var i = 0; i < events.length; i++) {
				var ev = events[i] || {};
				if ((ev.type === "items" || ev.type === "turnEnded" || ev.type === "state") && ev.data && ev.data.externalSessionId) {
					trackActivity(ev.data.externalSessionId);
				}
				if (ev.type !== "draft" || !ev.data) continue;
				var d = ev.data;
				if (d.origin === ORIGIN_ID) continue; // собственное эхо
				if (!sameTarget(d)) continue;
				if (reqSessionId && reqSessionId !== sessionId) continue; // ребайнд во время поллинга
				if (applyingRemote) continue;
				var busyTyping = document.activeElement === el && (now() - lastLocalInput) < GRACE_MS;
				if (busyTyping) continue;
				applyComposerText(String(d.text || ""));
			}
		}

		// --- запасной путь привязки сессии: если GUI не делает ни одного
		// window.fetch/XHR, который мы могли бы понюхать, движок всё равно
		// привязывает сессию двумя способами - узел пересылает живые
		// items/turnEnded с harness-id сессии, а session.list ранжирует сессии по
		// orderingTime (самая свежая - это чат, который пользователь открыл) ---
		function trackActivity(externalId) {
			if (legacyDrafts) return;
			if (!alive || !externalId || externalId === sessionId) return;
			// принимаем только когда перехват молчал: sniff'нутые вызовы самого
			// GUI в приоритете (это точный чат, куда переключился пользователь)
			if (sessionId && (now() - lastSniffAt) < 300000) return;
			// активность может прыгать между параллельными сессиями агентов - остужаем
			if (now() - lastActivityAt < 120000) return;
			lastActivityAt = now();
			adoptSession(externalId, "activity");
		}

		// Одноразовое спасение, когда больше ничего не привязало сессию: берём
		// самую свежую живую сессию из session.list (максимум orderingTime).
		function probeSessionList() {
			if (legacyDrafts) return;
			if (!alive || !cfg || !nodeBase || sessionId) return;
			if (listProbeInFlight) return; // P7: один запрос за раз
			if (now() - listProbedAt < 60000) return;
			listProbedAt = now();
			listProbeInFlight = true;
			var myEpoch = engineEpoch;
			var sessEpoch = sessionEpoch;
			nodeRequest("session.list", {})
				.then(function (j) {
					listProbeInFlight = false;
					if (!alive || myEpoch !== engineEpoch || sessEpoch !== sessionEpoch) return;
					if (!j || !j.ok || !j.result || sessionId) return;
					var list = j.result.sessions || [];
					var best = null;
					var bestT = "";
					for (var i = 0; i < list.length; i++) {
						var s = list[i];
						if (!s || !s.externalSessionId) continue;
						if (s.metadata && s.metadata.readOnly) continue;
						var t = String(s.orderingTime || "");
						if (t > bestT) { bestT = t; best = s; }
					}
					if (best) adoptSession(best.externalSessionId, "list:" + String(best.title || "").slice(0, 40));
				})
				.catch(function () { listProbeInFlight = false; });
		}

		function adoptSession(id, why) {
			if (legacyDrafts) return;
			if (!alive || !id || id === sessionId) return;
			sessionId = id;
			sessionEpoch++;    // P7/D9: in-flight ответы для старой сессии умирают
			adoptedBy = why;
			lastPushedText = null;
			// одна находка - одно понятие «какая сессия открыта»: мост сравнивает
			// с этим id свой session.startTurn (защита от отправки не в тот чат)
			activeExternalId = id;
			log("активная сессия (" + why + "):", sessionId);
			if (cfg && nodeBase) {
				loadExistingDraft();
				pushDraft(false);
			}
		}

		// --- P2: цепочка поллинга черновиков - одна, отслеживаемая, отменяемая
		function draftPollDelay() {
			if (typeof document === "object" && document.hidden) return POLL_IDLE_MS;
			if (!composerAttached()) return POLL_IDLE_MS;
			if (lastLocalInput && (now() - lastLocalInput) > IDLE_AFTER_MS) return POLL_IDLE_MS;
			return POLL_BUSY_MS;
		}

		function startDraftPoll() {
			if (legacyDrafts) return;
			if (!alive || pollRunning) return;
			pollRunning = true;
			draftPollLoop();
		}

		function stopDraftPoll() {
			pollRunning = false;
			if (pollHandle) { clearTimeout(pollHandle); pollHandle = 0; }
			if (pollAbort) { try { pollAbort.abort(); } catch (e) {} pollAbort = null; }
		}

		function scheduleDraftPoll(delay) {
			if (!alive || !pollRunning) return;
			if (pollHandle) clearTimeout(pollHandle);
			var myEpoch = engineEpoch;
			pollHandle = setTimeout(function () {
				pollHandle = 0;
				if (!alive || !pollRunning || myEpoch !== engineEpoch) return;
				draftPollLoop();
			}, delay);
		}

		function draftPollLoop() {
			if (legacyDrafts) return;
			if (!alive || !pollRunning) return;
			if (!cfg || !nodeBase) { pollRunning = false; return; }
			if (pollAbort) { try { pollAbort.abort(); } catch (e) {} }
			var ac = new AbortController();
			pollAbort = ac;
			var myEpoch = engineEpoch;
			var sessEpoch = sessionEpoch;
			var sid = sessionId;
			// Токен идёт только в заголовке x-dsh-token (узел читает его первым),
			// поэтому в access-лог узла он через query больше не попадает.
			var url = nodeBase + "/api/events?since=" + encodeURIComponent(String(since)) + "&had=1";
			fetch(url, { cache: "no-store", signal: ac.signal, headers: { "x-dsh-token": cfg.token } })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (j) {
					if (!alive || myEpoch !== engineEpoch) return;
					if (!j) throw new Error("no data");
					since = Number(j.ts) || since;
					handleEvents(j.events || [], myEpoch, sessEpoch, sid);
					scheduleDraftPoll(draftPollDelay());
				})
				.catch(function (e) {
					if (!alive || myEpoch !== engineEpoch) return;
					if (e && e.name === "AbortError") return;
					if (!pollRunning) return;
					// узел лёг или auth пропал: отступаем и перечитываем конфиг (single-flight)
					pollRunning = false;
					cfg = null;
					nodeBase = null;
					scheduleBootstrap(RETRY_MS);
				});
		}

		function loadExistingDraft() {
			if (legacyDrafts) return;
			if (!alive || !cfg || !nodeBase || !sessionId) return;
			var sid = sessionId;
			var myEpoch = engineEpoch;
			var sessEpoch = sessionEpoch;
			nodeRequest("session.getDraft", { sessionId: sid })
				.then(function (j) {
					if (!alive || myEpoch !== engineEpoch || sessEpoch !== sessionEpoch || sid !== sessionId) return;
					var d = j && j.result;
					if (!d) return;
					var text = String(d.text || "");
					if (!text) return;
					if (composerText()) return; // никогда не затираем локальное содержимое
					if (d.origin === ORIGIN_ID) return;
					applyComposerText(text);
				})
				.catch(function () {});
		}

		// --- отслеживание активной сессии: нюхаем собственные /api-вызовы страницы
		var SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
		// Имена БЕЗ префикса "/api/": старое сравнение строило
		// "/api//api/session/list", никогда не совпадало, и служебные вызовы
		// угоняли привязанную сессию (тот же дефект, что D4 в gui-патче).
		var SIDE_CHANNELS = ["session/list", "session/title", "session/rename", "session/fork", "session/create"];

		function apiPathOf(url) {
			var idx = url.indexOf("/api/");
			var path = idx >= 0 ? url.slice(idx) : url;
			path = path.split("?")[0].split("#")[0];
			while (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.slice(0, -1);
			return path.indexOf("/api/") === 0 ? path.slice(5) : path;
		}

		function isSideChannel(url) {
			var name = apiPathOf(url);
			for (var i = 0; i < SIDE_CHANNELS.length; i++) {
				if (name === SIDE_CHANNELS[i]) return true;
			}
			return false;
		}

		function trackFromUrlAndBody(url, bodyText) {
			if (legacyDrafts) return;
			if (!alive) return;
			var m = SESSION_RE.exec(bodyText || "");
			if (!m) return;
			if (isSideChannel(url)) return; // это не сигнал «открыть эту сессию»
			if (m[0] !== sessionId) {
				lastSniffAt = now();
				adoptSession(m[0], "sniff");
			}
		}

		// --- P9: книга учёта слушателей для каждого узла, к которому прикасались
		function listenEl(node) {
			if (!node || attachedEls.indexOf(node) >= 0) return;
			node.addEventListener("input", schedulePush, true);
			attachedEls.push(node);
		}

		function releaseEl(node) {
			if (!node) return;
			var i = attachedEls.indexOf(node);
			if (i >= 0) attachedEls.splice(i, 1);
			try { node.removeEventListener("input", schedulePush, true); } catch (e) {}
		}

		function releaseAllEls() {
			while (attachedEls.length) {
				var node = attachedEls.pop();
				try { node.removeEventListener("input", schedulePush, true); } catch (e) {}
			}
		}

		// --- P3: одна отслеживаемая цепочка ретраев + debounce'нутый наблюдатель,
		//     суженный до контейнера композитора
		function watchComposer() {
			watchPending = false;
			if (legacyDrafts) return;
			if (!alive) return;
			if (el && !composerAttached()) {
				// узел композитора заменили: снимаем слушатель со старого
				releaseEl(el);
				el = null;
				retargetObserver(null);
			}
			if (composerAttached()) {
				// health tick: наблюдатель сужен до контейнера композитора, поэтому
				// один отслеживаемый таймер перепроверяет привязку (и снова
				// расширяет наблюдателя), если вьюху целиком поменяли под нами
				retargetObserver(el);
				scheduleWatch(WATCH_CHECK_MS);
				return;
			}
			var found = document.querySelector("[data-composer-input]");
			if (found) {
				el = found;
				lastPushedText = null;
				listenEl(el);
				log("композитор подключён");
				retargetObserver(el);
				scheduleWatch(WATCH_CHECK_MS);
				if (cfg && nodeBase && sessionId) loadExistingDraft();
				return;
			}
			scheduleWatch(WATCH_RETRY_MS);
		}

		function scheduleWatch(delay) {
			if (!alive) return;
			if (watchHandle) return; // ровно одна ожидающая цепочка ретраев
			watchHandle = setTimeout(function () {
				watchHandle = 0;
				watchComposer();
			}, delay);
		}

		function stopWatch() {
			if (watchHandle) { clearTimeout(watchHandle); watchHandle = 0; }
			watchPending = false;
		}

		function mutationSeen() {
			if (legacyDrafts || !alive) return;
			if (composerAttached()) return; // перепривязывать нечего
			if (watchPending) return;       // быстрая перепроверка уже в очереди
			// debounce: схлопываем всплеск мутаций в ОДНУ перепроверку и прыгаем
			// вперёд медленного health tick вместо того, чтобы плодить таймеры
			watchPending = true;
			if (watchHandle) { clearTimeout(watchHandle); watchHandle = 0; }
			scheduleWatch(MUTATION_DEBOUNCE_MS);
		}

		// Наблюдаем за собственным контейнером композитора, когда узнали где он;
		// на документ откатываемся только пока композитор не найден.
		function retargetObserver(node) {
			if (!alive || !mo) return;
			var target = node && node.parentNode ? node.parentNode : document.documentElement;
			if (moTarget === target) return;
			try { mo.disconnect(); } catch (e) {}
			moTarget = target;
			try { mo.observe(target, { childList: true, subtree: true }); } catch (e) { moTarget = null; }
		}

		function observeDom() {
			if (legacyDrafts) return;
			if (typeof MutationObserver !== "function") { scheduleWatch(WATCH_RETRY_MS); return; }
			if (!mo) {
				mo = new MutationObserver(mutationSeen);
				moTarget = null;
			}
			retargetObserver(null);
			watchComposer();
		}

		// =====================================================================
		// 5. Движок моста: возможности, команды узла, long-poll
		// =====================================================================

		function canSend() {
			var node = composerEl();
			return !!(node && node.isConnected && !document.hidden);
		}

		function cap(id, supported, available) {
			return {
				capabilityId: id, runtime: "dsh", scope: "runtime",
				supported: !!supported, available: !!available,
				allowed: !!supported && !!available
			};
		}

		// Документ возможностей остаётся честным: web-половина умеет только
		// отправить сообщение через композитор (если он есть) и отдать конфиг.
		// Черновики - это node-local RPC (session.updateDraft/session.getDraft),
		// на документ возможностей они не влияют.
		function capabilitiesDoc() {
			var send = canSend();
			return {
				runtime: "dsh",
				revision: 5,
				capabilities: [
					cap("session.send_message", true, send),
					cap("session.interrupt", false, false),
					cap("session.steer", false, false),
					cap("session.interaction.approval", false, false),
					cap("catalog.model", false, false),
					cap("catalog.permission", false, false),
					cap("catalog.effort", false, false),
					cap("session.commands", false, false),
					cap("runtime.attachment", false, false),
					cap("runtime.config", true, true)
				],
				metadata: {
					readOnly: !send, attachments: false, userQuestions: false,
					approval: false, transport: "http-push", pluginVersion: VERSION,
					source: SOURCE
				}
			};
		}

		// Web-половина отвечает только за то, что реально умеет делать в браузере.
		// На всё остальное возвращает явную ошибку, чтобы узел не ждал ответа и
		// мог опереться на TCP-мост host-половины плагина.
		function execCommand(method, params) {
			params = params || {};
			if (method === "ping") return { ok: true, result: { ok: true, source: SOURCE } };
			if (method === "runtime.getConfig") {
				return { ok: true, result: {
					runtime: "dsh", revision: 2, values: {},
					metadata: { readOnly: !canSend(), storageMode: "dsh-native" }
				} };
			}
			if (method === "runtime.getCapabilities" || method === "session.getCapabilities") {
				return { ok: true, result: capabilitiesDoc() };
			}
			if (method === "session.list") {
				var fresh = sessionsCache && (Date.now() - sessionsCache.at) < SESSIONS_FRESH_MS;
				if (!fresh) return { ok: false, error: "no_session_data_in_web_half" };
				return { ok: true, result: { sessions: sessionsCache.sessions, nextCursor: null } };
			}
			if (method === "session.getState") {
				var ext = params.externalSessionId || params.sessionId || activeExternalId;
				var hit = ext && stateCache[ext];
				if (!hit || (Date.now() - hit.at) > SESSIONS_FRESH_MS) {
					return { ok: false, error: "no_state_data_in_web_half" };
				}
				return { ok: true, result: hit.state };
			}
			if (method === "session.startTurn" || method === "session.createAndStart") {
				var content = params.content;
				if (typeof content !== "string" || !content) return { ok: false, error: "content_required" };
				if (method === "session.createAndStart") {
					return { ok: false, error: "create_unsupported_in_web_half" };
				}
				// Защита от отправки не в тот чат: десктопный композитор всегда
				// привязан к открытой сессии, поэтому при несовпадении (или когда
				// открытая сессия неизвестна) отправлять нельзя.
				var want = params.externalSessionId || null;
				if (want && activeExternalId && want !== activeExternalId) {
					return { ok: false, error: "session_mismatch" };
				}
				if (want && !activeExternalId) return { ok: false, error: "active_session_unknown" };
				var r = domSend(content);
				if (!r.ok) return r;
				return { ok: true, result: {
					accepted: true,
					sessionId: params.sessionId || null,
					externalSessionId: activeExternalId || want || null,
					via: "dom-composer"
				} };
			}
			return { ok: false, error: "unsupported_method:" + method };
		}

		function answer(cmd, res) {
			var data = { id: cmd.id };
			if (res && res.ok) { data.ok = true; data.result = res.result === undefined ? null : res.result; }
			else { data.ok = false; data.error = (res && res.error) || "command_failed"; }
			return ingest("result", data);
		}

		// --- long-poll команд ---
		// Цепочка одна, отслеживаемая и отменяемая: раньше пауза между
		// итерациями ставилась несохранённым setTimeout, а провал post() вообще
		// не обнаруживался (post гасит ошибки и возвращает null), из-за чего при
		// недоступном узле получался горячий цикл без задержки. Теперь провал -
		// это пауза POLL_RETRY_MS, а POLL_FAIL_LIMIT провалов подряд ведут к
		// общему ребутстрапу конфига.
		function startBridgePoll() {
			if (!alive || bridgePolling) return;
			bridgePolling = true;
			bridgeFailCount = 0;
			bridgePollOnce();
		}

		function stopBridgePoll() {
			bridgePolling = false;
			if (bridgePollHandle) { clearTimeout(bridgePollHandle); bridgePollHandle = 0; }
		}

		function scheduleBridgePoll(delay) {
			if (!alive || !bridgePolling) return;
			if (bridgePollHandle) clearTimeout(bridgePollHandle);
			var myEpoch = engineEpoch;
			bridgePollHandle = setTimeout(function () {
				bridgePollHandle = 0;
				if (!alive || !bridgePolling || myEpoch !== engineEpoch) return;
				bridgePollOnce();
			}, delay);
		}

		function bridgePollOnce() {
			if (!alive || !bridgePolling) return;
			if (!cfg || !nodeBase) { bridgePolling = false; return; }
			var myEpoch = engineEpoch;
			post("/api/bridge/poll", { token: cfg.token, pluginId: pluginId, wait: POLL_WAIT_S })
				.then(function (j) {
					if (!alive || myEpoch !== engineEpoch || !bridgePolling) return;
					if (!j || !j.ok) {
						bridgeFailCount++;
						if (bridgeFailCount >= POLL_FAIL_LIMIT) {
							// токен ротировал или узел перезапустился: общий ребутстрап
							bridgePolling = false;
							bridgeFailCount = 0;
							cfg = null;
							nodeBase = null;
							scheduleBootstrap(RETRY_MS);
							return;
						}
						scheduleBridgePoll(POLL_RETRY_MS);
						return;
					}
					bridgeFailCount = 0;
					var cmds = j.commands || [];
					if (!cmds.length) { scheduleBridgePoll(0); return; }
					// Команды независимы: выполняем все и отвечаем на каждую.
					Promise.all(cmds.map(function (c) {
						var res;
						try { res = execCommand(c.method, c.params); }
						catch (e) { res = { ok: false, error: "exception:" + (e && e.message) }; }
						return answer(c, res);
					})).then(function () {
						scheduleBridgePoll(0);
					}, function () {
						scheduleBridgePoll(0);
					});
				})
				.catch(function () {
					if (!alive || myEpoch !== engineEpoch || !bridgePolling) return;
					scheduleBridgePoll(POLL_RETRY_MS);
				});
		}

		// --- эвристики: что пересылать ---
		function sig(v) {
			try { return JSON.stringify(v).length + ":" + (v && v.length !== undefined ? v.length : 0); }
			catch (e) { return ""; }
		}

		function rememberState(j) {
			var ext = j.externalSessionId || (j.source && j.source.sessionId) || null;
			if (!ext || typeof ext !== "string") return;
			stateCache[ext] = { state: j, at: Date.now() };
			var keys = Object.keys(stateCache);
			if (keys.length > STATE_CACHE_MAX) {
				// выбрасываем самые старые записи, чтобы кэш не рос вечно
				keys.sort(function (a, b) { return stateCache[a].at - stateCache[b].at; });
				for (var i = 0; i < keys.length - STATE_CACHE_MAX; i++) delete stateCache[keys[i]];
			}
		}

		function forward(url, j) {
			if (!alive || !j || typeof j !== "object") return;
			// список сессий: массив либо {sessions:[...]}
			var sessions = Array.isArray(j) ? j : (Array.isArray(j.sessions) ? j.sessions : null);
			if (sessions && sessions.length && sessions[0] && (sessions[0].sessionId || sessions[0].id)) {
				sessionsCache = { sessions: sessions, at: Date.now() };
				var s = sig(sessions);
				var t = Date.now();
				if (s === lastSessionsSig && t - lastSessionsAt < SNIFF_DEBOUNCE_MS) return;
				lastSessionsSig = s; lastSessionsAt = t;
				ingest("sessions", { sessions: sessions });
				return;
			}
			// событие синк-фида в обёртке узла
			if (j.type && typeof j.type === "string" &&
				(j.type === "items" || j.type === "state" || j.type === "turnEnded" ||
				 j.type === "draft" || j.type === "bridge" || j.type === "sessions")) {
				rememberState(j.data || j);
				if (j.data && j.data.externalSessionId) {
					activeExternalId = j.data.externalSessionId;
					// та же находка кормит движок черновиков: когда GUI молчит,
					// сессия определяется по активности. Кулдауны trackActivity
					// не дают перебить уже sniff'ом привязанную сессию.
					trackActivity(j.data.externalSessionId);
				}
				ingest("event", j);
				return;
			}
			// состояние сессии без обёртки
			if (j.externalSessionId && (j.status || j.sourceState)) {
				rememberState(j);
				activeExternalId = j.externalSessionId;
				trackActivity(j.externalSessionId);
			}
		}

		// =====================================================================
		// 6. Жизненный цикл: один старт, один dispose
		// =====================================================================

		// P1: полный сброс состояния, чтобы перезапущенный движок перечитал конфиг
		function resetState() {
			// общий слой
			cfg = null;
			nodeBase = null;
			helloSent = false;
			bootstrapping = false;
			// композитор
			lastPushedText = null;
			lastLocalInput = 0;
			pendingRemoteText = null;
			applyingRemote = false;
			programmaticWrite = false;
			// черновики
			sessionId = null;
			since = 0;
			adoptedBy = "";
			lastSniffAt = 0;
			lastActivityAt = 0;
			listProbedAt = 0;
			listProbeInFlight = false;
			// мост
			sessionsCache = null;
			stateCache = {};
			lastSessionsSig = "";
			lastSessionsAt = 0;
			activeExternalId = null;
			bridgeFailCount = 0;
			sessionEpoch++;
		}

		function unbindReady() {
			if (!readyHandler) return;
			var h = readyHandler;
			readyHandler = null;
			try { document.removeEventListener("DOMContentLoaded", h); } catch (e) {}
		}

		function teardown() {
			engineEpoch++;   // убивает все in-flight .then этого поколения
			alive = false;
			stopDraftPoll();
			stopBridgePoll();
			if (bootHandle) { clearTimeout(bootHandle); bootHandle = 0; }
			bootstrapping = false;
			stopWatch();
			if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
			stopHeartbeat();
			unbindReady();
			if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; moTarget = null; }
			releaseAllEls();
			el = null;
			unbindVisibility();
			unhookFetch();
			unhookXhr();
			resetState();
			legacyDrafts = false;
			if (window[ARM_KEY] === ARM_VALUE) {
				try { delete window[ARM_KEY]; } catch (e) { window[ARM_KEY] = null; }
			}
			log("остановлен");
		}

		// P8: заявка на документ. Если первым вооружился asar-патч
		// gui/draftsync-desktop.js, забираем документ себе, вызвав его
		// опубликованный stop-хук, вместо того чтобы поднимать второй движок.
		// Значение старого отдельного плагина stop-хука не публикует - оно
		// обрабатывается в startEngine через legacyDrafts.
		function claimDocument() {
			var guiStop = window.__dshDesktopDraftSyncStop;
			if (typeof guiStop === "function" && window[ARM_KEY] !== ARM_VALUE) {
				try { guiStop(); } catch (e) {}
				window.__dshDesktopDraftSyncStop = null;
			}
			window[ARM_KEY] = ARM_VALUE;
		}

		function startEngine() {
			// P10: эффект могут перезапустить без вызова его dispose - сносим
			// предыдущее поколение до вооружения нового.
			if (typeof activeStop === "function") {
				var prev = activeStop;
				activeStop = null;
				try { prev(); } catch (e) {}
			}
			if (alive) {
				// P1: никогда не вооружаемся дважды. Отдаём dispose текущего
				// поколения, а если ссылка на него потеряна - собираем новый,
				// чтобы вызывающая сторона в любом случае могла остановить движок.
				log("уже вооружён, повторный startEngine игнорируется");
				return typeof activeStop === "function" ? activeStop : function () { teardown(); };
			}

			// Легаси-миграция: если документ уже вооружён старым отдельным
			// плагином dsh-draft-sync, черновики принадлежат ему. Иначе они
			// синхронизируются дважды (два /api/events, два MutationObserver,
			// эхо-цикл), поэтому наш движок черновиков не стартует, а мост
			// продолжает работать как ни в чём не бывало.
			legacyDrafts = (window[ARM_KEY] === LEGACY_ARM_VALUE);
			if (legacyDrafts) {
				try {
					console.warn("[dsh-phone-bridge] ВНИМАНИЕ: документ уже вооружён старым плагином dsh-draft-sync (" +
						ARM_KEY + " = \"" + LEGACY_ARM_VALUE + "\"). Синхронизация черновиков теперь встроена в " +
						"dsh-phone-bridge, поэтому черновики будут синхронизироваться ДВАЖДЫ. Уберите \"dsh-draft-sync\" " +
						"из dsh.profile.bundles и удалите папку плагина из node_modules профиля. До тех пор встроенный " +
						"движок черновиков здесь выключен; мост (hello, heartbeat, команды узла) работает.");
				} catch (e) {}
			}

			claimDocument();
			alive = true;
			engineEpoch++;
			hookFetch();
			hookXhr();
			bindVisibility();

			function arm() {
				if (!alive) return;
				if (!legacyDrafts) observeDom();
				bootstrap();
			}

			if (document.readyState === "loading") {
				var myEpoch = engineEpoch;
				readyHandler = function onReady() {
					unbindReady();
					if (alive && myEpoch === engineEpoch) arm();
				};
				document.addEventListener("DOMContentLoaded", readyHandler);
			} else {
				arm();
			}

			log("v" + VERSION + " вооружён" + (legacyDrafts ? " (черновики выключены: легаси-плагин)" : " (черновики + мост)"));

			// P1: идемпотентный dispose - второй вызов не может потревожить новый движок
			var stopped = false;
			var stop = function stopEngine() {
				if (stopped) return;
				stopped = true;
				if (activeStop === stop) activeStop = null;
				teardown();
			};
			activeStop = stop;
			return stop;
		}
		//#endregion
		exports.VERSION = VERSION;
		exports.apply = function (ctx) {
			ctx.effect(function () {
				return startEngine();
			}, "dsh-phone-bridge: engine");
		};
		exports.inject = [];
		return module.exports;
	}
});
