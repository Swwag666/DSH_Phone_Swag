use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
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

async fn health(State(gw): State<Arc<Gateway>>) -> Response {
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
        "devices": gw.device_briefs().iter().map(|d| json!({
            "name": d.name,
            "connector": d.connector_id,
            "bridge": if d.connected { "connected" } else { "disconnected" },
        })).collect::<Vec<Value>>(),
    });
    if gw.cfg.tls_enabled {
        obj["tls_sha256"] = json!(crate::tls::cert_sha256());
    }
    json_status(StatusCode::OK, obj)
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
    match hub
        .bridge
        .request(&b.method, params, Duration::from_secs(120))
        .await
    {
        Ok(result) => json_status(StatusCode::OK, json!({ "ok": true, "result": result })),
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

pub async fn serve(gw: Arc<Gateway>, mut rx: tokio::sync::mpsc::Receiver<()>) {
    let port = gw.cfg.listen_port;
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/rpc", post(rpc))
        .route("/api/events", get(events))
        .route("/api/watch", post(watch))
        .route(
            "/api/upload",
            post(upload).layer(DefaultBodyLimit::max(80 * 1024 * 1024)),
        )
        .route("/", get(root))
        .fallback(static_fallback)
        .layer(middleware::from_fn_with_state(gw.clone(), count_reqs))
        .layer(middleware::from_fn_with_state(gw.clone(), ip_filter))
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
                eprintln!(
                    "dsh-phone: TLS on :{port} sha256={}",
                    crate::tls::cert_sha256().unwrap_or_default()
                );
                let handle = axum_server::Handle::new();
                let h2 = handle.clone();
                tokio::spawn(async move {
                    let _ = rx.recv().await;
                    h2.graceful_shutdown(Some(std::time::Duration::from_secs(3)));
                });
                let _ = axum_server::bind_rustls(addr, config)
                    .handle(handle)
                    .serve(app.into_make_service_with_connect_info::<SocketAddr>())
                    .await;
            }
            Err(e) => {
                eprintln!("dsh-phone: TLS setup failed ({e}); serving plain HTTP");
                serve_http(app, addr, rx).await;
            }
        }
    } else {
        serve_http(app, addr, rx).await;
    }
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
    fn whitelist_is_16_methods() {
        assert_eq!(WHITELIST.len(), 16);
        // the README/agent docs must match this count
    }

    #[test]
    fn whitelist_has_no_duplicates() {
        let mut sorted = WHITELIST.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), WHITELIST.len());
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