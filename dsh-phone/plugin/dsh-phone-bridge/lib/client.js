window.__ModuleLoader__.load({
	id: "dsh-phone-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// marker, чтобы две копии движка не вооружались в одном документе
		window.__dshPhoneBridgePlugin = true;
		//#region engine
		var VERSION = 1;
		var NODE_PORT = 8460;
		// :8460 - основной порт узла (http, либо https при TLS). :8461 - loopback
		// http, который узел поднимает при TLS, чтобы плагин не терял бутстрап.
		var NODE_BASES = [
			"http://127.0.0.1:" + NODE_PORT,
			"http://127.0.0.1:" + (NODE_PORT + 1),
			"http://localhost:" + NODE_PORT,
			"http://localhost:" + (NODE_PORT + 1)
		];
		var HEARTBEAT_MS = 15000;   // статус моста шлём регулярно
		var SNIFF_DEBOUNCE_MS = 250; // схлопываем всплеск одинаковых снапшотов
		var MAX_PUSH_BYTES = 512 * 1024;

		var cfg = null;        // {token, port}
		var nodeBase = null;
		var armed = false;
		var bootstrapping = false;
		var hbTimer = 0;
		var lastSessionsSig = "";
		var lastSessionsAt = 0;

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
		function ingest(type, data) {
			if (!cfg || !nodeBase) return;
			var body;
			try { body = JSON.stringify({ token: cfg.token, type: type, data: data }); }
			catch (e) { return; }
			if (body.length > MAX_PUSH_BYTES) return; // не забиваем узел гигантами
			fetch(nodeBase + "/api/bridge/ingest", {
				method: "POST",
				headers: { "content-type": "application/json", "x-dsh-token": cfg.token },
				body: body
			}).catch(function () {});
		}

		function heartbeat() {
			ingest("status", { connected: true, source: "dsh-phone-bridge", version: VERSION, ts: Date.now() });
		}

		// ---------- эвристики: что пересылать ----------
		function sig(v) { try { return JSON.stringify(v).length + ":" + (v && v.length !== undefined ? v.length : 0); } catch (e) { return ""; } }

		function forward(url, j) {
			if (!j || typeof j !== "object") return;
			// список сессий: массив, либо {sessions:[...]}
			var sessions = Array.isArray(j) ? j : (Array.isArray(j.sessions) ? j.sessions : null);
			if (sessions && sessions.length && sessions[0] && (sessions[0].sessionId || sessions[0].id)) {
				var s = sig(sessions);
				var now = Date.now();
				// не шлём один и тот же снапshot чаще раза в debounce
				if (s === lastSessionsSig && now - lastSessionsAt < SNIFF_DEBOUNCE_MS) return;
				lastSessionsSig = s; lastSessionsAt = now;
				ingest("sessions", { sessions: sessions });
				return;
			}
			// событие синк-фида: {type:"items"|"state"|"turnEnded"|"draft"|"sessions", ...}
			if (j.type && typeof j.type === "string" &&
				(j.type === "items" || j.type === "state" || j.type === "turnEnded" ||
				 j.type === "draft" || j.type === "bridge" || j.type === "sessions")) {
				ingest("event", j);
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
			var ox = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
			var os = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;
			if (ox && os && !ox.__dshBridgePatched) {
				window.XMLHttpRequest.prototype.open = function (m, u) {
					this.__dshBridgeUrl = u;
					return ox.apply(this, arguments);
				};
				window.XMLHttpRequest.prototype.send = function () {
					var self = this;
					this.addEventListener("load", function () {
						try {
							var ct = self.getResponseHeader && self.getResponseHeader("content-type") || "";
							if (ct.indexOf("json") < 0) return;
							forward(self.__dshBridgeUrl || "", JSON.parse(self.responseText));
						} catch (e) {}
					});
					return os.apply(this, arguments);
				};
				window.XMLHttpRequest.prototype.open.__dshBridgePatched = true;
			}
		}

		function start() {
			if (armed) return;
			armed = true;
			fetchConfig().then(function (j) {
				if (!j) { log("узел не найден, повтор через 5с"); armed = false; setTimeout(start, 5000); return; }
				cfg = j;
				log("привязан к узлу", nodeBase);
				heartbeat();
				hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
				sniffInstall();
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
