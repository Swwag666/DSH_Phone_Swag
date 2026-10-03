use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::{header, StatusCode, Uri},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::gateway::{now_ts, Event, Gateway};
use crate::pwa;

const WHITELIST: &[&str] = &[
    "ping",
    "workspace.list",
    "session.list",
    "session.getSnapshot",
    "session.getState",
    "session.getNotices",
    "session.startTurn",
    "session.createAndStart",
    "session.interrupt",
    "session.updateSelections",
    "session.respondInteraction",
    "session.pluginPing",
    "session.updateDraft",
    "session.getDraft",
    "catalog.listModels",
    "catalog.listPermissions",
    "catalog.listAgentPresets",
    "runtime.getCapabilities",
    "runtime.getConfig",
];

fn json_status(status: StatusCode, value: Value) -> Response {
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap()
}

fn static_response(ctype: &'static str, body: String) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap()
}

/// What the listener is actually serving right now. The config says what the
/// user *asked for*; this says what happened. When TLS setup fails we fall back
/// to plain HTTP, and without this the dashboard would keep claiming "on".
static TLS_RUNTIME: Mutex<Option<String>> = Mutex::new(None);

fn set_tls_runtime(v: Option<String>) {
    if let Ok(mut g) = TLS_RUNTIME.lock() {
        *g = v;
    }
}

/// Почему TLS не поднялся (None = поднялся или не включён). Дашборд показывает
/// это юзеру: без него «включил TLS - не работает» выглядит как мистика.
pub fn tls_runtime_error() -> Option<String> {
    TLS_RUNTIME.lock().ok().and_then(|g| g.clone())
}

/// Сброс перед рестартом листенера: ошибка прошлой попытки не должна висеть над
/// новой, иначе дашборд пугает юзера уже починенной проблемой.
pub fn clear_tls_runtime() {
    if let Ok(mut g) = TLS_RUNTIME.lock() {
        *g = None;
    }
}

async fn health(State(gw): State<Arc<Gateway>>) -> Response {
    let ping = gw.main_hub().plugin_ping_snapshot();
    let mut obj = json!({
        "ok": true,
        "runtime": "rust",
        "bridge": if gw.is_bridge_connected() { "connected" } else { "disconnected" },
        "uptime": gw.started_at.elapsed().as_secs(),
        "requests": gw.requests.load(Ordering::Relaxed),
        "version": env!("CARGO_PKG_VERSION"),
        "tailscale": gw.cfg.tailscale_ip,
        "tls": if gw.cfg.tls_enabled { "on" } else { "off" },
        "allowlist": gw.cfg.allowed_ips,
        "plugin": ping,
        "devices": gw.device_briefs().iter().map(|d| json!({
            "name": d.name,
            "connector": d.connector_id,
            "bridge": if d.connected { "connected" } else { "disconnected" },
        })).collect::<Vec<Value>>(),
    });
    if gw.cfg.tls_enabled {
        obj["tls_sha256"] = json!(crate::tls::cert_sha256());
        if let Ok(g) = TLS_RUNTIME.lock() {
            if let Some(err) = g.as_ref() {
                obj["tls_error"] = json!(err);
                obj["tls_serving"] = json!("http");
            } else {
                obj["tls_serving"] = json!("https");
            }
        }
    }
    json_status(StatusCode::OK, obj)
}

/// Serves attachment binaries straight from the DSH content-addressed store
/// (~/.dsh/attachments/v1/objects/<hex[0..2]>/<sha256-hex>) so the phone can
/// render photos that DSH Desktop received or produced.
async fn attachment(
    State(gw): State<Arc<Gateway>>,
    Query(q): Query<HashMap<String, String>>,
    headers: header::HeaderMap,
) -> Response {
    let token = headers
        .get("x-dsh-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| q.get("token").cloned())
        .unwrap_or_default();
    if gw.find_hub(&token).is_none() {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "ok": false, "error": "unauthorized" }));
    }
    let raw = q.get("attachmentId").cloned().unwrap_or_default();
    let hexid = raw.strip_prefix("sha256:").unwrap_or(&raw).to_string();
    if hexid.len() != 64 || !hexid.chars().all(|c| c.is_ascii_hexdigit()) {
        return json_status(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "bad attachmentId" }));
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let path = home
        .join(".dsh")
        .join("attachments")
        .join("v1")
        .join("objects")
        .join(&hexid[0..2])
        .join(&hexid);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => {
            return json_status(StatusCode::NOT_FOUND, json!({ "ok": false, "error": "attachment not found" }))
        }
    };
    // mediaType is caller-supplied, so only honour a known image type and
    // fall back to sniffing the bytes otherwise (also blocks header injection).
    let ctype = match q.get("mediaType").map(|m| m.as_str()) {
        Some("image/png") => "image/png",
        Some("image/jpeg") | Some("image/jpg") => "image/jpeg",
        Some("image/webp") => "image/webp",
        Some("image/gif") => "image/gif",
        Some("image/avif") => "image/avif",
        Some("image/svg+xml") => "image/svg+xml",
        _ => sniff_content_type(&bytes),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(bytes))
        .unwrap()
}

fn sniff_content_type(b: &[u8]) -> &'static str {
    if b.len() >= 8 && b[0] == 0x89 && b[1] == b'P' && b[2] == b'N' && b[3] == b'G' {
        return "image/png";
    }
    if b.len() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
        return "image/jpeg";
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return "image/webp";
    }
    if b.len() >= 6 && (&b[0..6] == b"GIF87a" || &b[0..6] == b"GIF89a") {
        return "image/gif";
    }
    "application/octet-stream"
}

#[derive(Deserialize)]
struct RpcBody {
    #[serde(default)]
    token: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    params: Value,
}

async fn rpc(State(gw): State<Arc<Gateway>>, Json(b): Json<RpcBody>) -> Response {
    let hub = match gw.find_hub(&b.token) {
        Some(h) => h,
        None => {
            return json_status(
                StatusCode::UNAUTHORIZED,
                json!({ "ok": false, "error": "unauthorized" }),
            )
        }
    };
    if !WHITELIST.contains(&b.method.as_str()) {
        return json_status(
            StatusCode::FORBIDDEN,
            json!({ "ok": false, "error": "method_not_allowed" }),
        );
    }
    let mut params = if b.params.is_object() {
        b.params.clone()
    } else {
        json!({})
    };
    // Drafts are gateway-local state, never forwarded to the bridge.
    if b.method == "session.pluginPing" {
        // Plugin heartbeat: proves whether the DSH-side client bound its
        // session id and composer element. Diagnostics only, never forwarded.
        let mut payload = json!({ "origin": "unknown", "ts": now_ts() });
        if let Some(o) = params.as_object() {
            let mut m = o.clone();
            m.insert("ts".to_string(), json!(now_ts()));
            payload = Value::Object(m);
        }
        hub.set_plugin_ping(payload);
        return json_status(StatusCode::OK, json!({ "ok": true, "result": { "saved": true } }));
    }
    if b.method == "session.updateDraft" || b.method == "session.getDraft" {
        let sid = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if sid.is_empty() {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": "no sessionId" }),
            );
        }
        // Accept both the bridge id (sess_dsh_*) and the harness external id
        // (session-uuid) so the DSH Desktop composer shares one draft slot
        // with the PWA.
        let key = hub.resolve_draft_key(&sid);
        if b.method == "session.getDraft" {
            return json_status(StatusCode::OK, json!({ "ok": true, "result": hub.get_draft(&key) }));
        }
        let text = params
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let origin = params
            .get("deviceId")
            .or_else(|| params.get("origin"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        hub.set_draft(&key, &text, &origin);
        return json_status(StatusCode::OK, json!({ "ok": true, "result": { "saved": true } }));
    }
    if b.method == "session.startTurn" {
        if let Some(obj) = params.as_object_mut() {
            if !obj.contains_key("clientMessageId") {
                obj.insert(
                    "clientMessageId".to_string(),
                    json!(crate::config::new_token()),
                );
            }
        }
        let sid = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !sid.is_empty() {
            let busy = match hub
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
                    matches!(st, "running" | "working" | "waiting" | "pending" | "blocked")
                        || st.starts_with("waiting")
                }
                Err(_) => false,
            };
            if busy {
                hub.enqueue_turn(sid, params);
                return json_status(
                    StatusCode::OK,
                    json!({ "ok": true, "result": { "accepted": true, "queued": true } }),
                );
            }
        }
    }
    let turn_sid = if b.method == "session.startTurn" {
        params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    match hub
        .bridge
        .request(&b.method, params, Duration::from_secs(120))
        .await
    {
        Ok(result) => {
            // the message consumed the draft - wipe it everywhere
            if !turn_sid.is_empty() {
                hub.clear_draft(&turn_sid);
            }
            json_status(StatusCode::OK, json!({ "ok": true, "result": result }))
        }
        Err(e) => json_status(StatusCode::BAD_GATEWAY, json!({ "ok": false, "error": e })),
    }
}

async fn events(
    State(gw): State<Arc<Gateway>>,
    Query(q): Query<HashMap<String, String>>,
    headers: header::HeaderMap,
) -> Response {
    // X-Dsh-Token header first; the query form stays as a fallback.
    let token = headers
        .get("x-dsh-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| q.get("token").cloned())
        .unwrap_or_default();
    let hub = match gw.find_hub(&token) {
        Some(h) => h,
        None => {
            return json_status(
                StatusCode::UNAUTHORIZED,
                json!({ "ok": false, "error": "unauthorized" }),
            )
        }
    };
    let since: f64 = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let had = q.contains_key("had");
    let mut rx = hub.gen_rx();
    let _ = rx.borrow();
    let mut evs = hub.collect_events(since).await;
    if evs.is_empty() {
        tokio::select! {
            _ = rx.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(20)) => {},
        }
        evs = hub.collect_events(since).await;
    }
    if !had {
        let snap = hub.sessions_snapshot().await;
        evs.insert(0, Event(json!({ "ts": now_ts(), "type": "sessions", "data": snap })));
    }
    let out: Vec<Value> = evs.into_iter().map(|e| e.0).collect();
    json_status(StatusCode::OK, json!({ "ts": now_ts(), "events": out }))
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct WatchBody {
    #[serde(default)]
    token: String,
    #[serde(default)]
    sessionId: String,
    #[serde(default)]
    unwatch: bool,
}

async fn watch(State(gw): State<Arc<Gateway>>, Json(b): Json<WatchBody>) -> Response {
    let hub = match gw.find_hub(&b.token) {
        Some(h) => h,
        None => {
            return json_status(StatusCode::UNAUTHORIZED, json!({ "ok": false }));
        }
    };
    if b.sessionId.is_empty() {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "no sessionId" }),
        );
    }
    if b.unwatch {
        hub.unwatch(&b.sessionId).await;
    } else {
        hub.watch(b.sessionId).await;
    }
    json_status(StatusCode::OK, json!({ "ok": true }))
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct UploadBody {
    #[serde(default)]
    token: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mediaType: String,
    #[serde(default)]
    data: String,
}

async fn upload(State(gw): State<Arc<Gateway>>, Json(b): Json<UploadBody>) -> Response {
    if gw.find_hub(&b.token).is_none() {
        return json_status(
            StatusCode::UNAUTHORIZED,
            json!({ "ok": false, "error": "unauthorized" }),
        );
    }
    let name = if b.name.is_empty() {
        "file".to_string()
    } else {
        b.name.chars().take(255).collect()
    };
    let media = if b.mediaType.is_empty() {
        "application/octet-stream".to_string()
    } else {
        b.mediaType
    };
    let raw = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b.data) {
        Ok(bytes) => bytes,
        Err(e) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": format!("bad base64: {e}") }),
            )
        }
    };
    let size = raw.len();
    if size == 0 || size as u64 > gw.cfg.max_attachment_bytes {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "file size out of bounds" }),
        );
    }
    let upload_id = crate::config::new_token();
    let file_id = format!("file_{}", crate::config::new_token());
    let sha = sha256_hex(&raw);
    if let Err(e) = write_staging(&gw.cfg.staging_path, &upload_id, &raw) {
        return json_status(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": e }));
    }
    json_status(
        StatusCode::OK,
        json!({
            "ok": true,
            "attachment": {
                "fileId": file_id,
                "uploadId": upload_id,
                "name": name,
                "mediaType": media,
                "size": size,
                "sha256": sha,
            }
        }),
    )
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(data);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_staging(stage: &str, upload_id: &str, raw: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(stage).map_err(|e| e.to_string())?;
    let path = std::path::Path::new(stage).join(upload_id);
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// Deletes staged uploads older than `retention_secs`. Returns removed count.
fn cleanup_staging(stage: &str, retention_secs: u64) -> usize {
    let dir = std::path::Path::new(stage);
    if !dir.is_dir() {
        return 0;
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(retention_secs))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let mut removed = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let stale = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .map(|t| t < cutoff)
                .unwrap_or(false);
            if stale && std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

async fn staging_cleanup_loop(gw: Arc<Gateway>) {
    let stage = gw.cfg.staging_path.clone();
    let retention = gw.cfg.staging_retention_secs;
    loop {
        let n = cleanup_staging(&stage, retention);
        if n > 0 {
            eprintln!("dsh-phone: staging purged {n} stale attachment(s)");
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

async fn root() -> Response {
    static_response("text/html; charset=utf-8", pwa::INDEX_HTML.to_string())
}

async fn static_fallback(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/').to_string();
    if path.starts_with("api/") {
        return json_status(StatusCode::NOT_FOUND, json!({ "ok": false, "error": "not_found" }));
    }
    match pwa::lookup(&path) {
        Some((body, ctype)) => static_response(ctype, body.to_string()),
        None => json_status(StatusCode::NOT_FOUND, json!({ "ok": false, "error": "not_found" })),
    }
}

// ---------------- push subscriptions ----------------

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// Public info the PWA needs before subscribing (VAPID application server key).
async fn push_info(State(gw): State<Arc<Gateway>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let token = q.get("token").cloned().unwrap_or_default();
    if gw.find_hub(&token).is_none() {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "ok": false, "error": "unauthorized" }));
    }
    let vapid = crate::config::AppConfig::load_or_init()
        .vapid_keys
        .and_then(|v| hex_decode(&v.public_hex))
        .map(|raw| {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
        });
    json_status(
        StatusCode::OK,
        json!({
            "ok": true,
            "vapid_public": vapid.unwrap_or_default(),
        }),
    )
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct PushSubBody {
    #[serde(default)]
    token: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    p256dh: String,
    #[serde(default)]
    auth: String,
    #[serde(default)]
    device: String,
}

async fn push_subscribe(State(gw): State<Arc<Gateway>>, Json(b): Json<PushSubBody>) -> Response {
    let hub = match gw.find_hub(&b.token) {
        Some(h) => h,
        None => return json_status(StatusCode::UNAUTHORIZED, json!({ "ok": false, "error": "unauthorized" })),
    };
    if b.endpoint.is_empty() || b.p256dh.is_empty() || b.auth.is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "endpoint/p256dh/auth required" }));
    }
    let sub = crate::push::PushSubscription {
        device: if b.device.is_empty() { hub.name.clone() } else { b.device.chars().take(40).collect() },
        endpoint: b.endpoint,
        p256dh: b.p256dh,
        auth: b.auth,
        created_at: now_ts(),
    };
    crate::push::PushRouter.add_subscription(sub);
    json_status(StatusCode::OK, json!({ "ok": true }))
}

async fn push_unsubscribe(State(gw): State<Arc<Gateway>>, Json(b): Json<PushSubBody>) -> Response {
    if gw.find_hub(&b.token).is_none() {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "ok": false, "error": "unauthorized" }));
    }
    if b.endpoint.is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "endpoint required" }));
    }
    crate::push::PushRouter.remove_subscription(&b.endpoint);
    json_status(StatusCode::OK, json!({ "ok": true }))
}

async fn count_reqs(State(gw): State<Arc<Gateway>>, req: Request, next: Next) -> Response {
    gw.requests.fetch_add(1, Ordering::Relaxed);
    next.run(req).await
}

async fn ip_filter(State(gw): State<Arc<Gateway>>, req: Request, next: Next) -> Response {
    if let Some(ci) = req.extensions().get::<ConnectInfo<SocketAddr>>() {
        if !gw.cfg.allow_ip(ci.0.ip()) {
            return json_status(
                StatusCode::FORBIDDEN,
                json!({ "ok": false, "error": "ip_not_allowed" }),
            );
        }
    }
    next.run(req).await
}

/// Loopback browser origins (the DSH Desktop web GUI lives on a random
/// 127.0.0.1 port) are mirrored back; everything else gets no CORS headers.
fn cors_origin_mirror(origin: Option<&str>) -> Option<String> {
    let o = origin?;
    let after = o.strip_prefix("http://")?;
    let host = after.split(':').next().unwrap_or("");
    if host == "127.0.0.1" || host == "localhost" {
        Some(o.to_string())
    } else {
        None
    }
}

async fn cors_layer(req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let is_api = req.uri().path().starts_with("/api/");
    let allowed = cors_origin_mirror(origin.as_deref());
    if req.method() == axum::http::Method::OPTIONS && is_api {
        return match allowed {
            Some(o) => Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header("Access-Control-Allow-Origin", o)
                .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "content-type, x-dsh-token")
                .header("Access-Control-Max-Age", "86400")
                .body(Body::empty())
                .unwrap(),
            None => json_status(
                StatusCode::FORBIDDEN,
                json!({ "ok": false, "error": "origin_not_allowed" }),
            ),
        };
    }
    let mut res = next.run(req).await;
    if is_api {
        if let Some(o) = allowed {
            if let Ok(v) = header::HeaderValue::from_str(&o) {
                res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            }
        }
    }
    res
}

/// Loopback-only, tokenless bootstrap for the DSH Desktop composer patch:
/// hands the node token and port to a page that already runs on this machine.
async fn draft_config(
    State(gw): State<Arc<Gateway>>,
    ConnectInfo(ci): ConnectInfo<SocketAddr>,
    headers: header::HeaderMap,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !(ci.ip().is_loopback() && cors_origin_mirror(Some(origin)).is_some()) {
        return json_status(
            StatusCode::FORBIDDEN,
            json!({ "ok": false, "error": "forbidden" }),
        );
    }
    json_status(
        StatusCode::OK,
        json!({
            "ok": true,
            "token": gw.cfg.token,
            "port": gw.cfg.listen_port,
            "version": env!("CARGO_PKG_VERSION"),
        }),
    )
}

pub async fn serve(gw: Arc<Gateway>, mut rx: tokio::sync::mpsc::Receiver<()>) {
    let port = gw.cfg.listen_port;
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/attachment", get(attachment))
        .route("/api/rpc", post(rpc))
        .route("/api/events", get(events))
        .route("/api/draft-config", get(draft_config))
        .route("/api/watch", post(watch))
        .route("/api/push/info", get(push_info))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route(
            "/api/upload",
            post(upload).layer(DefaultBodyLimit::max(80 * 1024 * 1024)),
        )
        .route("/", get(root))
        .fallback(static_fallback)
        .layer(middleware::from_fn_with_state(gw.clone(), count_reqs))
        .layer(middleware::from_fn_with_state(gw.clone(), ip_filter))
        .layer(middleware::from_fn(cors_layer))
        .with_state(gw.clone());

    // Honour listen_host from the config (it was previously ignored and the
    // node always bound 0.0.0.0).
    let host: std::net::IpAddr = gw
        .cfg
        .listen_host
        .parse()
        .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    if host.is_unspecified() && gw.cfg.allowed_ips.is_empty() {
        eprintln!(
            "dsh-phone: WARNING: listening on ALL interfaces with an empty IP allowlist -"
        );
        eprintln!(
            "dsh-phone: the node is reachable from every network this PC joins."
        );
        eprintln!("dsh-phone: set allowed_ips in the config to restrict (e.g. 100.64.0.0/10).");
    }
    let addr = SocketAddr::from((host, port));

    // Staged attachments no longer live forever: hourly purge of files
    // older than staging_retention_secs (7 days by default).
    tokio::spawn(staging_cleanup_loop(gw.clone()));

    if gw.cfg.tls_enabled {
        match crate::tls::rustls_config(&gw.cfg).await {
            Ok(config) => {
                let sha = crate::tls::cert_sha256().unwrap_or_default();
                eprintln!("dsh-phone: TLS on :{port} sha256={sha}");

                // The DSH Desktop composer plugin talks to the node over plain
                // http://127.0.0.1:<port>. Once TLS owns that port the plugin
                // would lose its bootstrap silently, so it gets a second,
                // loopback-only HTTP listener on port+1 (API routes only - the
                // PWA keeps going through https).
                let loop_port = port.saturating_add(1);
                spawn_loopback_http(gw.clone(), loop_port);

                let handle = axum_server::Handle::new();
                let h2 = handle.clone();
                tokio::spawn(async move {
                    let _ = rx.recv().await;
                    h2.graceful_shutdown(Some(std::time::Duration::from_secs(3)));
                });
                let served = axum_server::bind_rustls(addr, config)
                    .handle(handle)
                    .serve(app.into_make_service_with_connect_info::<SocketAddr>())
                    .await;
                match served {
                    Ok(()) => set_tls_runtime(None),
                    Err(e) => {
                        let msg = format!("TLS listener failed: {e}");
                        eprintln!("dsh-phone: {msg}");
                        set_tls_runtime(Some(msg));
                    }
                }
            }
            Err(e) => {
                let msg = e.to_string();
                eprintln!("dsh-phone: TLS setup failed ({e}); serving plain HTTP");
                set_tls_runtime(Some(msg));
                serve_http(app, addr, rx).await;
            }
        }
    } else {
        set_tls_runtime(None);
        serve_http(app, addr, rx).await;
    }
}

/// API-only HTTP listener bound to 127.0.0.1, used by the in-profile composer
/// plugin while TLS owns the main port. Peers are checked twice (bind address +
/// per-request ConnectInfo), and no static files are served here.
///
/// Why plain HTTP is acceptable here: TLS exists to protect the phone over the
/// tailnet, while this listener never leaves the machine. Everything except
/// /api/draft-config still requires the token, and draft-config was already
/// loopback + allowed-origin gated on the main port. A local process able to
/// call loopback endpoints could do the same before TLS was turned on, so the
/// local threat model is unchanged - the tailnet one is now encrypted.
fn spawn_loopback_http(gw: Arc<Gateway>, port: u16) {
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/draft-config", get(draft_config))
        .route("/api/rpc", post(rpc))
        .route("/api/events", get(events))
        .route("/api/watch", post(watch))
        .layer(middleware::from_fn_with_state(gw.clone(), count_reqs))
        .layer(middleware::from_fn(loopback_only))
        .layer(middleware::from_fn(cors_layer))
        .with_state(gw);

    tokio::spawn(async move {
        let addr = SocketAddr::from((std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                eprintln!("dsh-phone: loopback http (plugin) on 127.0.0.1:{port}");
                let _ = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await;
            }
            Err(e) => eprintln!("dsh-phone: loopback http bind {addr}: {e}"),
        }
    });
}

/// Hard gate: anything that is not loopback is refused before the handler runs.
async fn loopback_only(
    ConnectInfo(ci): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if !ci.ip().is_loopback() {
        return json_status(
            StatusCode::FORBIDDEN,
            json!({ "ok": false, "error": "loopback_only" }),
        );
    }
    next.run(req).await
}

async fn serve_http(
    app: Router,
    addr: SocketAddr,
    mut rx: tokio::sync::mpsc::Receiver<()>,
) {
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("dsh-phone: bind {addr}: {e}");
            return;
        }
    };
    let _ = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = rx.recv().await;
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_is_19_methods() {
        assert_eq!(WHITELIST.len(), 19);
        // the README/agent docs must match this count
    }

    #[test]
    fn pwa_serves_every_script_index_html_references() {
        // every <script src> and <link href> in index.html must resolve in the
        // embedded asset table - a miss means a 404 on a fresh page
        let html = crate::pwa::INDEX_HTML;
        let mut refs: Vec<String> = Vec::new();
        let mut rest = html;
        while let Some(pos) = rest.find("src=\"/") {
            rest = &rest[pos + 6..];
            let end = rest.find('"').unwrap_or(0);
            if end > 0 {
                refs.push(rest[..end].to_string());
            }
        }
        let mut rest = html;
        while let Some(pos) = rest.find("href=\"/") {
            rest = &rest[pos + 7..];
            let end = rest.find('"').unwrap_or(0);
            if end > 0 {
                refs.push(rest[..end].to_string());
            }
        }
        assert!(!refs.is_empty(), "no asset refs found in index.html");
        for r in refs {
            let path = r.split('?').next().unwrap_or("");
            assert!(
                crate::pwa::lookup(path).is_some(),
                "index.html references {} but pwa.rs does not embed it",
                path
            );
        }
    }

    #[test]
    fn pwa_draftsync_is_served() {
        let (body, ctype) = crate::pwa::lookup("draftsync.js").expect("draftsync.js must be embedded");
        assert!(body.contains("draftSyncDecision"));
        assert!(ctype.starts_with("text/javascript"));
    }

    #[test]
    fn whitelist_has_no_duplicates() {
        let mut sorted = WHITELIST.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), WHITELIST.len());
    }

    #[test]
    fn cors_origin_mirror_accepts_loopback_only() {
        assert_eq!(
            cors_origin_mirror(Some("http://127.0.0.1:43120")).as_deref(),
            Some("http://127.0.0.1:43120")
        );
        assert_eq!(
            cors_origin_mirror(Some("http://localhost:5173")).as_deref(),
            Some("http://localhost:5173")
        );
        // remote origins, https, and missing origins get nothing
        assert!(cors_origin_mirror(Some("http://100.100.134.55:8460")).is_none());
        assert!(cors_origin_mirror(Some("https://evil.example")).is_none());
        assert!(cors_origin_mirror(Some("http://127.0.0.1.evil.example")).is_none());
        assert!(cors_origin_mirror(None).is_none());
    }

    #[test]
    fn staging_cleanup_respects_retention() {
        let dir = std::env::temp_dir().join(format!("dsh-stage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let old = dir.join("old.bin");
        let fresh = dir.join("fresh.bin");
        std::fs::write(&old, b"old").unwrap();
        std::fs::write(&fresh, b"fresh").unwrap();

        let past = std::time::SystemTime::now() - Duration::from_secs(8 * 86400);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(past))
            .unwrap();

        let removed = cleanup_staging(&dir.to_string_lossy(), 7 * 86400);
        assert_eq!(removed, 1);
        assert!(!old.exists());
        assert!(fresh.exists());

        // retention=0: everything is stale (mtime pinned 1s into the past so
        // the check does not race on timestamp granularity)
        std::fs::write(&fresh, b"fresh2").unwrap();
        let past2 = std::time::SystemTime::now() - Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(past2))
            .unwrap();
        assert_eq!(cleanup_staging(&dir.to_string_lossy(), 0), 1);
        assert!(!fresh.exists());

        // missing directory is a no-op
        assert_eq!(cleanup_staging("Z:/definitely/not/here", 60), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staging_cleanup_keeps_directories_untouched() {
        let dir = std::env::temp_dir().join(format!("dsh-stage-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let old = dir.join("nested").join("keep.bin");
        std::fs::write(&old, b"x").unwrap();
        let past = std::time::SystemTime::now() - Duration::from_secs(99 * 86400);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(past))
            .unwrap();

        // single-level scan, matching write_staging layout: a stale file
        // inside a subdirectory is not removed, the subdirectory itself
        // is never deleted
        assert_eq!(cleanup_staging(&dir.to_string_lossy(), 7 * 86400), 0);
        assert!(dir.join("nested").is_dir());
        assert!(old.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}