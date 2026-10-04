window.__ModuleLoader__.load({
	id: "dsh-phone-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// маркер: две копии движка в одном документе не вооружаются
		window.__dshPhoneBridgePlugin = true;
		//#region engine
		var VERSION = 2;
		var SOURCE = "dsh-phone-bridge/web";
		var NODE_PORT = 8460;
		// :8460 - основной порт узла (http, либо https при TLS). :8461 - loopback
		// http, который узел поднимает при TLS, чтобы плагин не терял бутстрап.
		var NODE_BASES = [
			"http://127.0.0.1:" + NODE_PORT,
			"http://127.0.0.1:" + (NODE_PORT + 1),
			"http://localhost:" + NODE_PORT,
			"http://localhost:" + (NODE_PORT + 1)
		];
		var HEARTBEAT_MS = 15000;       // статус моста шлём регулярно
		var POLL_WAIT_S = 25;           // long-poll команд: меньше серверного потолка 55 с
		var POLL_RETRY_MS = 3000;       // пауза после ошибки poll, чтобы не долбить узел
		var SNIFF_DEBOUNCE_MS = 250;    // схлопываем всплеск одинаковых снапшотов
		var SESSIONS_FRESH_MS = 300000; // снапшот сессий старше 5 минут уже не ответ
		var STATE_CACHE_MAX = 64;       // граница роста кэша состояний
		var MAX_PUSH_BYTES = 512 * 1024;

		var cfg = null;        // {token, ...} с /api/draft-config
		var nodeBase = null;
		var armed = false;
		var hbTimer = 0;
		var polling = false;
		var epoch = 0;         // сбрасывает зависшие циклы при повторном бутстрапе
		var pluginId = "web-" + Math.random().toString(36).slice(2, 10);
		var lastSessionsSig = "";
		var lastSessionsAt = 0;
		var sessionsCache = null;   // {sessions, at} - основа ответа session.list
		var stateCache = {};        // externalSessionId -> {state, at}
		var activeExternalId = null; // какая сессия открыта в десктопе прямо сейчас

		function log() {
			try {
				var a = Array.prototype.slice.call(arguments);
				a.unshift("[dsh-phone-bridge]");
				console.log.apply(console, a);
			} catch (e) {}
		}

		// ---------- bootstrap: токен узла ----------
		function fetchConfig() {
			return new Promise(function (resolve) {
				var i = 0;
				function next() {
					if (i >= NODE_BASES.length) return resolve(null);
					var base = NODE_BASES[i++];
					fetch(base + "/api/draft-config", { cache: "no-store" })
						.then(function (r) { return r.json().catch(function () { return null; }); })
						.then(function (j) {
							if (j && j.ok && j.token) { nodeBase = base; resolve(j); }
							else next();
						})
						.catch(next);
				}
				next();
			});
		}

		// ---------- push на узел ----------
		function post(path, body) {
			if (!cfg || !nodeBase) return Promise.resolve(null);
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
			return post("/api/bridge/ingest", { token: cfg.token, type: type, data: data });
		}

		function heartbeat() {
			ingest("status", { connected: true, source: SOURCE, version: VERSION, ts: Date.now() });
		}

		// ---------- возможности web-половины (честно) ----------
		function composerEl() {
			try { return document.querySelector("[data-composer-input]"); } catch (e) { return null; }
		}

		function canSend() {
			var el = composerEl();
			return !!(el && el.isConnected && !document.hidden);
		}

		function cap(id, supported, available) {
			return {
				capabilityId: id, runtime: "dsh", scope: "runtime",
				supported: !!supported, available: !!available,
				allowed: !!supported && !!available
			};
		}

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

		// ---------- исполнение команд узла ----------
		// Web-половина отвечает только за то, что реально умеет делать в браузере.
		// На всё остальное возвращает явную ошибку, чтобы узел не ждал ответа и
		// мог опереться на TCP-мост host-половины плагина.
		function domSend(text) {
			var el = composerEl();
			if (!el || !el.isConnected) return { ok: false, error: "composer_not_found" };
			if (document.hidden) return { ok: false, error: "tab_hidden" };
			try {
				el.focus();
				var sel = window.getSelection();
				var range = document.createRange();
				range.selectNodeContents(el);
				sel.removeAllRanges();
				sel.addRange(range);
				var ok = false;
				// insertText идёт через нативный конвейер ввода, поэтому Lexical
				// видит изменение как настоящее событие редактирования.
				try { ok = !!(document.execCommand && document.execCommand("insertText", false, text)); }
				catch (e2) { ok = false; }
				if (!ok) {
					el.textContent = text;
					el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
				}
			} catch (e) {
				return { ok: false, error: "composer_write_failed" };
			}
			// Enter обрабатывает keymap композитора на его root-элементе.
			try {
				el.dispatchEvent(new KeyboardEvent("keydown", {
					key: "Enter", code: "Enter", keyCode: 13, which: 13,
					bubbles: true, cancelable: true
				}));
			} catch (e3) {
				return { ok: false, error: "enter_dispatch_failed" };
			}
			return { ok: true };
		}

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

		// ---------- long-poll команд ----------
		function pollLoop(myEpoch) {
			if (polling) return;
			polling = true;
			function once() {
				if (myEpoch !== epoch || !cfg || !nodeBase) { polling = false; return; }
				post("/api/bridge/poll", { token: cfg.token, pluginId: pluginId, wait: POLL_WAIT_S })
					.then(function (j) {
						if (myEpoch !== epoch) { polling = false; return; }
						var cmds = (j && j.ok && j.commands) || [];
						if (!cmds.length) { once(); return; }
						// Команды независимы: выполняем все и отвечаем на каждую.
						Promise.all(cmds.map(function (c) {
							var res;
							try { res = execCommand(c.method, c.params); }
							catch (e) { res = { ok: false, error: "exception:" + (e && e.message) }; }
							return answer(c, res);
						})).then(function () { once(); }, function () { once(); });
					}, function () {
						if (myEpoch !== epoch) { polling = false; return; }
						setTimeout(once, POLL_RETRY_MS);
					});
			}
			once();
		}

		// ---------- эвристики: что пересылать ----------
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
			if (!j || typeof j !== "object") return;
			// список сессий: массив либо {sessions:[...]}
			var sessions = Array.isArray(j) ? j : (Array.isArray(j.sessions) ? j.sessions : null);
			if (sessions && sessions.length && sessions[0] && (sessions[0].sessionId || sessions[0].id)) {
				sessionsCache = { sessions: sessions, at: Date.now() };
				var s = sig(sessions);
				var now = Date.now();
				if (s === lastSessionsSig && now - lastSessionsAt < SNIFF_DEBOUNCE_MS) return;
				lastSessionsSig = s; lastSessionsAt = now;
				ingest("sessions", { sessions: sessions });
				return;
			}
			// событие синк-фида в обёртке узла
			if (j.type && typeof j.type === "string" &&
				(j.type === "items" || j.type === "state" || j.type === "turnEnded" ||
				 j.type === "draft" || j.type === "bridge" || j.type === "sessions")) {
				rememberState(j.data || j);
				if (j.data && j.data.externalSessionId) activeExternalId = j.data.externalSessionId;
				ingest("event", j);
				return;
			}
			// состояние сессии без обёртки
			if (j.externalSessionId && (j.status || j.sourceState)) {
				rememberState(j);
				activeExternalId = j.externalSessionId;
			}
		}

		// ---------- sniff fetch/XHR десктопа ----------
		function sniffInstall() {
			var of = window.fetch;
			if (of && !of.__dshBridgePatched) {
				window.fetch = function () {
					var p = of.apply(this, arguments);
					try {
						var input = arguments[0];
						var url = typeof input === "string" ? input : (input && input.url) || "";
						p.then(function (res) {
							try {
								var ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
								if (ct.indexOf("json") < 0) return;
								res.clone().json().then(function (j) { forward(url, j); }).catch(function () {});
							} catch (e) {}
						}).catch(function () {});
					} catch (e) {}
					return p;
				};
				window.fetch.__dshBridgePatched = true;
			}
			var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
			if (XP && XP.open && XP.send && !XP.open.__dshBridgePatched) {
				var ox = XP.open, os = XP.send;
				XP.open = function (m, u) {
					this.__dshBridgeUrl = u;
					return ox.apply(this, arguments);
				};
				XP.send = function () {
					var self = this;
					this.addEventListener("load", function () {
						try {
							var ct = (self.getResponseHeader && self.getResponseHeader("content-type")) || "";
							if (ct.indexOf("json") < 0) return;
							forward(self.__dshBridgeUrl || "", JSON.parse(self.responseText));
						} catch (e) {}
					});
					return os.apply(this, arguments);
				};
				XP.open.__dshBridgePatched = true;
			}
		}

		function start() {
			if (armed) return;
			armed = true;
			fetchConfig().then(function (j) {
				if (!j) {
					log("узел не найден, повтор через 5с");
					armed = false;
					setTimeout(start, 5000);
					return;
				}
				cfg = j;
				epoch++;
				log("привязан к узлу", nodeBase, "pluginId", pluginId);
				// Рукопожатие: узел запоминает версию/источник и считает канал живым.
				ingest("hello", {
					version: VERSION, source: SOURCE, transport: "http-push",
					pluginId: pluginId, capabilities: capabilitiesDoc(), ts: Date.now()
				});
				heartbeat();
				hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
				sniffInstall();
				pollLoop(epoch);
			});
		}

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", start);
		} else {
			start();
		}
		//#endregion
		return exports;
	}
});
