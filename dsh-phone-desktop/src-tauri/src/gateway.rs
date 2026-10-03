use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use crate::bridge::Bridge;
use crate::push::PushRouter;

/// A single feed event as delivered to the phone: `{"ts", "type", "data"}`.
#[derive(Clone)]
pub struct Event(pub Value);

/// One phone-facing device: its own bridge connector, its own event feed,
/// its own watched sessions. Main device + every extra device.
pub struct DeviceHub {
    pub name: String,
    pub token: String,
    pub connector_id: String,
    pub bridge: Arc<Bridge>,
    state: Mutex<HubState>,
    outbox: Mutex<Vec<OutgoingTurn>>,
    gen: AtomicU64,
    gen_tx: watch::Sender<u64>,
    refresh_pending: AtomicBool,
    event_buffer_max: usize,
    poll_seconds: f64,
    push: PushRouter,
}

/// Сообщение, принятое на занятую сессию: ждёт освобождения агента.
struct OutgoingTurn {
    session_id: String,
    params: Value,
    queued_at: f64,
    attempts: u32,
}

struct Watched {
    known_ids: HashSet<String>,
    last_state_key: String,
}

struct HubState {
    events: Vec<Event>,
    sessions: Vec<Value>,
    sessions_hash: String,
    watched: HashMap<String, Watched>,
    candidates: HashMap<String, Value>,
    /// Input-field drafts shared between phone/web clients:
    /// sessionId -> {text, origin, ts}
    drafts: HashMap<String, DraftEntry>,
    /// Last plugin heartbeat from the DSH Desktop side client.
    plugin_ping: Option<Value>,
}

#[derive(Clone)]
struct DraftEntry {
    text: String,
    origin: String,
    ts: f64,
}

/// Snapshot row for status surfaces (desktop UI / health).
#[derive(Clone, serde::Serialize)]
pub struct DeviceBrief {
    pub name: String,
    pub token: String,
    pub connector_id: String,
    pub connected: bool,
    pub main: bool,
}

pub fn now_ts() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn jitter_backoff(d: Duration) -> Duration {
    let ms = d.as_millis() as u64;
    if ms == 0 {
        return d;
    }
    let extra = (rand::random::<f64>() * 0.25 * ms as f64) as u64;
    Duration::from_millis(ms + extra)
}

impl DeviceHub {
    fn new(
        name: String,
        token: String,
        connector_id: String,
        endpoint_path: String,
        event_buffer_max: usize,
        poll_seconds: f64,
        push: PushRouter,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Value>) {
        let (notify_tx, notify_rx) = mpsc::unbounded_channel::<Value>();
        let (gen_tx, _) = watch::channel(0u64);
        let bridge = Bridge::new(endpoint_path, connector_id.clone(), notify_tx);
        let hub = Arc::new(DeviceHub {
            name,
            token,
            connector_id,
            bridge,
            state: Mutex::new(HubState {
                events: Vec::new(),
                sessions: Vec::new(),
                sessions_hash: String::new(),
                watched: HashMap::new(),
                candidates: HashMap::new(),
                drafts: HashMap::new(),
                plugin_ping: None,
            }),
            outbox: Mutex::new(Vec::new()),
            gen: AtomicU64::new(0),
            gen_tx,
            refresh_pending: AtomicBool::new(false),
            event_buffer_max,
            poll_seconds,
            push,
        });
        (hub, notify_rx)
    }

    /// Three long-lived loops per device: notify pump, bridge supervision, poller.
    fn start_background(
        self: &Arc<Self>,
        mut notify_rx: mpsc::UnboundedReceiver<Value>,
    ) -> Vec<tauri::async_runtime::JoinHandle<()>> {
        let mut handles = Vec::new();
        let this = Arc::clone(self);
        handles.push(tauri::async_runtime::spawn(async move {
            while let Some(msg) = notify_rx.recv().await {
                this.on_bridge_notify(msg).await;
            }
        }));
        let this = Arc::clone(self);
        handles.push(tauri::async_runtime::spawn(async move {
            this.bridge_loop().await;
        }));
        let this = Arc::clone(self);
        handles.push(tauri::async_runtime::spawn(async move {
            this.poll_loop().await;
        }));
        let this = Arc::clone(self);
        handles.push(tauri::async_runtime::spawn(async move {
            this.outbox_loop().await;
        }));
        handles
    }

    /// Доложить сообщение в очередь занятой сессии.
    pub fn enqueue_turn(&self, session_id: String, params: Value) {
        let mut q = self.outbox.lock().unwrap();
        q.push(OutgoingTurn {
            session_id,
            params,
            queued_at: now_ts(),
            attempts: 0,
        });
        let n = q.len();
        drop(q);
        self.push_event("queued_message", json!({ "depth": n }));
    }

    /// Сессия сейчас занята (агент думает / ждёт подтверждения)?
    async fn session_busy(&self, sid: &str) -> bool {
        match self
            .bridge
            .request(
                "session.getState",
                json!({ "sessionId": sid }),
                Duration::from_secs(6),
            )
            .await
        {
            Ok(v) => {
                let st = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
                matches!(
                    st,
                    "running" | "working" | "waiting" | "pending" | "blocked"
                ) || st.starts_with("waiting")
            }
            Err(_) => false,
        }
    }

    /// Разгон очереди: как только сессия освободилась - сообщение уходит агенту.
    async fn outbox_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !self.bridge.is_connected() {
                continue;
            }
            loop {
                let item = {
                    let mut q = self.outbox.lock().unwrap();
                    if q.is_empty() {
                        None
                    } else {
                        Some(q.remove(0))
                    }
                };
                let mut item = match item {
                    Some(i) => i,
                    None => break,
                };
                if now_ts() - item.queued_at > 1800.0 {
                    self.push_event("queued_drop", json!({ "reason": "stale" }));
                    continue;
                }
                if self.session_busy(&item.session_id).await {
                    let mut q = self.outbox.lock().unwrap();
                    q.insert(0, item);
                    break;
                }
                match self
                    .bridge
                    .request("session.startTurn", item.params.clone(), Duration::from_secs(120))
                    .await
                {
                    Ok(_) => {
                        self.clear_draft(&item.session_id);
                        self.push_event("queued_flush", json!({ "sessionId": item.session_id }));
                    }
                    Err(_) => {
                        item.attempts += 1;
                        let mut q = self.outbox.lock().unwrap();
                        if item.attempts < 5 {
                            q.insert(0, item);
                        } else {
                            self.push_event("queued_drop", json!({ "reason": "bridge" }));
                        }
                        break;
                    }
                }
            }
        }
    }

    pub fn gen_rx(&self) -> watch::Receiver<u64> {
        self.gen_tx.subscribe()
    }

    /// Human label for a session (title, else cwd, else "агент").
    fn session_label(&self, sid: &str) -> String {
        let st = self.state.lock().unwrap();
        for s in st.sessions.iter() {
            if s.get("sessionId").and_then(|v| v.as_str()) == Some(sid) {
                let t = s
                    .get("title")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                let cwd = s.get("cwd").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
                return t.or(cwd).unwrap_or("агент").to_string();
            }
        }
        "агент".to_string()
    }

    /// Fire a push/ntfy notification for this hub's sessions.
    fn push_notice(&self, title: &str, body: String, tag: String, sid: Option<String>) {
        self.push.dispatch(&crate::push::Notice {
            title: title.to_string(),
            body,
            tag,
            session_id: sid,
        });
    }

    fn push_event(&self, type_: &str, data: Value) {
        {
            let mut st = self.state.lock().unwrap();
            st.events.push(Event(json!({
                "ts": now_ts(),
                "type": type_,
                "data": data,
            })));
            let max = self.event_buffer_max;
            if st.events.len() > max {
                let cut = st.events.len() - max;
                st.events.drain(0..cut);
            }
        }
        let g = self.gen.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.gen_tx.send(g);
    }

    pub async fn collect_events(&self, since: f64) -> Vec<Event> {
        let st = self.state.lock().unwrap();
        st.events
            .iter()
            .filter(|e| e.0.get("ts").and_then(|t| t.as_f64()).unwrap_or(0.0) > since)
            .cloned()
            .collect()
    }

    pub async fn sessions_snapshot(&self) -> Value {
        let st = self.state.lock().unwrap();
        json!({ "sessions": st.sessions })
    }

    pub async fn watch(&self, sid: String) {
        let mut st = self.state.lock().unwrap();
        st.watched.entry(sid).or_insert_with(|| Watched {
            known_ids: HashSet::new(),
            last_state_key: String::new(),
        });
    }

    pub async fn unwatch(&self, sid: &str) {
        let mut st = self.state.lock().unwrap();
        st.watched.remove(sid);
    }

    // ---------------- input-field draft sync ----------------

    /// Map any accepted session identifier onto the bridge-side draft key:
    /// sess_dsh_xxx stays as-is; a harness external id (session-uuid) resolves
    /// through the live session list so DSH Desktop and the PWA share one slot.
    pub fn resolve_draft_key(&self, sid: &str) -> String {
        {
            let st = self.state.lock().unwrap();
            if st.drafts.contains_key(sid) {
                return sid.to_string();
            }
            for s in &st.sessions {
                if s.get("externalSessionId").and_then(|v| v.as_str()) == Some(sid) {
                    if let Some(k) = s.get("sessionId").and_then(|v| v.as_str()) {
                        return k.to_string();
                    }
                }
            }
        }
        sid.to_string()
    }

    /// The harness-side external id for a bridge session, when known.
    fn external_for(&self, sid: &str) -> Option<String> {
        let st = self.state.lock().unwrap();
        st.sessions
            .iter()
            .find(|s| s.get("sessionId").and_then(|v| v.as_str()) == Some(sid))
            .and_then(|s| s.get("externalSessionId").and_then(|v| v.as_str()))
            .map(|x| x.to_string())
    }

    /// Store one draft and push it to every connected client.
    pub fn set_draft(&self, sid: &str, text: &str, origin: &str) {
        let ts = now_ts();
        {
            let mut st = self.state.lock().unwrap();
            st.drafts.insert(
                sid.to_string(),
                DraftEntry {
                    text: text.chars().take(10_000).collect(),
                    origin: origin.chars().take(64).collect(),
                    ts,
                },
            );
            if st.drafts.len() > 64 {
                let mut by_age: Vec<(f64, String)> = st
                    .drafts
                    .iter()
                    .map(|(k, v)| (v.ts, k.clone()))
                    .collect();
                by_age.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                let cut = by_age.len().saturating_sub(32);
                for (_, k) in by_age.into_iter().take(cut) {
                    st.drafts.remove(&k);
                }
            }
        }
        let ext = self.external_for(sid);
        self.push_event(
            "draft",
            json!({
                "sessionId": sid,
                "externalSessionId": ext,
                "text": text,
                "origin": origin,
                "ts": ts
            }),
        );
    }

    /// A sent message consumed the draft - wipe it on all clients.
    pub fn clear_draft(&self, sid: &str) {
        let had = {
            let mut st = self.state.lock().unwrap();
            st.drafts.remove(sid).is_some()
        };
        if had {
            let ext = self.external_for(sid);
            self.push_event(
                "draft",
                json!({
                    "sessionId": sid,
                    "externalSessionId": ext,
                    "text": "",
                    "origin": "",
                    "ts": now_ts()
                }),
            );
        }
    }

    pub fn get_draft(&self, sid: &str) -> Value {
        let st = self.state.lock().unwrap();
        match st.drafts.get(sid) {
            Some(d) => json!({ "text": d.text, "origin": d.origin, "ts": d.ts }),
            None => json!({ "text": "", "origin": "", "ts": 0.0 }),
        }
    }

    /// Plugin heartbeat storage: the DSH Desktop side client reports whether
    /// it bound a session id and found the composer input.
    pub fn set_plugin_ping(&self, payload: Value) {
        self.state.lock().unwrap().plugin_ping = Some(payload);
    }

    pub fn plugin_ping_snapshot(&self) -> Option<Value> {
        self.state.lock().unwrap().plugin_ping.clone()
    }

    // ---------------- background loops ----------------

    async fn bridge_loop(&self) {
        let mut backoff = Duration::from_secs(1);
        loop {
            let was_connected = match self.bridge.connect().await {
                Ok(()) => {
                    backoff = Duration::from_secs(1);
                    self.push_event("bridge", json!({ "status": "connected" }));
                    let _ = self
                        .bridge
                        .request("runtime.sync.subscribe", json!({}), Duration::from_secs(15))
                        .await;
                    while self.bridge.is_connected() {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    self.push_event("bridge", json!({ "status": "disconnected" }));
                    true
                }
                Err(e) => {
                    self.push_event(
                        "bridge",
                        json!({ "status": "disconnected", "error": e, "retry_in_secs": backoff.as_secs() }),
                    );
                    false
                }
            };
            if was_connected {
                tokio::time::sleep(Duration::from_secs(1)).await;
            } else {
                tokio::time::sleep(jitter_backoff(backoff)).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        }
    }

    async fn poll_loop(&self) {
        let poll = Duration::from_secs_f64(self.poll_seconds.max(0.5));
        loop {
            tokio::time::sleep(poll).await;
            if !self.bridge.is_connected() {
                continue;
            }
            self.refresh_sessions().await;
            let sids: Vec<String> = {
                let st = self.state.lock().unwrap();
                st.watched.keys().cloned().collect()
            };
            for sid in sids {
                if !self.bridge.is_connected() {
                    break;
                }
                let _ = self.refresh_watched(&sid).await;
            }
        }
    }

    async fn refresh_sessions(&self) {
        let res = match self
            .bridge
            .request("session.list", json!({ "limit": 1000 }), Duration::from_secs(20))
            .await
        {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut sessions: Vec<Value> = res
            .get("sessions")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        let have: HashSet<String> = sessions
            .iter()
            .filter_map(|s| {
                s.get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(|x| x.to_string())
            })
            .collect();
        {
            let st = self.state.lock().unwrap();
            for (sid, c) in &st.candidates {
                if have.contains(sid) {
                    continue;
                }
                let ss = c.get("sourceState").cloned().unwrap_or(Value::Null);
                sessions.push(json!({
                    "sessionId": sid,
                    "externalSessionId": c.get("externalSessionId").cloned(),
                    "title": Value::Null,
                    "cwd": ss.get("cwd").cloned(),
                    "orderingTime": Value::Null,
                    "metadata": {
                        "live": ss.get("live").and_then(|v| v.as_bool()).unwrap_or(true),
                        "candidate": true
                    }
                }));
            }
        }
        let hash = serde_json::to_string(&sessions).unwrap_or_default();
        let changed = {
            let mut st = self.state.lock().unwrap();
            if st.sessions_hash != hash {
                st.sessions = sessions.clone();
                st.sessions_hash = hash;
                true
            } else {
                false
            }
        };
        if changed {
            self.push_event("sessions", json!({ "sessions": sessions }));
        }
    }

    async fn refresh_watched(&self, sid: &str) {
        if !self.bridge.is_connected() {
            return;
        }
        let stv = match self
            .bridge
            .request("session.getState", json!({ "sessionId": sid }), Duration::from_secs(15))
            .await
        {
            Ok(v) => v,
            Err(_) => return,
        };
        let status = stv
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let sel = stv.get("selections").and_then(|s| s.as_object());
        let pick = |k: &str| -> String {
            sel.and_then(|o| o.get(k))
                .and_then(|m| m.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let key = format!(
            "{status}|model={}|perm={}",
            pick("model"),
            pick("permission")
        );
        let state_changed = {
            let mut st = self.state.lock().unwrap();
            match st.watched.get_mut(sid) {
                Some(w) if w.last_state_key != key => {
                    w.last_state_key = key;
                    true
                }
                _ => false,
            }
        };
        if state_changed {
            let ext = self.external_for(sid);
            self.push_event("state", json!({ "sessionId": sid, "externalSessionId": ext, "state": stv }));
            if status == "waiting_approval" {
                let label = self.session_label(sid);
                self.push_notice(
                    "Нужен твой ответ",
                    label,
                    format!("appr-{sid}"),
                    Some(sid.to_string()),
                );
            }
        }
        if matches!(
            status.as_str(),
            "running" | "working" | "waiting" | "pending" | "waiting_approval"
        ) {
            let snap = match self
                .bridge
                .request(
                    "session.getSnapshot",
                    json!({ "sessionId": sid, "limit": 150 }),
                    Duration::from_secs(20),
                )
                .await
            {
                Ok(v) => v,
                Err(_) => return,
            };
            let items: Vec<Value> = snap
                .get("items")
                .and_then(|i| i.as_array())
                .cloned()
                .unwrap_or_default();
            let mut fresh: Vec<Value> = Vec::new();
            {
                let mut st = self.state.lock().unwrap();
                if let Some(w) = st.watched.get_mut(sid) {
                    for it in items {
                        if let Some(iid) = it
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|x| x.to_string())
                        {
                            if w.known_ids.insert(iid) {
                                fresh.push(it);
                            }
                        }
                    }
                    if w.known_ids.len() > 2000 {
                        // Keep the lexicographically-largest half: ids are
                        // monotonic-ish strings, so this retains the newest
                        // items deterministically (client dedupes anyway).
                        let mut all: Vec<String> = w.known_ids.iter().cloned().collect();
                        all.sort_unstable();
                        let start = all.len().saturating_sub(1000);
                        w.known_ids = all.into_iter().skip(start).collect();
                    }
                }
            }
            if !fresh.is_empty() {
                let ext = self.external_for(sid);
                self.push_event("items", json!({ "sessionId": sid, "externalSessionId": ext, "items": fresh }));
            }
        }
    }

    // ---------------- sync feed (live bridge notifications) ----------------

    async fn on_bridge_notify(&self, msg: Value) {
        let params = match msg.get("params").cloned() {
            Some(v) => v,
            None => return,
        };
        let ops = params
            .get("operations")
            .and_then(|o| o.as_array())
            .cloned();
        let stream_id = params
            .get("streamId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let batch_seq = params.get("batchSeq").and_then(|v| v.as_i64());
        if let (Some(ops), Some(sid), Some(seq)) = (ops, stream_id, batch_seq) {
            let _ = self
                .bridge
                .request(
                    "runtime.sync.ack",
                    json!({ "streamId": sid, "batchSeq": seq }),
                    Duration::from_secs(15),
                )
                .await;
            let mut refresh = false;
                for op in ops {
                    let kind = op.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                    if kind == "notifications" {
                        let ns = op
                            .get("notifications")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        for n in ns {
                            let m = n.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let p = n.get("params").cloned().unwrap_or(Value::Null);
                            match m {
                                "session.inventory.complete" => {
                                    let sess = p
                                        .get("sessions")
                                        .and_then(|v| v.as_array())
                                        .cloned()
                                        .unwrap_or_default();
                                    let mut st = self.state.lock().unwrap();
                                    for c in sess {
                                        if let Some(id) = c
                                            .get("sessionId")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string())
                                        {
                                            st.candidates.insert(id, c);
                                        }
                                    }
                                    refresh = true;
                                }
                                "timeline.itemUpsert" => {
                                    let sid2 = p
                                        .get("sessionId")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    let it = p.get("item").cloned();
                                    if let (Some(sid2), Some(it)) = (sid2, it) {
                                        // externalSessionId lets the DSH-side plugin track the
                                        // active harness session without fetch sniffing
                                        let ext = self.external_for(&sid2);
                                        self.push_event(
                                            "items",
                                            json!({ "sessionId": sid2, "externalSessionId": ext, "items": [it] }),
                                        );
                                    }
                                }
                                "session.turnEnded" => {
                                    if let Some(sid2) = p
                                        .get("sessionId")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        let ext = self.external_for(&sid2);
                                        self.push_event(
                                            "turnEnded",
                                            json!({ "sessionId": sid2, "externalSessionId": ext }),
                                        );
                                        let label = self.session_label(&sid2);
                                        self.push_notice(
                                            "Работа завершена",
                                            label,
                                            format!("turn-{sid2}"),
                                            Some(sid2),
                                        );
                                    }
                                    refresh = true;
                                }
                                "session.state"
                                | "session.meta.upsert"
                                | "session.capability.updated" => {
                                    refresh = true;
                                }
                                _ => {}
                            }
                        }
                    } else if kind == "timeline.upsert" {
                        let sid2 = op
                            .get("sessionId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let its = op
                            .get("items")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        if let Some(sid2) = sid2 {
                            if !its.is_empty() {
                                let ext = self.external_for(&sid2);
                                self.push_event(
                                    "items",
                                    json!({ "sessionId": sid2, "externalSessionId": ext, "items": its }),
                                );
                            }
                        }
                    }
                }
                if refresh {
                    self.debounced_refresh_sessions().await;
                }
        }
    }

    async fn debounced_refresh_sessions(&self) {
        if self.refresh_pending.swap(true, Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
        self.refresh_pending.store(false, Ordering::Relaxed);
        self.refresh_sessions().await;
    }
}

/// Multi-device gateway: main hub (legacy cfg.token/connector) + one hub per
/// extra device. Each hub is an isolated bridge connection, so each phone sees
/// its own window in DSH Desktop.
pub struct Gateway {
    pub cfg: std::sync::Arc<crate::config::AppConfig>,
    pub started_at: std::time::Instant,
    pub requests: std::sync::Arc<std::sync::atomic::AtomicU64>,
    hubs: Vec<Arc<DeviceHub>>,
}

/// Constant-time token comparison: no early exit on first mismatching byte,
/// so a phone-side timing probe learns nothing about the stored token.
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let n = a.len().max(b.len());
    let mut diff: u32 = (a.len() ^ b.len()) as u32;
    for i in 0..n {
        diff |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as u32;
    }
    diff == 0
}

impl Gateway {
    pub fn new(
        cfg: std::sync::Arc<crate::config::AppConfig>,
        requests: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) -> (Arc<Self>, Vec<tauri::async_runtime::JoinHandle<()>>) {
        let mut hubs = Vec::new();
        let mut bg = Vec::new();
        let push = crate::push::PushRouter::new();

        let (main, main_rx) = DeviceHub::new(
            "main".to_string(),
            cfg.token.clone(),
            cfg.connector_id.clone(),
            cfg.bridge_endpoint_path.clone(),
            cfg.event_buffer_max,
            cfg.poll_seconds,
            push.clone(),
        );
        bg.extend(main.start_background(main_rx));
        hubs.push(main);

        for d in &cfg.devices {
            let (hub, rx) = DeviceHub::new(
                d.name.clone(),
                d.token.clone(),
                d.connector_id.clone(),
                cfg.bridge_endpoint_path.clone(),
                cfg.event_buffer_max,
                cfg.poll_seconds,
                push.clone(),
            );
            bg.extend(hub.start_background(rx));
            hubs.push(hub);
        }

        let gw = Arc::new(Gateway {
            cfg,
            started_at: std::time::Instant::now(),
            requests,
            hubs,
        });
        (gw, bg)
    }

    /// Hub that owns this access token (main or extra device).
    pub fn find_hub(&self, token: &str) -> Option<Arc<DeviceHub>> {
        self.hubs.iter().find(|h| token_eq(&h.token, token)).cloned()
    }

    pub fn main_hub(&self) -> &Arc<DeviceHub> {
        &self.hubs[0]
    }

    pub fn is_bridge_connected(&self) -> bool {
        self.main_hub().bridge.is_connected()
    }

    pub fn device_briefs(&self) -> Vec<DeviceBrief> {
        self.hubs
            .iter()
            .enumerate()
            .map(|(i, h)| DeviceBrief {
                name: h.name.clone(),
                token: h.token.clone(),
                connector_id: h.connector_id.clone(),
                connected: h.bridge.is_connected(),
                main: i == 0,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_hub() -> Arc<DeviceHub> {
        let (hub, _rx) = DeviceHub::new(
            "test".into(),
            "tok".into(),
            "conn".into(),
            "C:/nonexistent/endpoint.json".into(),
            64,
            1.0,
        );
        hub
    }

    #[test]
    fn draft_roundtrip_and_clear() {
        let hub = test_hub();
        assert_eq!(hub.get_draft("s1")["text"].as_str().unwrap(), "");
        hub.set_draft("s1", "привет из поля", "dev-1");
        assert_eq!(hub.get_draft("s1")["text"].as_str().unwrap(), "привет из поля");
        assert_eq!(hub.get_draft("s1")["origin"].as_str().unwrap(), "dev-1");
        hub.clear_draft("s1");
        assert_eq!(hub.get_draft("s1")["text"].as_str().unwrap(), "");
        // clearing an absent draft must not panic or push anything
        hub.clear_draft("s1");
    }

    #[test]
    fn draft_text_is_capped() {
        let hub = test_hub();
        let long = "x".repeat(20_000);
        hub.set_draft("s2", &long, "dev-2");
        assert_eq!(hub.get_draft("s2")["text"].as_str().unwrap().len(), 10_000);
    }

    #[test]
    fn draft_map_stays_bounded() {
        let hub = test_hub();
        for i in 0..80 {
            hub.set_draft(&format!("s{i}"), "t", "d");
        }
        let n = hub.state.lock().unwrap().drafts.len();
        assert!(n <= 64, "draft map grew to {n}");
    }

    #[test]
    fn draft_key_resolves_external_id_to_bridge_id() {
        let hub = test_hub();
        {
            let mut st = hub.state.lock().unwrap();
            st.sessions.push(json!({
                "sessionId": "sess_dsh_aaa",
                "externalSessionId": "session-1111-2222"
            }));
        }
        // external (harness) id maps onto the bridge key
        assert_eq!(hub.resolve_draft_key("session-1111-2222"), "sess_dsh_aaa");
        // bridge ids pass through untouched
        assert_eq!(hub.resolve_draft_key("sess_dsh_bbb"), "sess_dsh_bbb");
        // unknown ids pass through so PWA behavior is unchanged
        assert_eq!(hub.resolve_draft_key("whatever"), "whatever");
    }

    #[test]
    fn draft_events_carry_external_id() {
        let hub = test_hub();
        {
            let mut st = hub.state.lock().unwrap();
            st.sessions.push(json!({
                "sessionId": "sess_dsh_ccc",
                "externalSessionId": "session-3333"
            }));
        }
        hub.set_draft("sess_dsh_ccc", "хай", "dsh-desktop");
        let st = hub.state.lock().unwrap();
        let ev = st
            .events
            .iter()
            .rev()
            .find(|e| e.0.get("type").and_then(|t| t.as_str()) == Some("draft"))
            .expect("draft event pushed");
        assert_eq!(ev.0["data"]["externalSessionId"].as_str().unwrap(), "session-3333");
        assert_eq!(ev.0["data"]["sessionId"].as_str().unwrap(), "sess_dsh_ccc");
    }

    #[test]
    fn plugin_ping_roundtrip() {
        let hub = test_hub();
        assert!(hub.plugin_ping_snapshot().is_none());
        hub.set_plugin_ping(json!({ "origin": "dsh-desktop", "hasSession": true, "sessionId": "session-x" }));
        let snap = hub.plugin_ping_snapshot().expect("ping stored");
        assert_eq!(snap["hasSession"].as_bool().unwrap(), true);
        assert_eq!(snap["sessionId"].as_str().unwrap(), "session-x");
    }

    #[test]
    fn token_eq_matches_identical() {
        assert!(token_eq("a3f0b19c", "a3f0b19c"));
    }

    #[test]
    fn token_eq_rejects_mismatch() {
        assert!(!token_eq("a3f0b19c", "a3f0b19d"));
    }

    #[test]
    fn token_eq_rejects_different_lengths() {
        assert!(!token_eq("a3f0b19c", "a3f0b19c0"));
        assert!(!token_eq("a3f0b19c0", "a3f0b19c"));
    }

    #[test]
    fn token_eq_rejects_empty() {
        // an empty token must never authenticate, even against another empty
        assert!(!token_eq("", ""));
        assert!(!token_eq("", "x"));
        assert!(!token_eq("x", ""));
    }

    #[test]
    fn token_eq_rejects_prefix_and_suffix() {
        assert!(!token_eq("abc", "abcd"));
        assert!(!token_eq("abcd", "abc"));
        assert!(!token_eq("xabcd", "yabcd"));
    }

    #[test]
    fn token_eq_same_length_no_early_exit() {
        // exhaustive same-length comparison: every single-byte flip is caught
        let a = "0123456789abcdef";
        for i in 0..a.len() {
            let mut b: Vec<u8> = a.as_bytes().to_vec();
            b[i] ^= 1;
            let b = String::from_utf8(b).unwrap();
            assert!(!token_eq(a, &b), "flip at {i} went undetected");
        }
    }
}
