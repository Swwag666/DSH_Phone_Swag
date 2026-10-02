use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use crate::bridge::Bridge;

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
            }),
            outbox: Mutex::new(Vec::new()),
            gen: AtomicU64::new(0),
            gen_tx,
            refresh_pending: AtomicBool::new(false),
            event_buffer_max,
            poll_seconds,
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
                Some(w) => {
                    if w.last_state_key != key {
                        w.last_state_key = key;
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if state_changed {
            self.push_event("state", json!({ "sessionId": sid, "state": stv }));
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
                self.push_event("items", json!({ "sessionId": sid, "items": fresh }));
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
        match (ops, stream_id, batch_seq) {
            (Some(ops), Some(sid), Some(seq)) => {
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
                                        self.push_event(
                                            "items",
                                            json!({ "sessionId": sid2, "items": [it] }),
                                        );
                                    }
                                }
                                "session.turnEnded" => {
                                    if let Some(sid2) = p
                                        .get("sessionId")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        self.push_event(
                                            "turnEnded",
                                            json!({ "sessionId": sid2 }),
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
                                self.push_event("items", json!({ "sessionId": sid2, "items": its }));
                            }
                        }
                    }
                }
                if refresh {
                    self.debounced_refresh_sessions().await;
                }
            }
            _ => {}
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

        let (main, main_rx) = DeviceHub::new(
            "main".to_string(),
            cfg.token.clone(),
            cfg.connector_id.clone(),
            cfg.bridge_endpoint_path.clone(),
            cfg.event_buffer_max,
            cfg.poll_seconds,
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
