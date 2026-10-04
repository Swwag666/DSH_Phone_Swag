use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};

/// Hard ceiling for a single newline-delimited frame. Enforced WHILE reading
/// (see `read_frame`), not after: an unbounded `read_line` let a peer that
/// never sends '\n' grow our String until the process died (M1).
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// A healthy bridge pushes sync-feed notifications and RPC results constantly.
/// Silence for this long means a half-open socket (peer gone without FIN), so
/// the reader treats it as a disconnect instead of hanging the hub forever (M2).
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Capacity of the notify channel towards the gateway pump. Bounded on purpose:
/// the consumer is single-threaded and awaits acks (15 s) plus an 800 ms
/// debounce, so an unbounded queue turned a slow consumer into memory growth
/// (H5). Overflow is counted in `Bridge::notify_dropped` and reported as an
/// event by the gateway.
pub const NOTIFY_CHANNEL_CAP: usize = 512;

pub struct BridgeEndpoint {
    pub host: String,
    pub port: u16,
    pub token: String,
}

/// Reads the DSH bridge endpoint descriptor written by the Agents Anywhere plugin.
pub fn read_endpoint(path: &str) -> Result<BridgeEndpoint, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("endpoint read: {e}"))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("endpoint json: {e}"))?;
    let host = v
        .get("host")
        .and_then(|x| x.as_str())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = v.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
    let token = v.get("token").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if host.is_empty() || port == 0 || token.is_empty() {
        return Err("endpoint missing host/port/token".to_string());
    }
    Ok(BridgeEndpoint { host, port, token })
}

/// One authenticated connection to the DSH bridge (newline-delimited JSON-RPC over TCP).
pub struct Bridge {
    pub endpoint_path: String,
    pub connector_id: String,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    generation: AtomicU64,
    write: Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>,
    connected: AtomicBool,
    /// Bounded notify channel (see NOTIFY_CHANNEL_CAP): the reader never blocks
    /// on a slow gateway pump, it drops and counts instead (H5).
    notify_tx: mpsc::Sender<Value>,
    /// Notifications dropped because the pump was behind. Surfaced as an event
    /// by the gateway so the loss is visible instead of silent.
    pub notify_dropped: AtomicU64,
    /// Handle of the current reader task, kept so a reconnect can abort a
    /// stale reader that is still parked on a dead socket (M2).
    reader: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Bridge {
    pub fn new(
        endpoint_path: String,
        connector_id: String,
        notify_tx: mpsc::Sender<Value>,
    ) -> Arc<Self> {
        Arc::new(Bridge {
            endpoint_path,
            connector_id,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            generation: AtomicU64::new(0),
            write: Mutex::new(None),
            connected: AtomicBool::new(false),
            notify_tx,
            notify_dropped: AtomicU64::new(0),
            reader: Mutex::new(None),
        })
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    async fn write_frame(&self, v: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(v).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut guard = self.write.lock().await;
        let w = guard
            .as_mut()
            .ok_or_else(|| "bridge_disconnected".to_string())?;
        w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Fire a JSON-RPC request and await its result.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_connected() {
            return Err("bridge_disconnected".to_string());
        }
        let id = format!("gw-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_frame(&frame).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("bridge_timeout".to_string())
            }
            Ok(Err(_)) => Err("bridge_closed".to_string()),
            Ok(Ok(r)) => r,
        }
    }

    async fn request_initialize(&self, token: &str) -> Result<Value, String> {
        let id = format!("init-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "authToken": token,
                "protocolVersion": "1.0",
                "runtime": "dsh",
                "connectorId": self.connector_id.clone(),
                "sessionNamespace": self.connector_id.clone(),
                "clientInfo": { "name": "dsh-phone-desktop", "version": "0.1.0" }
            }
        });
        if let Err(e) = self.write_frame(&frame).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(Duration::from_secs(15), rx).await {
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("init timeout".to_string())
            }
            Ok(Err(_)) => Err("bridge closed".to_string()),
            Ok(Ok(r)) => r,
        }
    }

    async fn clear_local_state(&self) {
        self.connected.store(false, Ordering::Relaxed);
        // Abort the previous reader BEFORE a new one is spawned: an untracked
        // reader parked on a half-open socket would otherwise outlive the
        // connection and keep draining `pending` for the new one (M2).
        if let Some(h) = self.reader.lock().await.take() {
            h.abort();
        }
        let mut guard = self.write.lock().await;
        if let Some(mut w) = guard.take() {
            let _ = w.shutdown().await;
        }
        drop(guard);
        // Fail every in-flight request immediately: nobody will answer them on
        // the dead socket, and callers should not sit out their full timeout.
        let drained: Vec<oneshot::Sender<Result<Value, String>>> = {
            let mut p = self.pending.lock().await;
            p.drain().map(|(_, tx)| tx).collect()
        };
        for tx in drained {
            let _ = tx.send(Err("bridge_closed".to_string()));
        }
    }

    pub async fn connect(self: &Arc<Self>) -> Result<(), String> {
        let mut last = "no endpoint".to_string();
        for attempt in 0..2 {
            match self.try_connect_once().await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = e;
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
        Err(last)
    }

    async fn try_connect_once(self: &Arc<Self>) -> Result<(), String> {
        let gen = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        self.clear_local_state().await;
        let ep = read_endpoint(&self.endpoint_path)?;
        let addr = format!("{}:{}", ep.host, ep.port);
        let stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| format!("tcp {addr}: {e}"))?;
        let _ = stream.set_nodelay(true);
        // NB: OS-level SO_KEEPALIVE would need the `socket2` crate, which is not
        // a dependency of this project; READ_IDLE_TIMEOUT below is our half-open
        // detector instead (M2).
        let (read_half, write_half) = stream.into_split();
        *self.write.lock().await = Some(write_half);
        let reader = self.spawn_reader(read_half, gen);
        *self.reader.lock().await = Some(reader);
        let init = self.request_initialize(&ep.token).await?;
        let ident = init.get("identity").cloned().unwrap_or(Value::Null);
        if ident.get("runtime").and_then(|x| x.as_str()) != Some("dsh") {
            self.clear_local_state().await;
            return Err("bad identity".to_string());
        }
        self.connected.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn spawn_reader(
        self: &Arc<Self>,
        read_half: tokio::net::tcp::OwnedReadHalf,
        gen: u64,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(read_half);
            loop {
                // Bounded AND time-limited read: `read_line` grew its String
                // without a ceiling (OOM on a peer that never sends '\n') and
                // never timed out (half-open socket hung the hub forever).
                let line = match tokio::time::timeout(READ_IDLE_TIMEOUT, read_frame(&mut reader))
                    .await
                {
                    Ok(Ok(Some(line))) => line,
                    // EOF, IO error, oversized frame, or idle timeout: all are
                    // treated as "this connection is over".
                    _ => break,
                };
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if msg.get("jsonrpc").and_then(|x| x.as_str()) != Some("2.0") {
                    continue;
                }
                if let Some(idv) = msg.get("id") {
                    if msg.get("result").is_some() || msg.get("error").is_some() {
                        let id = idv.as_str().unwrap_or("").to_string();
                        if let Some(tx) = this.pending.lock().await.remove(&id) {
                            let res = if msg.get("error").is_some() {
                                Err(serde_json::to_string(&msg["error"]).unwrap_or_default())
                            } else {
                                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = tx.send(res);
                        }
                    }
                    continue;
                }
                // JSON-RPC notification (no id, has method): hand to the sync-feed handler.
                if msg.get("method").is_some() {
                    match this.notify_tx.try_send(msg) {
                        Ok(()) => {}
                        // The gateway pump is behind (it awaits acks and the
                        // debounce): drop, count, let the gateway report it.
                        // Blocking here would stall RPC result delivery too.
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            this.notify_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                        // Receiver gone (hub torn down): stop reading.
                        Err(mpsc::error::TrySendError::Closed(_)) => break,
                    }
                }
            }
            // Teardown, but only if we are still the current connection. The
            // generation check and the drain of `pending` happen under the same
            // lock hold: checking the atomic once and then awaiting let a stale
            // reader steal (and fail) the NEW connection's in-flight requests
            // in the window between the two awaits (M3).
            {
                let mut guard = this.pending.lock().await;
                if this.generation.load(Ordering::Relaxed) == gen {
                    this.connected.store(false, Ordering::Relaxed);
                    *this.write.lock().await = None;
                    let drained: Vec<oneshot::Sender<Result<Value, String>>> =
                        guard.drain().map(|(_, tx)| tx).collect();
                    drop(guard);
                    for tx in drained {
                        let _ = tx.send(Err("bridge_closed".to_string()));
                    }
                }
            }
        })
    }
}

/// Read exactly one newline-terminated frame, refusing to buffer more than
/// `MAX_FRAME_BYTES`. Returns `None` on EOF, on an oversized frame (the rest of
/// that frame is not salvageable, so the caller drops the connection rather
/// than trying to resynchronise mid-stream); an IO error is propagated.
async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    r: &mut R,
) -> std::io::Result<Option<String>> {
    let mut out = String::new();
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            // EOF. A trailing partial line (no '\n') is not a usable frame;
            // returning it would make the caller spin on the same bytes.
            return Ok(None);
        }
        if out.len() + available.len() > MAX_FRAME_BYTES {
            return Ok(None);
        }
        let newline_at = available.iter().position(|&b| b == b'\n');
        let consumed = match newline_at {
            Some(i) => i + 1,
            None => available.len(),
        };
        // Frames are UTF-8 JSON; lossy decoding only affects invalid UTF-8,
        // which serde rejects anyway.
        out.push_str(&String::from_utf8_lossy(&available[..consumed]));
        r.consume(consumed);
        if newline_at.is_some() {
            return Ok(Some(out));
        }
    }
}