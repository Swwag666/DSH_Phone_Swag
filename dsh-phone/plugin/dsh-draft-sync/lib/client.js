window.__ModuleLoader__.load({
	id: "dsh-draft-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region engine
		var VERSION = 1;
		var NODE_BASES = ["http://127.0.0.1:8460", "http://localhost:8460"];
		var ORIGIN_ID = "dsh-desktop";
		var PUSH_DELAY_MS = 600;
		var POLL_IDLE_MS = 900;
		var GRACE_MS = 2500;
		var MAX_TEXT = 10000;
		var RETRY_MS = 5000;

		var cfg = null;          // {token, port}
		var nodeBase = null;
		var sessionId = null;    // harness external id, e.g. session-<uuid>
		var since = 0;
		var el = null;           // composer [data-composer-input]
		var pushTimer = 0;
		var lastLocalInput = 0;  // ms epoch of the last keystroke here
		var lastPushedText = null;
		var applyingRemote = false;
		var alive = false;
		var pollAbort = null;
		var mo = null;

		function log() {
			try {
				var args = Array.prototype.slice.call(arguments);
				args.unshift("[dsh-draft-sync]");
				console.log.apply(console, args);
			} catch (e) {}
		}

		function now() {
			return Date.now();
		}

		function composerText() {
			if (!el) return "";
			// innerText keeps paragraph breaks, textContent glues them together
			var t = (typeof el.innerText === "string" ? el.innerText : el.textContent) || "";
			return t.slice(0, MAX_TEXT);
		}

		function applyComposerText(text) {
			if (!el) return;
			applyingRemote = true;
			try {
				el.focus();
				var sel = window.getSelection();
				var range = document.createRange();
				range.selectNodeContents(el);
				sel.removeAllRanges();
				sel.addRange(range);
				// insertText goes through the native input pipeline, so the Lexical
				// editor picks the change up as a real edit event
				var ok = document.execCommand("insertText", false, text);
				if (!ok) {
					// fallback: whole-content replacement without the caret dance
					el.textContent = text;
					el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
				}
				if (!text) {
					// wiped draft: make sure the placeholder state resets
					el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
				}
			} catch (e) {
				log("apply failed", e && e.message);
			} finally {
				lastPushedText = text;
				applyingRemote = false;
			}
		}

		function fetchConfig() {
			var i = 0;
			function attempt() {
				if (i >= NODE_BASES.length) return Promise.resolve(null);
				var base = NODE_BASES[i++];
				return fetch(base + "/api/draft-config", { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (j) {
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

		function nodeRequest(method, params) {
			return fetch(nodeBase + "/api/rpc", {
				method: "POST",
				headers: { "content-type": "application/json", "x-dsh-token": cfg.token },
				body: JSON.stringify({ token: cfg.token, method: method, params: params })
			}).then(function (r) { return r.ok ? r.json() : null; });
		}

		function pushDraft(force) {
			if (!alive || !cfg || !sessionId || !el) return;
			var text = composerText();
			if (!force && text === lastPushedText) return;
			lastPushedText = text;
			nodeRequest("session.updateDraft", { sessionId: sessionId, text: text, origin: ORIGIN_ID })
				.then(function (j) {
					if (j && j.ok) return;
					// token rotated or the node restarted: re-bootstrap once
					log("push rejected, re-reading config");
					cfg = null;
					bootstrap();
				})
				.catch(function () {});
		}

		function schedulePush() {
			if (applyingRemote) return;
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

		function handleEvents(events) {
			for (var i = 0; i < events.length; i++) {
				var ev = events[i] || {};
				if ((ev.type === "items" || ev.type === "turnEnded" || ev.type === "state") && ev.data && ev.data.externalSessionId) {
					trackActivity(ev.data.externalSessionId);
				}
				if (ev.type !== "draft" || !ev.data) continue;
				var d = ev.data;
				if (d.origin === ORIGIN_ID) continue; // own echo
				if (!sameTarget(d)) continue;
				if (applyingRemote) continue;
				var busyTyping = document.activeElement === el && (now() - lastLocalInput) < GRACE_MS;
				if (busyTyping) continue;
				applyComposerText(String(d.text || ""));
			}
		}

		// --- activity fallback: if the GUI never fires a window.fetch/XHR we
		// can sniff, the plugin still binds a session two ways: the node
		// forwards live items/turnEnded with the harness session id, and
		// session.list ranks sessions by orderingTime (the freshest one is
		// the chat the user has open) ---
		var lastSniffAt = 0;
		var lastActivityAt = 0;
		var adoptedBy = "";         // "sniff" | "activity" | "list"
		var listProbedAt = 0;

		function trackActivity(externalId) {
			if (!externalId || externalId === sessionId) return;
			// adopt only when sniffing stayed silent; once sniffed, the GUI's
			// own session-open calls win (exact chat the user switched to)
			if (sessionId && (now() - lastSniffAt) < 300000) return;
			// activity can bounce between parallel agent sessions - cool it down
			if (now() - lastActivityAt < 120000) return;
			lastActivityAt = now();
			adoptSession(externalId, "activity");
		}

		// One-shot rescue when nothing else bound a session: take the freshest
		// live session from session.list (max orderingTime).
		function probeSessionList() {
			if (!cfg || sessionId) return;
			if (now() - listProbedAt < 60000) return;
			listProbedAt = now();
			nodeRequest("session.list", {})
				.then(function (j) {
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
				.catch(function () {});
		}

		function adoptSession(id, why) {
			if (id === sessionId) return;
			sessionId = id;
			adoptedBy = why;
			lastPushedText = null;
			log("active session (" + why + "):", sessionId);
			if (cfg) {
				loadExistingDraft();
				pushDraft(false);
			}
		}

		function pollLoop() {
			if (!alive || !cfg) return;
			if (pollAbort) pollAbort.abort();
			pollAbort = new AbortController();
			var url = nodeBase + "/api/events?since=" + encodeURIComponent(String(since)) + "&had=1&token=" + encodeURIComponent(cfg.token);
			fetch(url, { cache: "no-store", signal: pollAbort.signal, headers: { "x-dsh-token": cfg.token } })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (j) {
					if (!alive || !j) throw new Error("no data");
					since = Number(j.ts) || since;
					handleEvents(j.events || []);
					setTimeout(pollLoop, 60);
				})
				.catch(function (e) {
					if (!alive) return;
					if (e && e.name === "AbortError") return;
					// node down or auth gone: back off, re-bootstrap
					cfg = null;
					setTimeout(bootstrap, RETRY_MS);
				});
		}

		function loadExistingDraft() {
			if (!cfg || !sessionId) return;
			nodeRequest("session.getDraft", { sessionId: sessionId })
				.then(function (j) {
					var d = j && j.result;
					if (!d) return;
					var text = String(d.text || "");
					if (!text) return;
					if (composerText()) return; // never clobber local content
					if (d.origin === ORIGIN_ID) return;
					applyComposerText(text);
				})
				.catch(function () {});
		}

		// --- active session tracking: sniff the page's own /api calls ---
		var SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
		var SIDE_CHANNELS = ["/api/session/list", "/api/session/title", "/api/session/rename", "/api/session/fork", "/api/session/create"];

		function trackFromUrlAndBody(url, bodyText) {
			var m = SESSION_RE.exec(bodyText || "");
			if (!m) return;
			var path = url.indexOf("/api/") >= 0 ? url.slice(url.indexOf("/api/")) : url;
			var base = path.split("?")[0];
			for (var i = 0; i < SIDE_CHANNELS.length; i++) {
				if (base === "/api/" + SIDE_CHANNELS[i].slice(5)) return; // not an "open this session" signal
			}
			if (m[0] !== sessionId) {
				lastSniffAt = now();
				adoptSession(m[0], "sniff");
			}		}

		var FETCH_KEY = "__dshDraftSyncFetch";
		var originalFetch = null;
		var wrappedFetch = null;

		function hookFetch() {
			if (window[FETCH_KEY]) return;
			var of = window.fetch;
			if (typeof of !== "function") return;
			originalFetch = of;
			window[FETCH_KEY] = true;
			wrappedFetch = function (input, init) {
				try {
					var url = "";
					var body = null;
					if (typeof input === "string") url = input;
					else if (input && input.url) url = String(input.url);
					if (init && typeof init.body === "string") body = init.body;
					if (url.indexOf("/api/") >= 0 && (init && init.method || "GET").toUpperCase() === "POST" && body) {
						trackFromUrlAndBody(url, body);
					}
				} catch (e) {}
				return of.apply(window, arguments);
			};
			window.fetch = wrappedFetch;
		}

		function unhookFetch() {
			window[FETCH_KEY] = false;
			// only restore when our wrapper is still the top of the chain;
			// a later interceptor (e.g. DSH connection layer) stays intact
			if (originalFetch !== null && window.fetch === wrappedFetch) {
				window.fetch = originalFetch;
			}
			originalFetch = null;
			wrappedFetch = null;
		}

		// --- XHR sniffing: the GUI may talk over XMLHttpRequest instead of
		// window.fetch, so cover both transports ---
		var XHR_KEY = "__dshDraftSyncXhr";
		var xhrOpen = null;
		var xhrSend = null;

		function hookXhr() {
			if (window[XHR_KEY]) return;
			if (typeof window.XMLHttpRequest !== "function") return;
			try {
				xhrOpen = XMLHttpRequest.prototype.open;
				xhrSend = XMLHttpRequest.prototype.send;
				window[XHR_KEY] = true;
				XMLHttpRequest.prototype.open = function (method, url) {
					try { this.__dshSyncUrl = String(url || ""); } catch (e) {}
					return xhrOpen.apply(this, arguments);
				};
				XMLHttpRequest.prototype.send = function (body) {
					try {
						if (this.__dshSyncUrl && this.__dshSyncUrl.indexOf("/api/") >= 0 && typeof body === "string") {
							trackFromUrlAndBody(this.__dshSyncUrl, body);
						}
					} catch (e) {}
					return xhrSend.apply(this, arguments);
				};
			} catch (e) {}
		}

		function unhookXhr() {
			window[XHR_KEY] = false;
			try {
				if (xhrOpen !== null && XMLHttpRequest.prototype.open !== xhrOpen) {
					// someone wrapped after us - leave theirs in place
				}
				XMLHttpRequest.prototype.open = xhrOpen || XMLHttpRequest.prototype.open;
				XMLHttpRequest.prototype.send = xhrSend || XMLHttpRequest.prototype.send;
			} catch (e) {}
			xhrOpen = null;
			xhrSend = null;
		}

		// --- heartbeat: lets the node's /api/health report whether this client
		// bound a session and found the composer, without opening any console ---
		var heartbeatTimer = 0;

		function heartbeat() {
			if (!alive || !cfg || !nodeBase) return;
			probeSessionList();
			nodeRequest("session.pluginPing", {
				origin: ORIGIN_ID,
				hasSession: !!sessionId,
				sessionId: sessionId || "",
				sessionSource: adoptedBy || "",
				hasComposer: !!(el && el.isConnected),
				url: String(location.href || "").slice(0, 200)
			}).catch(function () {});
		}

		function startHeartbeat() {
			if (heartbeatTimer) return;
			heartbeat();
			heartbeatTimer = setInterval(heartbeat, 15000);
		}

		function stopHeartbeat() {
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
		}

		function watchComposer() {
			if (el && el.isConnected) return;
			var found = document.querySelector('[data-composer-input]');
			if (found) {
				el = found;
				lastPushedText = null;
				el.addEventListener("input", schedulePush, true);
				log("composer attached");
				if (cfg && sessionId) loadExistingDraft();
				return;
			}
			setTimeout(watchComposer, 800);
		}

		function observeDom() {
			if (typeof MutationObserver !== "function") { setTimeout(watchComposer, 800); return; }
			mo = new MutationObserver(function () {
				if (!el || !el.isConnected) {
					if (el) { el = null; }
					watchComposer();
				}
			});
			mo.observe(document.documentElement, { childList: true, subtree: true });
			watchComposer();
		}

		function bootstrap() {
			if (!alive) return;
			if (cfg) { pollLoop(); startHeartbeat(); return; }
			fetchConfig().then(function (j) {
				if (!alive) return;
				if (!j) { setTimeout(bootstrap, RETRY_MS); return; }
				cfg = j;
				log("linked to dsh-phone node", nodeBase, "v" + (j.version || "?"));
				if (sessionId) { loadExistingDraft(); pushDraft(false); }
				pollLoop();
				startHeartbeat();
			});
		}

		function startEngine() {
			alive = true;
			hookFetch();
			hookXhr();
			if (document.readyState === "loading") {
				document.addEventListener("DOMContentLoaded", function () { if (alive) { observeDom(); bootstrap(); } });
			} else {
				observeDom();
				bootstrap();
			}
			log("v" + VERSION + " armed (plugin)");
			return function stopEngine() {
				alive = false;
				if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
				if (pollAbort) { try { pollAbort.abort(); } catch (e) {} pollAbort = null; }
				if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
				if (el) { try { el.removeEventListener("input", schedulePush, true); } catch (e) {} }
				stopHeartbeat();
				unhookFetch();
				unhookXhr();
				log("stopped");
			};
		}
		//#endregion
		exports.VERSION = VERSION;
		exports.apply = function (ctx) {
			ctx.effect(function () {
				return startEngine();
			}, "dsh-draft-sync: engine");
		};
		exports.inject = [];
		return module.exports;
	}
});
