use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};

use crate::bridge::Bridge;
use crate::push::PushRouter;

/// A single feed event as delivered to the phone: `{"ts", "type", "data"}`.
#[derive(Clone)]
pub struct Event(pub Value);

/// Отпечаток списка сессий для детекта изменений (M7). RA задумывал дешёвый хэш
/// по ключевым полям вместо полной JSON-сериализации, но не дописал определение
/// (прерван). Сейчас реализован через serde_json - это корректно (ловит любое
/// изменение списка) и восстанавливает прежнее поведение; оптимизация на хэш по
/// (sessionId, orderingTime, status) остаётся follow-up'ом.
fn sessions_fingerprint(sessions: &[Value]) -> String {
    serde_json::to_string(sessions).unwrap_or_default()
}

/// Buffered form of a feed event. The payload sits behind an `Arc` so handing
/// the buffer to a client costs a refcount bump under the lock instead of a
/// deep `Value` clone (M6); `bytes` feeds the byte budget (H6).
struct BufferedEvent {
    payload: Arc<Value>,
    bytes: usize,
}

/// Byte budget for one hub's event buffer. The count-based `event_buffer_max`
/// alone was not enough: a "sessions" snapshot (whole session list) or an
/// "items" batch (up to 150 timeline elements) can be megabytes on its own (H6).
const EVENT_BYTES_BUDGET: usize = 8 * 1024 * 1024;

/// Upper bound of the outgoing-message queue for busy sessions (H4).
const OUTBOX_CAP: usize = 64;
/// Queued turns older than this are dropped by the sweep in `outbox_loop` (H4).
const OUTBOX_STALE_SECS: f64 = 1800.0;

/// Hard cap on simultaneously watched sessions, and how long a watched session
/// survives without any client touching it. A closed tab never sends `unwatch`,
/// so without this the map grew forever and each stale sid cost a 15 s + 20 s
/// bridge round-trip on every poll tick (H3).
const WATCH_CAP: usize = 16;
const WATCH_TTL_SECS: f64 = 300.0;
/// Watched sessions refreshed concurrently per poll tick: sequentially, 16
/// sessions with 15 s + 20 s timeouts could stretch a 1 s interval to minutes.
const WATCH_POLL_CONCURRENCY: usize = 4;

/// One phone-facing device: its own bridge connector, its own event feed,
/// its own watched sessions. Main device + every extra device.
/// Команда узла нативному плагину: исходящий RPC поверх HTTP. Плагин забирает
/// очередь long-poll'ом /api/bridge/poll и возвращает результат через ingest.
#[derive(Clone)]
pub struct PluginCommand {
    pub id: String,
    pub method: String,
    pub params: Value,
    pub queued_at: f64,
}

/// Очередь команд плагину ограничена: при переполнении отбрасываем самую старую
/// команду и будим её ожидателя, вместо того чтобы копить неактуальные вызовы.
const PLUGIN_QUEUE_CAP: usize = 64;
/// Сколько команд отдаём за один poll: плагин выполняет их параллельно, но
/// большой батч отложил бы срочный session.startTurn.
const PLUGIN_POLL_BATCH: usize = 8;
/// Heartbeat плагина приходит раз в 15 с, поэтому 45 с тишины - это обрыв
/// канала. Без проверки свежести закрытая вкладка DSH навсегда оставила бы узел
/// «подключённым» и телефон ждал бы ответов от мёртвого плагина.
const PLUGIN_STALE_SECS: f64 = 45.0;

pub struct DeviceHub {
    pub name: String,
    pub token: String,
    pub connector_id: String,
    pub bridge: Arc<Bridge>,
    /// Нативный плагин dsh-phone-bridge пушит статус/события по HTTP, минуя
    /// TCP-мост Agents Anywhere. Пока плагин шлёт heartbeat, узел считается
    /// подключённым даже без endpoint.json/AA - независимость от внешнего моста.
    plugin_connected: AtomicBool,
    /// Поколение очереди команд плагина: будит long-poll в /api/bridge/poll.
    plugin_gen: AtomicU64,
    plugin_gen_tx: watch::Sender<u64>,
    state: Mutex<HubState>,
    outbox: Mutex<VecDeque<OutgoingTurn>>,
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
    /// Item ids already reported to the client, plus their insertion order so
    /// eviction drops the genuinely oldest ones - sorting ids lexicographically
    /// keeps a random half when ids are UUIDs (M8).
    known_ids: HashSet<String>,
    // M8 (eviction known_ids по порядку вставки вместо лексикографики) не дописан:
    // поле known_order удалено как мёртвое, эвикция пока прежняя (cap 2000->1000).
    last_state_key: String,
    /// Last time a client showed interest in this session (H3).
    last_seen: f64,
}

struct HubState {
    events: VecDeque<BufferedEvent>,
    /// Sum of `bytes` over `events`, maintained on push/evict (H6).
    events_bytes: usize,
    sessions: Vec<Value>,
    /// Cheap change-detection fingerprint of `sessions`, not the serialised
    /// list itself (M7).
    sessions_hash: String,
    watched: HashMap<String, Watched>,
    /// Сессии, замеченные в session.inventory.complete, но ещё не пришедшие в
    /// session.list. Храним (payload, время_вставки): запись живёт максимум час
    /// и удаляется, как только сессия реально появляется в списке - иначе список
    /// обрастал призраками навсегда (раньше удалений не было вовсе).
    candidates: HashMap<String, (Value, f64)>,
    /// Input-field drafts shared between phone/web clients:
    /// sessionId -> {text, origin, ts}
    drafts: HashMap<String, DraftEntry>,
    /// Last plugin heartbeat from the DSH Desktop side client.
    plugin_ping: Option<Value>,
    /// Очередь команд для нативного плагина (забирается через /api/bridge/poll).
    plugin_queue: VecDeque<PluginCommand>,
    /// Команды, отданные плагину и ждущие ответа: id -> канал результата.
    plugin_pending: HashMap<String, oneshot::Sender<Value>>,
    /// Рукопожатие плагина: версия, источник, заявленные возможности.
    plugin_info: Option<Value>,
    /// Время любого последнего push от плагина (heartbeat, события, результаты).
    plugin_last_push: f64,
    /// Сколько команд отброшено при переполнении очереди (диагностика).
    plugin_dropped: u64,
    /// Последняя измеренная задержка ответа плагина, мс.
    plugin_rtt_ms: Option<u64>,
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

/// Rough in-memory/serialised size of a JSON value, without allocating: used to
/// keep the event buffer inside its byte budget (H6). Exactness does not
/// matter, only that a fat snapshot costs visibly more than a status blip.
fn approx_bytes(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool(_) => 5,
        // Serialising a number just to measure it would allocate per node.
        Value::Number(_) => 16,
        Value::String(s) => s.len() + 3,
        Value::Array(items) => {
            items.iter().map(approx_bytes).sum::<usize>() + 2 * items.len() + 2
        }
        Value::Object(map) => map
            .iter()
            .map(|(k, val)| k.len() + 4 + approx_bytes(val))
            .sum::<usize>()
            + 2,
    }
}

impl DeviceHub {
    fn new(
        name: String,
        token: String,
        connector_id: String,
        endpoint_paths: Vec<String>,
        event_buffer_max: usize,
        poll_seconds: f64,
        push: PushRouter,
    ) -> (Arc<Self>, mpsc::Receiver<Value>) {
        // Bounded on purpose: the pump below is slow and single-threaded (it
        // awaits a 15 s ack and an 800 ms debounce), so an unbounded channel
        // turned a burst of notifications into unbounded memory growth. The
        // bridge drops and counts on overflow instead (H5).
        let (notify_tx, notify_rx) =
            mpsc::channel::<Value>(crate::bridge::NOTIFY_CHANNEL_CAP);
        let (gen_tx, _) = watch::channel(0u64);
        let bridge = Bridge::new(endpoint_paths, connector_id.clone(), notify_tx);
        let hub = Arc::new(DeviceHub {
            name,
            token,
            connector_id,
            bridge,
            plugin_connected: AtomicBool::new(false),
            plugin_gen: AtomicU64::new(0),
            plugin_gen_tx: watch::channel(0u64).0,
            state: Mutex::new(HubState {
                events: VecDeque::new(),
                events_bytes: 0,
                sessions: Vec::new(),
                sessions_hash: String::new(),
                watched: HashMap::new(),
                candidates: HashMap::new(),
                drafts: HashMap::new(),
                plugin_ping: None,
                plugin_queue: VecDeque::new(),
                plugin_pending: HashMap::new(),
                plugin_info: None,
                plugin_last_push: 0.0,
                plugin_dropped: 0,
                plugin_rtt_ms: None,
            }),
            outbox: Mutex::new(VecDeque::new()),
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
        mut notify_rx: mpsc::Receiver<Value>,
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
        self.touch_watch(&session_id);
        let n = {
            let mut q = self.outbox.lock().unwrap();
            if q.len() >= OUTBOX_CAP {
                drop(q);
                // Bounded queue (H4): without a cap a session that never
                // freed up grew it forever while nothing was delivered.
                self.push_event(
                    "queued_drop",
                    json!({ "reason": "full", "sessionId": session_id, "attempts": 0 }),
                );
                return;
            }
            q.push_back(OutgoingTurn {
                session_id,
                params,
                queued_at: now_ts(),
                attempts: 0,
            });
            q.len()
        };
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
            // Stale sweep over the WHOLE queue, before the connectivity check.
            // Previously a disconnected bridge `continue`d without touching the
            // queue and a busy head `break`ed so nothing behind it was ever
            // examined - expired turns survived indefinitely (H4).
            let stale: Vec<(String, u32)> = {
                let now = now_ts();
                let mut q = self.outbox.lock().unwrap();
                let expired: Vec<(String, u32)> = q
                    .iter()
                    .filter(|it| now - it.queued_at > OUTBOX_STALE_SECS)
                    .map(|it| (it.session_id.clone(), it.attempts))
                    .collect();
                if !expired.is_empty() {
                    q.retain(|it| now - it.queued_at <= OUTBOX_STALE_SECS);
                }
                expired
            };
            for (sid, attempts) in stale {
                self.push_event(
                    "queued_drop",
                    json!({ "reason": "stale", "sessionId": sid, "attempts": attempts }),
                );
            }
            if !self.runtime_available() {
                continue;
            }
            loop {
                let item = self.outbox.lock().unwrap().pop_front();
                let mut item = match item {
                    Some(i) => i,
                    None => break,
                };
                if now_ts() - item.queued_at > OUTBOX_STALE_SECS {
                    let (sid, attempts) = (item.session_id.clone(), item.attempts);
                    self.push_event(
                        "queued_drop",
                        json!({ "reason": "stale", "sessionId": sid, "attempts": attempts }),
                    );
                    continue;
                }
                if self.session_busy(&item.session_id).await {
                    self.outbox.lock().unwrap().push_front(item);
                    break;
                }
                match self
                    .runtime_call("session.startTurn", item.params.clone(), Duration::from_secs(120))
                    .await
                {
                    Ok(_) => {
                        self.clear_draft(&item.session_id);
                        self.push_event("queued_flush", json!({ "sessionId": item.session_id }));
                    }
                    Err(_) => {
                        item.attempts += 1;
                        if item.attempts < 5 {
                            self.outbox.lock().unwrap().push_front(item);
                            break;
                        }
                        let (sid, attempts) = (item.session_id.clone(), item.attempts);
                        self.push_event(
                            "queued_drop",
                            json!({ "reason": "bridge", "sessionId": sid, "attempts": attempts }),
                        );
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
            let payload = json!({
                "ts": now_ts(),
                "type": type_,
                "data": data,
            });
            let bytes = approx_bytes(&payload);
            let mut st = self.state.lock().unwrap();
            st.events_bytes = st.events_bytes.saturating_add(bytes);
            st.events.push_back(BufferedEvent {
                payload: Arc::new(payload),
                bytes,
            });
            let max = self.event_buffer_max.max(1);
            while st.events.len() > max {
                if let Some(old) = st.events.pop_front() {
                    st.events_bytes = st.events_bytes.saturating_sub(old.bytes);
                } else {
                    break;
                }
            }
            // Byte budget on top of the count cap (H6): heavy snapshots would
            // otherwise sit in the buffer far beyond any sane memory bound.
            // The last event always survives so a client never sees an empty
            // feed just because one frame was huge.
            while st.events_bytes > EVENT_BYTES_BUDGET && st.events.len() > 1 {
                if let Some(old) = st.events.pop_front() {
                    st.events_bytes = st.events_bytes.saturating_sub(old.bytes);
                } else {
                    break;
                }
            }
        }
        let g = self.gen.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.gen_tx.send(g);
    }

    /// Приём данных от нативного плагина dsh-phone-bridge (HTTP push вместо
    /// TCP-моста AA). Плагин шлёт рукопожатие, статус, сессии, события и
    /// результаты команд - всё кладём в тот же event-feed, что и
    /// bridge-уведомления, поэтому телефон видит их одинаково.
    pub fn ingest_bridge(&self, kind: &str, data: Value) {
        // Любой входящий push доказывает живость канала: без этой отметки
        // plugin_alive() полагался бы только на heartbeat.
        self.plugin_touch();
        match kind {
            "hello" => self.plugin_hello(data),
            "status" => {
                let connected = data.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
                self.plugin_connected.store(connected, Ordering::Relaxed);
                self.push_event(
                    "bridge",
                    json!({ "status": if connected { "connected" } else { "disconnected" }, "source": "plugin" }),
                );
            }
            "result" => {
                // id забираем владеющим String: иначе заимствование data не даст
                // передать его же в plugin_resolve.
                let id = data
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    return;
                }
                self.plugin_resolve(&id, data);
            }
            "sessions" => self.push_event("sessions", data),
            "event" => {
                let t = data
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("event")
                    .to_string();
                self.push_event(&t, data);
            }
            _ => {}
        }
    }

    // ---------------- нативный плагин: исходящий канал ----------------

    /// Рукопожатие плагина: фиксируем версию/источник и считаем канал живым.
    pub fn plugin_hello(&self, info: Value) {
        {
            let mut st = self.state.lock().unwrap();
            st.plugin_info = Some(info);
            st.plugin_last_push = now_ts();
        }
        self.plugin_connected.store(true, Ordering::Relaxed);
    }

    /// Отметка живости канала (обновляется на любой входящий push).
    pub fn plugin_touch(&self) {
        self.state.lock().unwrap().plugin_last_push = now_ts();
    }

    /// Жив ли канал плагина: подключён И heartbeat свежее PLUGIN_STALE_SECS.
    pub fn plugin_alive(&self) -> bool {
        let connected = self.plugin_connected.load(Ordering::Relaxed);
        let last = self.state.lock().unwrap().plugin_last_push;
        Self::plugin_alive_at(connected, last)
    }

    /// Расчёт живости из уже снятых значений. Отдельная функция потому, что
    /// `state` - это std-Mutex, он не реентерабелен: вызов plugin_alive() из
    /// plugin_metrics() (который держит этот лок) вешал и /api/health, и тесты.
    fn plugin_alive_at(connected: bool, last_push: f64) -> bool {
        connected && last_push > 0.0 && now_ts() - last_push <= PLUGIN_STALE_SECS
    }

    /// Подписка на поколение очереди команд (для long-poll плагина).
    pub fn plugin_gen_rx(&self) -> watch::Receiver<u64> {
        self.plugin_gen_tx.subscribe()
    }

    /// Забрать до `limit` команд из очереди. Команды остаются в plugin_pending:
    /// если плагин не ответит, их снимет таймаут вызывающей стороны.
    pub fn plugin_take_commands(&self, limit: usize) -> Vec<Value> {
        let mut st = self.state.lock().unwrap();
        let n = limit.min(PLUGIN_POLL_BATCH).min(st.plugin_queue.len());
        (0..n)
            .filter_map(|_| st.plugin_queue.pop_front())
            .map(|c| {
                json!({
                    "id": c.id,
                    "method": c.method,
                    "params": c.params,
                    "queuedAt": c.queued_at,
                })
            })
            .collect()
    }

    /// Постановка команды в очередь плагина. Вынесена из plugin_call, чтобы
    /// лимит очереди и отбраковка старья проверялись тестами синхронно.
    fn plugin_enqueue(&self, method: &str, params: Value) -> (String, oneshot::Receiver<Value>) {
        let (tx, rx) = oneshot::channel::<Value>();
        let seq = self.plugin_gen.fetch_add(1, Ordering::Relaxed) + 1;
        let id = format!("pc-{seq}");
        {
            let mut st = self.state.lock().unwrap();
            if st.plugin_queue.len() >= PLUGIN_QUEUE_CAP {
                if let Some(old) = st.plugin_queue.pop_front() {
                    st.plugin_dropped = st.plugin_dropped.saturating_add(1);
                    if let Some(old_tx) = st.plugin_pending.remove(&old.id) {
                        let _ = old_tx.send(json!({
                            "ok": false,
                            "error": "dropped: plugin command queue overflow",
                        }));
                    }
                }
            }
            st.plugin_pending.insert(id.clone(), tx);
            st.plugin_queue.push_back(PluginCommand {
                id: id.clone(),
                method: method.to_string(),
                params,
                queued_at: now_ts(),
            });
        }
        let _ = self.plugin_gen_tx.send(seq);
        (id, rx)
    }

    /// Исходящий вызов в плагин: команда кладётся в очередь, плагин забирает её
    /// long-poll'ом и отвечает через ingest(type="result"). Именно это даёт
    /// телефону session.list / getState / startTurn без моста Agents Anywhere.
    pub async fn plugin_call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.plugin_alive() {
            return Err("plugin bridge offline".to_string());
        }
        let (id, rx) = self.plugin_enqueue(method, params);
        let started = now_ts();
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => {
                let rtt = ((now_ts() - started) * 1000.0).round() as u64;
                self.state.lock().unwrap().plugin_rtt_ms = Some(rtt);
                if v.get("ok").and_then(|x| x.as_bool()) == Some(false) {
                    let msg = v
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("plugin error")
                        .to_string();
                    return Err(msg);
                }
                Ok(v.get("result").cloned().unwrap_or(v))
            }
            Ok(Err(_)) => Err("plugin channel closed".to_string()),
            Err(_) => {
                self.state.lock().unwrap().plugin_pending.remove(&id);
                Err(format!(
                    "plugin timeout after {}s waiting for {method}",
                    timeout.as_secs()
                ))
            }
        }
    }

    /// Ответ плагина на команду. false - nobody ждал этот id (таймаут/дубль).
    pub fn plugin_resolve(&self, id: &str, payload: Value) -> bool {
        let tx = self.state.lock().unwrap().plugin_pending.remove(id);
        match tx {
            Some(tx) => tx.send(payload).is_ok(),
            None => false,
        }
    }

    /// Диапазон/метрики канала плагина для /api/health и дашборда.
    pub fn plugin_metrics(&self) -> Value {
        let connected = self.plugin_connected.load(Ordering::Relaxed);
        let st = self.state.lock().unwrap();
        let alive = Self::plugin_alive_at(connected, st.plugin_last_push);
        let info = st.plugin_info.clone().unwrap_or_else(|| json!({}));
        let age = if st.plugin_last_push > 0.0 {
            json!((now_ts() - st.plugin_last_push).round())
        } else {
            Value::Null
        };
        json!({
            "connected": connected,
            "alive": alive,
            "staleAfterSec": PLUGIN_STALE_SECS,
            "version": info.get("version").cloned().unwrap_or(Value::Null),
            "source": info.get("source").cloned().unwrap_or(Value::Null),
            "capabilities": info.get("capabilities").cloned().unwrap_or(Value::Null),
            "lastPushAgeSec": age,
            "queue": st.plugin_queue.len(),
            "inFlight": st.plugin_pending.len(),
            "dropped": st.plugin_dropped,
            "rttMs": st.plugin_rtt_ms,
        })
    }

    /// Есть ли хоть один канал к рантайму: TCP-мост или нативный плагин.
    pub fn runtime_available(&self) -> bool {
        self.bridge.is_connected() || self.plugin_alive()
    }

    /// Единая точка вызова рантайма. Сначала проверенный TCP-мост; если его нет,
    /// но живой наш плагин - идём через него. runtime.sync.* плагину не нужны:
    /// он сам пушит события, поэтому подписка и ack обслуживаются на месте.
    pub async fn runtime_call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.bridge.is_connected() {
            return self.bridge.request(method, params, timeout).await;
        }
        match method {
            "runtime.sync.subscribe" => Ok(json!({
                "streamId": "dsh-phone-plugin",
                "projectionVersion": 2,
            })),
            "runtime.sync.ack" | "runtime.sync.unsubscribe" => Ok(json!({ "ok": true })),
            _ => self.plugin_call(method, params, timeout).await,
        }
    }

    pub async fn collect_events(&self, since: f64) -> Vec<Event> {
        // Under the lock we only bump refcounts; the deep `Value` clone happens
        // after it is released, so a large buffer cannot block the hub's other
        // loops while a client is being served (M6).
        let picked: Vec<Arc<Value>> = {
            let st = self.state.lock().unwrap();
            st.events
                .iter()
                .filter(|e| {
                    e.payload
                        .get("ts")
                        .and_then(|t| t.as_f64())
                        .unwrap_or(0.0)
                        > since
                })
                .map(|e| Arc::clone(&e.payload))
                .collect()
        };
        // A live client polling the feed proves the watch set is still in use.
        self.touch_watched_if_under_cap();
        picked.into_iter().map(|p| Event((*p).clone())).collect()
    }

    pub async fn sessions_snapshot(&self) -> Value {
        let st = self.state.lock().unwrap();
        json!({ "sessions": st.sessions })
    }

    /// Mark every watched session as recently seen, but only while the watch set
    /// is within its cap: below the cap there is nothing to reclaim, so an
    /// open-but-idle session must not be expired just because its client only
    /// long-polls `/api/events` (which carries no sessionId). At or above the
    /// cap only per-session touches count, so LRU eviction targets the sessions
    /// that were genuinely abandoned (H3).
    fn touch_watched_if_under_cap(&self) {
        let now = now_ts();
        let mut st = self.state.lock().unwrap();
        if st.watched.len() <= WATCH_CAP {
            for w in st.watched.values_mut() {
                w.last_seen = now;
            }
        }
    }

    /// A client touched this specific session (watch, draft read/write, queued
    /// message): it is definitely still wanted.
    fn touch_watch(&self, sid: &str) {
        let now = now_ts();
        let mut st = self.state.lock().unwrap();
        if let Some(w) = st.watched.get_mut(sid) {
            w.last_seen = now;
        }
    }

    /// Drop expired watched sessions, enforce the cap, and return the surviving
    /// sids most-recently-seen first (so a long tick skips the abandoned tail,
    /// not the session the user is looking at) (H3).
    fn prune_watched(&self) -> Vec<String> {
        let now = now_ts();
        let mut st = self.state.lock().unwrap();
        st.watched.retain(|_, w| now - w.last_seen <= WATCH_TTL_SECS);
        if st.watched.len() > WATCH_CAP {
            let mut by_age: Vec<(f64, String)> = st
                .watched
                .iter()
                .map(|(k, w)| (w.last_seen, k.clone()))
                .collect();
            by_age.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let excess = by_age.len() - WATCH_CAP;
            for (_, k) in by_age.into_iter().take(excess) {
                st.watched.remove(&k);
            }
        }
        let mut entries: Vec<(f64, String)> = st
            .watched
            .iter()
            .map(|(k, w)| (w.last_seen, k.clone()))
            .collect();
        entries.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        entries.into_iter().map(|(_, k)| k).collect()
    }

    pub async fn watch(&self, sid: String) {
        let now = now_ts();
        let mut st = self.state.lock().unwrap();
        st.watched
            .entry(sid)
            .and_modify(|w| w.last_seen = now)
            .or_insert_with(|| Watched {
                known_ids: HashSet::new(),
                last_state_key: String::new(),
                last_seen: now,
            });
        // Enforce the cap immediately as well: a client that opens many tabs in
        // a burst should not be able to park 100 sids on the poller (H3).
        if st.watched.len() > WATCH_CAP {
            let mut by_age: Vec<(f64, String)> = st
                .watched
                .iter()
                .map(|(k, w)| (w.last_seen, k.clone()))
                .collect();
            by_age.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let excess = by_age.len() - WATCH_CAP;
            for (_, k) in by_age.into_iter().take(excess) {
                st.watched.remove(&k);
            }
        }
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
        let key = {
            let st = self.state.lock().unwrap();
            if st.drafts.contains_key(sid) {
                sid.to_string()
            } else {
                let mut found: Option<String> = None;
                for s in &st.sessions {
                    if s.get("externalSessionId").and_then(|v| v.as_str()) == Some(sid) {
                        if let Some(k) = s.get("sessionId").and_then(|v| v.as_str()) {
                            found = Some(k.to_string());
                            break;
                        }
                    }
                }
                found.unwrap_or_else(|| sid.to_string())
            }
        };
        // Draft traffic is the most reliable per-session "client is alive"
        // signal we get, so it refreshes the watch TTL (H3).
        self.touch_watch(sid);
        self.touch_watch(&key);
        key
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
        self.touch_watch(sid);
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
        self.touch_watch(sid);
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
        self.touch_watch(sid);
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

    async fn poll_loop(self: Arc<Self>) {
        let poll = Duration::from_secs_f64(self.poll_seconds.max(0.5));
        let mut reported_dropped: u64 = 0;
        loop {
            tokio::time::sleep(poll).await;
            // Канал может быть любым: TCP-мост AA или наш нативный плагин.
            if !self.runtime_available() {
                continue;
            }
            // The notify channel is bounded now, so an overloaded pump loses
            // messages; report the growth instead of losing it silently (H5).
            let dropped = self.bridge.notify_dropped.load(Ordering::Relaxed);
            if dropped != reported_dropped {
                reported_dropped = dropped;
                self.push_event(
                    "bridge",
                    json!({ "status": "notify_overflow", "droppedNotifications": dropped }),
                );
            }
            self.refresh_sessions().await;
            // TTL + cap before the sweep, so dead sids stop costing a 15 s + 20 s
            // round-trip each tick (H3).
            let sids = self.prune_watched();
            // Bounded concurrency: sequentially, 16 sessions with 15 s + 20 s
            // timeouts could stretch a 1 s interval into minutes.
            let mut set: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
            for sid in sids {
                if !self.runtime_available() {
                    break;
                }
                while set.len() >= WATCH_POLL_CONCURRENCY {
                    if set.join_next().await.is_none() {
                        break;
                    }
                }
                let hub = Arc::clone(&self);
                set.spawn(async move {
                    hub.refresh_watched(&sid).await;
                });
            }
            while set.join_next().await.is_some() {}
        }
    }

    async fn refresh_sessions(&self) {
        let res = match self
            .runtime_call("session.list", json!({ "limit": 1000 }), Duration::from_secs(20))
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
            let mut st = self.state.lock().unwrap();
            // Вычищаем протухшие (старше часа) и те, что уже реально пришли в
            // session.list. Без этого candidates только росли, дописываясь в
            // sessions/sessions_hash и событие "sessions" на каждом poll.
            let cutoff = now_ts() - 3600.0;
            st.candidates
                .retain(|sid, (_, ts)| *ts > cutoff && !have.contains(sid));
            // Deterministic order: HashMap iteration order would change the
            // fingerprint (and so fire a spurious "sessions" event) every tick.
            let mut ids: Vec<&String> = st.candidates.keys().collect();
            ids.sort();
            for sid in ids {
                let c = match st.candidates.get(sid) {
                    Some((c, _)) => c,
                    None => continue,
                };
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
        let hash = sessions_fingerprint(&sessions);
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
        if !self.runtime_available() {
            return;
        }
        let stv = match self
            .runtime_call("session.getState", json!({ "sessionId": sid }), Duration::from_secs(15))
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
                                            st.candidates.insert(id, (c, now_ts()));
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
            cfg.bridge_endpoint_paths(),
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
                cfg.bridge_endpoint_paths(),
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
        let h = self.main_hub();
        h.bridge.is_connected() || h.plugin_alive()
    }

    pub fn device_briefs(&self) -> Vec<DeviceBrief> {
        self.hubs
            .iter()
            .enumerate()
            .map(|(i, h)| DeviceBrief {
                name: h.name.clone(),
                token: h.token.clone(),
                connector_id: h.connector_id.clone(),
                connected: h.bridge.is_connected() || h.plugin_alive(),
                main: i == 0,
            })
            .collect()
    }

    /// Последний heartbeat web-половины плагина (`session.pluginPing`) по всем
    /// hub'ам устройств: дашборд показывает, привязана ли сессия DSH и найден ли
    /// композитор. None = плагин не отстукивался ни разу.
    pub fn plugin_ping_snapshot(&self) -> Option<serde_json::Value> {
        self.hubs.iter().find_map(|h| h.plugin_ping_snapshot())
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
            vec!["C:/nonexistent/endpoint.json".to_string()],
            64,
            1.0,
            PushRouter::new(),
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
            .find(|e| e.payload.get("type").and_then(|t| t.as_str()) == Some("draft"))
            .expect("draft event pushed");
        assert_eq!(ev.payload["data"]["externalSessionId"].as_str().unwrap(), "session-3333");
        assert_eq!(ev.payload["data"]["sessionId"].as_str().unwrap(), "sess_dsh_ccc");
    }

    #[test]
    fn plugin_ping_roundtrip() {
        let hub = test_hub();
        assert!(hub.plugin_ping_snapshot().is_none());
        hub.set_plugin_ping(json!({ "origin": "dsh-desktop", "hasSession": true, "sessionId": "session-x" }));
        let snap = hub.plugin_ping_snapshot().expect("ping stored");
        assert!(snap["hasSession"].as_bool().unwrap());
        assert_eq!(snap["sessionId"].as_str().unwrap(), "session-x");
    }

    #[test]
    fn plugin_channel_starts_dead_and_comes_alive_on_hello() {
        let hub = test_hub();
        assert!(!hub.plugin_alive(), "без рукопожатия канал обязан быть мёртвым");
        assert!(!hub.runtime_available());
        hub.plugin_hello(json!({ "version": 2, "source": "dsh-phone-bridge" }));
        assert!(hub.plugin_alive());
        assert!(hub.runtime_available(), "плагин заменяет TCP-мост");
        let m = hub.plugin_metrics();
        assert!(m["alive"].as_bool().unwrap());
        assert_eq!(m["source"].as_str().unwrap(), "dsh-phone-bridge");
        assert_eq!(m["version"].as_i64().unwrap(), 2);
        assert_eq!(m["queue"].as_u64().unwrap(), 0);
        assert_eq!(m["staleAfterSec"].as_f64().unwrap(), PLUGIN_STALE_SECS);
    }

    #[test]
    fn plugin_commands_are_taken_in_batches_and_resolved_once() {
        let hub = test_hub();
        hub.plugin_hello(json!({}));
        let mut rxs = Vec::new();
        for i in 0..10 {
            let (_id, rx) =
                hub.plugin_enqueue("session.getState", json!({ "sessionId": format!("s{i}") }));
            rxs.push(rx);
        }
        assert_eq!(hub.plugin_metrics()["queue"].as_u64().unwrap(), 10);
        let batch = hub.plugin_take_commands(8);
        assert_eq!(batch.len(), 8, "батч ограничен PLUGIN_POLL_BATCH");
        assert_eq!(batch[0]["method"].as_str().unwrap(), "session.getState");
        assert_eq!(
            batch[0]["params"]["sessionId"].as_str().unwrap(),
            "s0",
            "очередь FIFO"
        );
        assert_eq!(hub.plugin_take_commands(8).len(), 2);
        assert!(hub.plugin_take_commands(8).is_empty());
        let id0 = batch[0]["id"].as_str().unwrap().to_string();
        assert!(hub.plugin_resolve(
            &id0,
            json!({ "ok": true, "result": { "status": "idle" } })
        ));
        assert!(
            !hub.plugin_resolve(&id0, json!({ "ok": true })),
            "дубль ответа не должен приниматься"
        );
        assert_eq!(
            rxs.remove(0).try_recv().unwrap()["result"]["status"]
                .as_str()
                .unwrap(),
            "idle"
        );
    }

    #[test]
    fn plugin_queue_overflow_drops_the_oldest_command() {
        let hub = test_hub();
        hub.plugin_hello(json!({}));
        let mut first_rx = None;
        for i in 0..(PLUGIN_QUEUE_CAP + 3) {
            let (_id, rx) = hub.plugin_enqueue("session.list", json!({ "i": i }));
            if i == 0 {
                first_rx = Some(rx);
            }
        }
        let m = hub.plugin_metrics();
        assert_eq!(m["queue"].as_u64().unwrap(), PLUGIN_QUEUE_CAP as u64);
        assert_eq!(m["dropped"].as_u64().unwrap(), 3);
        // старьё отклоняется явной ошибкой, а не теряется молча
        let v = first_rx
            .unwrap()
            .try_recv()
            .expect("ожидатель отброшенной команды обязан быть разбужен");
        assert!(!v["ok"].as_bool().unwrap());
        assert!(v["error"].as_str().unwrap().contains("overflow"));
    }

    #[tokio::test]
    async fn plugin_call_offline_without_hello() {
        let hub = test_hub();
        let err = hub
            .plugin_call("session.list", json!({}), Duration::from_millis(50))
            .await
            .expect_err("без рукопожатия вызов не проходит");
        assert_eq!(err, "plugin bridge offline");
    }

    #[tokio::test]
    async fn plugin_call_times_out_and_clears_pending() {
        let hub = test_hub();
        hub.plugin_hello(json!({}));
        let err = hub
            .plugin_call("session.list", json!({}), Duration::from_millis(80))
            .await
            .expect_err("без ответа плагина вызов обязан упасть по таймауту");
        assert!(err.contains("timeout"), "получили: {err}");
        assert_eq!(
            hub.plugin_metrics()["inFlight"].as_u64().unwrap(),
            0,
            "после таймаута pending обязан быть пуст"
        );
    }

    #[tokio::test]
    async fn runtime_call_serves_sync_locally_and_routes_the_rest_to_plugin() {
        let hub = test_hub();
        hub.plugin_hello(json!({}));
        // подписка и ack обслуживаются на месте: плагин сам пушит события
        let sub = hub
            .runtime_call("runtime.sync.subscribe", json!({}), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(sub["streamId"].as_str().unwrap(), "dsh-phone-plugin");
        assert_eq!(sub["projectionVersion"].as_i64().unwrap(), 2);
        let ack = hub
            .runtime_call("runtime.sync.ack", json!({ "batchSeq": 1 }), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(ack["ok"].as_bool().unwrap());

        // реальный метод уходит в очередь плагина
        let call = tokio::spawn({
            let hub = hub.clone();
            async move {
                hub.runtime_call("session.list", json!({ "limit": 1000 }), Duration::from_secs(10))
                    .await
            }
        });
        let mut cmds = Vec::new();
        for _ in 0..400 {
            cmds = hub.plugin_take_commands(8);
            if !cmds.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(cmds.len(), 1, "команда должна была встать в очередь");
        assert_eq!(cmds[0]["method"].as_str().unwrap(), "session.list");
        let id = cmds[0]["id"].as_str().unwrap().to_string();
        assert!(hub.plugin_resolve(
            &id,
            json!({ "ok": true, "result": { "sessions": [{ "sessionId": "sess_dsh_x" }] } })
        ));
        let res = call.await.unwrap().unwrap();
        assert_eq!(res["sessions"][0]["sessionId"].as_str().unwrap(), "sess_dsh_x");
    }

    #[tokio::test]
    async fn ingest_hello_and_result_drive_the_plugin_channel() {
        let hub = test_hub();
        hub.ingest_bridge("hello", json!({ "version": 3, "source": "dsh-phone-bridge" }));
        assert!(hub.plugin_alive(), "hello через ingest поднимает канал");
        let call = tokio::spawn({
            let hub = hub.clone();
            async move {
                hub.plugin_call("session.getState", json!({ "sessionId": "s1" }), Duration::from_secs(10))
                    .await
            }
        });
        let mut id = String::new();
        for _ in 0..400 {
            if let Some(c) = hub.plugin_take_commands(8).first().cloned() {
                id = c["id"].as_str().unwrap().to_string();
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!id.is_empty(), "команда не появилась в очереди");
        hub.ingest_bridge(
            "result",
            json!({ "id": id, "ok": true, "result": { "status": "working" } }),
        );
        let res = call.await.unwrap().unwrap();
        assert_eq!(res["status"].as_str().unwrap(), "working");
        let m = hub.plugin_metrics();
        assert!(m["lastPushAgeSec"].as_f64().unwrap() < 10.0);
        assert!(m["rttMs"].as_u64().is_some(), "замер RTT сохранён");
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
