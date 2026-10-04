window.__ModuleLoader__.load({
	id: "dsh-draft-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// P8: marker for the gui patch (gui/draftsync-desktop.js) so the two
		// engines never arm side by side in one document. The plugin is the
		// richer engine (teardown, heartbeat, XHR sniffing), so it wins.
		window.__dshDraftSyncPlugin = true;
		//#region engine
		var VERSION = 2;
		var NODE_PORT = 8460;
		// :8460 - основной порт узла (http, либо https когда включён TLS).
		// :8461 - loopback-only http, который узел поднимает при TLS, чтобы
		// этот плагин не терял бутстрап. Перебираем оба, первый живой wins.
		var NODE_BASES = [
			"http://127.0.0.1:" + NODE_PORT,
			"http://127.0.0.1:" + (NODE_PORT + 1),
			"http://localhost:" + NODE_PORT,
			"http://localhost:" + (NODE_PORT + 1)
		];
		var ORIGIN_ID = "dsh-desktop";
		var PUSH_DELAY_MS = 600;
		var POLL_BUSY_MS = 60;     // активный темп: вкладка видима и пользователь рядом
		var POLL_IDLE_MS = 900;    // P2: idle-backoff (скрытая вкладка / нет composer / простой)
		var GRACE_MS = 2500;
		var MAX_TEXT = 10000;
		var RETRY_MS = 5000;
		var HEARTBEAT_MS = 15000;
		var WATCH_RETRY_MS = 800;
		var WATCH_CHECK_MS = 1500; // P3: единственный «health tick» проверки composer
		var MUTATION_DEBOUNCE_MS = 120;
		var IDLE_AFTER_MS = 30000;
		var ARM_KEY = "__dshDraftSyncArmed";
		var ARM_VALUE = "dsh-draft-sync-plugin";

		var cfg = null;          // {token, port}
		var nodeBase = null;
		var sessionId = null;    // harness external id, e.g. session-<uuid>
		var since = 0;
		var el = null;           // composer [data-composer-input]
		var pushTimer = 0;
		var lastLocalInput = 0;  // ms epoch of the last keystroke here
		var lastPushedText = null;
		var applyingRemote = false;
		var pendingRemoteText = null; // D8-style: текст, отложенный пока вкладка скрыта
		var alive = false;
		var engineEpoch = 0;     // P1/P4/D9: инкремент на каждый stop → async-хвосты отбрасываются
		var sessionEpoch = 0;    // P7: инкремент на каждую смену привязки сессии
		var pollAbort = null;
		var pollHandle = 0;      // P2: id таймера poll-цепочки
		var pollRunning = false; // P2: живёт ли цепочка
		var bootstrapping = false; // P2: single-flight fetchConfig
		var bootHandle = 0;      // P2: id отложенного bootstrap
		var watchHandle = 0;     // P3: единственный retry-таймер поиска composer
		var watchPending = false;// P3: debounce мутаций
		var mo = null;
		var moTarget = null;     // P3: за чем сейчас наблюдаем
		var attachedEls = [];    // P9: все узлы, на которые вешали слушатель
		var activeStop = null;   // P10: dispose предыдущего запуска эффекта
		var visibilityBound = false;

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

		function composerAttached() {
			return !!(el && el.nodeType === 1 && el.hasAttribute && el.hasAttribute("data-composer-input") && el.isConnected);
		}

		function composerText() {
			if (!el) return "";
			// innerText keeps paragraph breaks, textContent glues them together
			var t = (typeof el.innerText === "string" ? el.innerText : el.textContent) || "";
			return t.slice(0, MAX_TEXT);
		}

		function setComposerContent(text) {
			// fallback path: whole-content replacement without the caret dance
			el.textContent = text;
			el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		}

		function applyComposerText(text) {
			if (!el) return;
			// Never touch an editor the user cannot see: stash the text and
			// flush it on visibilitychange instead of stealing focus.
			if (typeof document === "object" && document.hidden) {
				pendingRemoteText = text;
				return;
			}
			pendingRemoteText = null;
			applyingRemote = true;
			try {
				var active = document.activeElement;
				// Only take focus when nothing else owns it. If the user is
				// typing in another field we replace the content without
				// execCommand and without moving the caret.
				var focusFree = !!(active && active !== el && active !== document.body && active !== document.documentElement);
				var ok = false;
				if (!focusFree) {
					el.focus();
					var sel = window.getSelection();
					var range = document.createRange();
					range.selectNodeContents(el);
					sel.removeAllRanges();
					sel.addRange(range);
					// insertText goes through the native input pipeline, so the Lexical
					// editor picks the change up as a real edit event. execCommand is
					// deprecated - it is tried first only because it is the one path
					// Lexical observes as a real edit, and we fall back when it is gone.
					try {
						ok = !!(document.execCommand && document.execCommand("insertText", false, text));
					} catch (e2) {
						ok = false;
					}
				}
				if (!ok) setComposerContent(text);
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

		function onVisibilityChange() {
			if (!alive) return;
			if (document.hidden) return;
			if (pendingRemoteText !== null) {
				var text = pendingRemoteText;
				pendingRemoteText = null;
				if (!applyingRemote && text !== composerText()) applyComposerText(text);
			}
			// hidden -> visible: return to the active tempo at once
			if (pollRunning && pollHandle) {
				clearTimeout(pollHandle);
				pollHandle = 0;
				pollLoop();
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

		// P5: never build a request without a config and a node base (that used
		// to mean a call to "null/api/rpc" or a synchronous TypeError on
		// cfg.token), and never let a rejection escape to the caller.
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

		function pushDraft(force) {
			if (!alive || !cfg || !nodeBase || !sessionId || !el) return;
			var text = composerText();
			if (!force && text === lastPushedText) return;
			lastPushedText = text;
			var epoch = engineEpoch;
			nodeRequest("session.updateDraft", { sessionId: sessionId, text: text, origin: ORIGIN_ID })
				.then(function (j) {
					if (!alive || epoch !== engineEpoch) return;
					if (j && j.ok) return;
					// token rotated or the node restarted: re-bootstrap once
					log("push rejected, re-reading config");
					lastPushedText = null;
					cfg = null;
					nodeBase = null;
					scheduleBootstrap(RETRY_MS);
				})
				.catch(function () {});
		}

		function schedulePush() {
			if (!alive || applyingRemote) return;
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

		// D9/P7: events are matched against the session and engine epoch that
		// were current when the request went out, so a rebind or an engine
		// restart in flight can no longer apply stale text.
		function handleEvents(events, reqEpoch, reqSessionEpoch, reqSessionId) {
			if (!alive || reqEpoch !== engineEpoch || reqSessionEpoch !== sessionEpoch) return;
			for (var i = 0; i < events.length; i++) {
				var ev = events[i] || {};
				if ((ev.type === "items" || ev.type === "turnEnded" || ev.type === "state") && ev.data && ev.data.externalSessionId) {
					trackActivity(ev.data.externalSessionId);
				}
				if (ev.type !== "draft" || !ev.data) continue;
				var d = ev.data;
				if (d.origin === ORIGIN_ID) continue; // own echo
				if (!sameTarget(d)) continue;
				if (reqSessionId && reqSessionId !== sessionId) continue; // rebound while polling
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
		var listProbeInFlight = false; // P7: one session.list at a time

		function trackActivity(externalId) {
			if (!alive || !externalId || externalId === sessionId) return;
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
			if (!alive || !cfg || !nodeBase || sessionId) return;
			if (listProbeInFlight) return;
			if (now() - listProbedAt < 60000) return;
			listProbedAt = now();
			listProbeInFlight = true;
			var epoch = engineEpoch;
			var sessEpoch = sessionEpoch;
			nodeRequest("session.list", {})
				.then(function (j) {
					listProbeInFlight = false;
					if (!alive || epoch !== engineEpoch || sessEpoch !== sessionEpoch) return;
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
			if (!alive || !id || id === sessionId) return;
			sessionId = id;
			sessionEpoch++;    // P7/D9: in-flight answers for the old session die
			adoptedBy = why;
			lastPushedText = null;
			log("active session (" + why + "):", sessionId);
			if (cfg && nodeBase) {
				loadExistingDraft();
				pushDraft(false);
			}
		}

		// --- P2: the poll chain is a single, tracked, cancellable loop -----
		function pollDelay() {
			if (typeof document === "object" && document.hidden) return POLL_IDLE_MS;
			if (!composerAttached()) return POLL_IDLE_MS;
			if (lastLocalInput && (now() - lastLocalInput) > IDLE_AFTER_MS) return POLL_IDLE_MS;
			return POLL_BUSY_MS;
		}

		function startPoll() {
			if (!alive || pollRunning) return;
			pollRunning = true;
			pollLoop();
		}

		function stopPoll() {
			pollRunning = false;
			if (pollHandle) { clearTimeout(pollHandle); pollHandle = 0; }
			if (pollAbort) { try { pollAbort.abort(); } catch (e) {} pollAbort = null; }
		}

		function schedulePoll(delay) {
			if (!alive || !pollRunning) return;
			if (pollHandle) clearTimeout(pollHandle);
			var epoch = engineEpoch;
			pollHandle = setTimeout(function () {
				pollHandle = 0;
				if (!alive || !pollRunning || epoch !== engineEpoch) return;
				pollLoop();
			}, delay);
		}

		function pollLoop() {
			if (!alive || !pollRunning) return;
			if (!cfg || !nodeBase) { pollRunning = false; return; }
			if (pollAbort) { try { pollAbort.abort(); } catch (e) {} }
			var ac = new AbortController();
			pollAbort = ac;
			var epoch = engineEpoch;
			var sessEpoch = sessionEpoch;
			var sid = sessionId;
			// Token travels in the x-dsh-token header only (the node reads the
			// header first); it no longer lands in the access log via the query.
			var url = nodeBase + "/api/events?since=" + encodeURIComponent(String(since)) + "&had=1";
			fetch(url, { cache: "no-store", signal: ac.signal, headers: { "x-dsh-token": cfg.token } })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (j) {
					if (!alive || epoch !== engineEpoch) return;
					if (!j) throw new Error("no data");
					since = Number(j.ts) || since;
					handleEvents(j.events || [], epoch, sessEpoch, sid);
					schedulePoll(pollDelay());
				})
				.catch(function (e) {
					if (!alive || epoch !== engineEpoch) return;
					if (e && e.name === "AbortError") return;
					if (!pollRunning) return;
					// node down or auth gone: back off, re-bootstrap (single-flight)
					pollRunning = false;
					cfg = null;
					nodeBase = null;
					scheduleBootstrap(RETRY_MS);
				});
		}

		function loadExistingDraft() {
			if (!alive || !cfg || !nodeBase || !sessionId) return;
			var sid = sessionId;
			var epoch = engineEpoch;
			var sessEpoch = sessionEpoch;
			nodeRequest("session.getDraft", { sessionId: sid })
				.then(function (j) {
					if (!alive || epoch !== engineEpoch || sessEpoch !== sessionEpoch || sid !== sessionId) return;
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
		// Names WITHOUT the "/api/" prefix: the old comparison built
		// "/api//api/session/list", never matched, and service calls ended up
		// hijacking the bound session (same defect as D4 in the gui patch).
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
			if (!alive) return;
			var m = SESSION_RE.exec(bodyText || "");
			if (!m) return;
			if (isSideChannel(url)) return; // not an "open this session" signal
			if (m[0] !== sessionId) {
				lastSniffAt = now();
				adoptSession(m[0], "sniff");
			}
		}

		var FETCH_KEY = "__dshDraftSyncFetch";
		var originalFetch = null;
		var wrappedFetch = null;
		var fetchHooked = false;

		function hookFetch() {
			if (fetchHooked) return;
			var of = window.fetch;
			if (typeof of !== "function") return;
			originalFetch = of;
			wrappedFetch = function (input, init) {
				try {
					var url = "";
					var body = null;
					if (typeof input === "string") url = input;
					else if (input && input.url) url = String(input.url);
					if (init && typeof init.body === "string") body = init.body;
					if (url.indexOf("/api/") >= 0 && ((init && init.method) || "GET").toUpperCase() === "POST" && body) {
						trackFromUrlAndBody(url, body);
					}
				} catch (e) {}
				return of.apply(window, arguments);
			};
			window[FETCH_KEY] = true;
			window.fetch = wrappedFetch;
			fetchHooked = true;
		}

		function unhookFetch() {
			window[FETCH_KEY] = false;
			// only restore when our wrapper is still the top of the chain;
			// a later interceptor (e.g. DSH connection layer) stays intact
			if (fetchHooked && originalFetch !== null && window.fetch === wrappedFetch) {
				window.fetch = originalFetch;
			}
			fetchHooked = false;
			originalFetch = null;
			wrappedFetch = null;
		}

		// --- XHR sniffing: the GUI may talk over XMLHttpRequest instead of
		// window.fetch, so cover both transports ---
		var XHR_KEY = "__dshDraftSyncXhr";
		var xhrOpen = null;
		var xhrSend = null;
		var wrappedXhrOpen = null;
		var wrappedXhrSend = null;
		var xhrHooked = false;

		function hookXhr() {
			if (xhrHooked) return;
			if (typeof window.XMLHttpRequest !== "function") return;
			try {
				var open = XMLHttpRequest.prototype.open;
				var send = XMLHttpRequest.prototype.send;
				if (typeof open !== "function" || typeof send !== "function") return;
				wrappedXhrOpen = function (method, url) {
					try { this.__dshSyncUrl = String(url || ""); } catch (e) {}
					return open.apply(this, arguments);
				};
				wrappedXhrSend = function (body) {
					try {
						if (this.__dshSyncUrl && this.__dshSyncUrl.indexOf("/api/") >= 0 && typeof body === "string") {
							trackFromUrlAndBody(this.__dshSyncUrl, body);
						}
					} catch (e) {}
					return send.apply(this, arguments);
				};
				// assign as a pair, and only after both wrappers exist, so a
				// partial failure can never leave open hooked without send
				xhrOpen = open;
				xhrSend = send;
				XMLHttpRequest.prototype.open = wrappedXhrOpen;
				XMLHttpRequest.prototype.send = wrappedXhrSend;
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
				// P6: restore the pair only while our wrappers are still on top
				// of the chain. If someone wrapped after us, their wrapper stays.
				var topIsOurs = XMLHttpRequest.prototype.open === wrappedXhrOpen &&
					XMLHttpRequest.prototype.send === wrappedXhrSend;
				if (topIsOurs && xhrOpen && xhrSend) {
					XMLHttpRequest.prototype.open = xhrOpen;
					XMLHttpRequest.prototype.send = xhrSend;
				}
			} catch (e) {}
			xhrOpen = null;
			xhrSend = null;
			wrappedXhrOpen = null;
			wrappedXhrSend = null;
		}

		// --- heartbeat: lets the node's /api/health report whether this client
		// bound a session and found the composer, without opening any console ---
		var heartbeatTimer = 0;
		var heartbeatEpoch = 0;

		function heartbeat() {
			if (!alive || !cfg || !nodeBase) return;
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

		// P4: exactly one interval per engine generation. The epoch is captured
		// at start, so an interval that outlives its engine clears itself.
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

		// --- P9: listener bookkeeping for every node we ever attached to ---
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

		// --- P3: one tracked retry chain + debounced, narrowly scoped observer
		function watchComposer() {
			watchPending = false;
			if (!alive) return;
			if (el && !composerAttached()) {
				// composer node was replaced: drop the listener from the old one
				releaseEl(el);
				el = null;
				retargetObserver(null);
			}
			if (composerAttached()) {
				// health tick: the observer is narrowed to the composer container,
				// so a single tracked timer re-validates the attachment (and
				// re-widens the observer) if the whole view is swapped out
				retargetObserver(el);
				scheduleWatch(WATCH_CHECK_MS);
				return;
			}
			var found = document.querySelector('[data-composer-input]');
			if (found) {
				el = found;
				lastPushedText = null;
				listenEl(el);
				log("composer attached");
				retargetObserver(el);
				scheduleWatch(WATCH_CHECK_MS);
				if (cfg && nodeBase && sessionId) loadExistingDraft();
				return;
			}
			scheduleWatch(WATCH_RETRY_MS);
		}

		function scheduleWatch(delay) {
			if (!alive) return;
			if (watchHandle) return; // exactly one pending retry chain
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
			if (!alive) return;
			if (composerAttached()) return; // nothing to re-bind
			if (watchPending) return;       // a fast re-check is already queued
			// debounce: coalesce a burst of mutations into ONE re-check, and jump
			// ahead of the slow health tick instead of stacking another timer
			watchPending = true;
			if (watchHandle) { clearTimeout(watchHandle); watchHandle = 0; }
			scheduleWatch(MUTATION_DEBOUNCE_MS);
		}

		// Observe the composer's own container once we know where it lives;
		// fall back to the document only while the composer is missing.
		function retargetObserver(node) {
			if (!alive || !mo) return;
			var target = node && node.parentNode ? node.parentNode : document.documentElement;
			if (moTarget === target) return;
			try { mo.disconnect(); } catch (e) {}
			moTarget = target;
			try { mo.observe(target, { childList: true, subtree: true }); } catch (e) { moTarget = null; }
		}

		function observeDom() {
			if (typeof MutationObserver !== "function") { scheduleWatch(WATCH_RETRY_MS); return; }
			if (!mo) {
				mo = new MutationObserver(mutationSeen);
				moTarget = null;
			}
			retargetObserver(null);
			watchComposer();
		}

		// --- P2: single-flight bootstrap with a tracked retry timer --------
		function scheduleBootstrap(delay) {
			if (!alive) return;
			if (bootHandle) clearTimeout(bootHandle);
			var epoch = engineEpoch;
			bootHandle = setTimeout(function () {
				bootHandle = 0;
				if (!alive || epoch !== engineEpoch) return;
				bootstrap();
			}, delay);
		}

		function bootstrap() {
			if (!alive) return;
			if (cfg && nodeBase) { startPoll(); startHeartbeat(engineEpoch); return; }
			if (bootstrapping) return;
			bootstrapping = true;
			var epoch = engineEpoch;
			fetchConfig().then(function (j) {
				bootstrapping = false;
				if (!alive || epoch !== engineEpoch) return;
				if (!j) { scheduleBootstrap(RETRY_MS); return; }
				cfg = j;
				log("linked to dsh-phone node", nodeBase, "v" + (j.version || "?"));
				if (sessionId) { loadExistingDraft(); pushDraft(false); }
				startPoll();
				startHeartbeat(epoch);
			}).catch(function () {
				bootstrapping = false;
				if (alive && epoch === engineEpoch) scheduleBootstrap(RETRY_MS);
			});
		}

		// --- P1: full state reset, so a restarted engine re-reads its config
		function resetState() {
			cfg = null;
			nodeBase = null;
			sessionId = null;
			since = 0;
			lastPushedText = null;
			lastLocalInput = 0;
			pendingRemoteText = null;
			applyingRemote = false;
			adoptedBy = "";
			lastSniffAt = 0;
			lastActivityAt = 0;
			listProbedAt = 0;
			listProbeInFlight = false;
			sessionEpoch++;
		}

		function teardown() {
			engineEpoch++;   // kills every in-flight .then of this generation
			alive = false;
			stopPoll();
			if (bootHandle) { clearTimeout(bootHandle); bootHandle = 0; }
			bootstrapping = false;
			stopWatch();
			if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
			stopHeartbeat();
			if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; moTarget = null; }
			releaseAllEls();
			el = null;
			unbindVisibility();
			unhookFetch();
			unhookXhr();
			resetState();
			if (window[ARM_KEY] === ARM_VALUE) {
				try { delete window[ARM_KEY]; } catch (e) { window[ARM_KEY] = null; }
			}
			log("stopped");
		}

		// P8: claim the document. If the gui patch armed first, take it over by
		// calling its published stop hook instead of running a second engine.
		function claimDocument() {
			var guiStop = window.__dshDesktopDraftSyncStop;
			if (typeof guiStop === "function" && window[ARM_KEY] !== ARM_VALUE) {
				try { guiStop(); } catch (e) {}
				window.__dshDesktopDraftSyncStop = null;
			}
			window[ARM_KEY] = ARM_VALUE;
		}

		function startEngine() {
			// P10: an effect can be re-run without its dispose being called -
			// tear the previous generation down before arming a new one.
			if (typeof activeStop === "function") {
				var prev = activeStop;
				activeStop = null;
				try { prev(); } catch (e) {}
			}
			if (alive) {
				// P1: never arm twice; hand back the existing dispose
				log("already armed, ignoring duplicate startEngine");
				return typeof activeStop === "function" ? activeStop : function () {};
			}

			claimDocument();
			alive = true;
			engineEpoch++;
			hookFetch();
			hookXhr();
			bindVisibility();

			function arm() {
				if (!alive) return;
				observeDom();
				bootstrap();
			}

			if (document.readyState === "loading") {
				var epoch = engineEpoch;
				document.addEventListener("DOMContentLoaded", function onReady() {
					document.removeEventListener("DOMContentLoaded", onReady);
					if (alive && epoch === engineEpoch) arm();
				});
			} else {
				arm();
			}

			log("v" + VERSION + " armed (plugin)");

			// P1: idempotent dispose - a second call cannot disturb a newer engine
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
			}, "dsh-draft-sync: engine");
		};
		exports.inject = [];
		return module.exports;
	}
});
