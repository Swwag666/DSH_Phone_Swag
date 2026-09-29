use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

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
    notify_tx: mpsc::UnboundedSender<Value>,
}

impl Bridge {
    pub fn new(
        endpoint_path: String,
        connector_id: String,
        notify_tx: mpsc::UnboundedSender<Value>,
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
        let mut guard = self.write.lock().await;
        if let Some(mut w) = guard.take() {
            let _ = w.shutdown().await;
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
        let (read_half, write_half) = stream.into_split();
        *self.write.lock().await = Some(write_half);
        self.spawn_reader(read_half, gen);
        let init = self.request_initialize(&ep.token).await?;
        let ident = init.get("identity").cloned().unwrap_or(Value::Null);
        if ident.get("runtime").and_then(|x| x.as_str()) != Some("dsh") {
            self.clear_local_state().await;
            return Err("bad identity".to_string());
        }
        self.connected.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn spawn_reader(self: &Arc<Self>, read_half: tokio::net::tcp::OwnedReadHalf, gen: u64) {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            loop {
                line.clear();
                let n = match reader.read_line(&mut line).await {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }
                if line.len() > MAX_FRAME_BYTES {
                    line.clear();
                    continue;
                }
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
                    let _ = this.notify_tx.send(msg);
                }
            }
            if this.generation.load(Ordering::Relaxed) == gen {
                this.connected.store(false, Ordering::Relaxed);
                *this.write.lock().await = None;
                let mut guard = this.pending.lock().await;
                let drained: Vec<oneshot::Sender<Result<Value, String>>> =
                    guard.drain().map(|(_, tx)| tx).collect();
                for tx in drained {
                    let _ = tx.send(Err("bridge_closed".to_string()));
                }
            }
        });
    }
}