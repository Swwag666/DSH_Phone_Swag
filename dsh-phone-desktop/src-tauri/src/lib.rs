mod bridge;
mod config;
mod gateway;
mod push;
mod pwa;
mod qr;
mod server;
mod tailscale;
mod tls;

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, State,
};

pub struct RunningServer {
    pub handle: tauri::async_runtime::JoinHandle<()>,
    pub bg: Vec<tauri::async_runtime::JoinHandle<()>>,
    pub shutdown: tokio::sync::mpsc::Sender<()>,
    pub started_at: std::time::Instant,
    pub port: u16,
    pub requests: Arc<AtomicU64>,
    pub gw: Arc<gateway::Gateway>,
}

#[derive(Default)]
pub struct ServerState {
    pub running: Mutex<Option<RunningServer>>,
}

#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub uptime_seconds: u64,
    pub requests: u64,
    pub tls_sha256: Option<String>,
    /// "https" когда TLS реально поднят, "http" когда запросили TLS, но узел
    /// отдался обычным HTTP (сертификат не собрался, порт занят).
    pub tls_serving: Option<String>,
    /// Причина, по которой TLS не поднялся. None = всё хорошо.
    pub tls_error: Option<String>,
    pub devices: Vec<gateway::DeviceBrief>,
}

fn status_of(state: &ServerState) -> ServerStatus {
    // ВНИМАНИЕ: этот вызов происходит на каждый поллинг дашборда (раз в 2с).
    // Здесь нельзя ни читать конфиг, ни спавнить tailscale.exe - load_or_init()
    // тянет tailscale_ip(), а консольное приложение на Windows каждый раз
    // рисует и гасит окно терминала. Раньше так и было: терминал мелькал
    // бесконечно. Берём всё из уже загруженного состояния узла.
    let tls_sha256 = crate::tls::cert_sha256();
    let tls_error = crate::server::tls_runtime_error();
    match state.running.lock().unwrap().as_ref() {
        Some(s) => {
            // https только если TLS запрошен И листенер реально поднялся
            let tls_serving = if s.gw.cfg.tls_enabled && tls_error.is_none() {
                "https"
            } else {
                "http"
            };
            ServerStatus {
                running: true,
                port: s.port,
                uptime_seconds: s.started_at.elapsed().as_secs(),
                requests: s.requests.load(Ordering::Relaxed),
                tls_sha256,
                tls_serving: Some(tls_serving.to_string()),
                tls_error,
                devices: s.gw.device_briefs(),
            }
        }
        None => ServerStatus {
            running: false,
            port: 8460,
            uptime_seconds: 0,
            requests: 0,
            tls_sha256,
            // узел не поднят - утверждать схему нечего
            tls_serving: None,
            tls_error,
            devices: Vec::new(),
        },
    }
}

fn is_running(state: &ServerState) -> bool {
    state.running.lock().unwrap().is_some()
}

fn stop_inner(state: &ServerState) {
    let taken = {
        let mut g = state.running.lock().unwrap();
        g.take()
    };
    if let Some(s) = taken {
        let _ = s.shutdown.try_send(());
        // Give the axum task a short window for graceful drain (in-flight
        // requests finish, port releases), then hard-abort whatever is left.
        // 300ms < restart_if_running's 400ms rebind pause, so the port is
        // always free by the time do_start binds again.
        let handle = s.handle;
        let bg = s.bg;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            handle.abort();
            for h in bg {
                h.abort();
            }
        });
    }
}

/// rustls 0.23 needs exactly one process-level CryptoProvider. Our dependency
/// graph enables both `ring` (via reqwest/rcgen) and `aws-lc-rs` (via
/// axum-server), and auto-detection then *panics* inside the tokio worker -
/// taking the listener down silently, so the node stayed up while serving
/// nothing. Installing `ring` up front makes the choice explicit.
fn install_crypto_provider() {
    use std::sync::Once;
    static DONE: Once = Once::new();
    DONE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn do_start(state: &ServerState) -> Result<ServerStatus, String> {
    if is_running(state) {
        return Ok(status_of(state));
    }

    install_crypto_provider();
    // прошлая ошибка TLS не должна переживать рестарт - листенер ещё не пробовал
    crate::server::clear_tls_runtime();
    let cfg = Arc::new(config::AppConfig::load_or_init());
    let port = cfg.listen_port;
    let started_at = std::time::Instant::now();
    let requests = Arc::new(AtomicU64::new(0));
    let (gw, bg) = gateway::Gateway::new(cfg, requests.clone());
    let (tx, rx) = tokio::sync::mpsc::channel::<()>(1);
    let handle = tauri::async_runtime::spawn(server::serve(gw.clone(), rx));

    {
        let mut g = state.running.lock().unwrap();
        *g = Some(RunningServer {
            handle,
            bg,
            shutdown: tx,
            started_at,
            port,
            requests,
            gw,
        });
    }
    Ok(status_of(state))
}

/// Restart the node in place so a config change (e.g. new device) takes effect.
fn restart_if_running(state: &ServerState) {
    if is_running(state) {
        stop_inner(state);
        // даём порту выдохнуться перед повторным биндом
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = do_start(state);
    }
}

#[tauri::command]
fn app_config() -> config::AppConfig {
    config::AppConfig::load_or_init()
}

#[tauri::command]
fn regenerate_token() -> config::AppConfig {
    let mut c = config::AppConfig::load_or_init();
    c.token = config::new_token();
    c.created_at_unix = config::now();
    let _ = c.save();
    c
}

#[tauri::command]
fn server_status(state: State<ServerState>) -> ServerStatus {
    status_of(&state)
}

#[tauri::command]
fn start_server(state: State<ServerState>) -> Result<ServerStatus, String> {
    do_start(&state)
}

#[tauri::command]
fn stop_server(state: State<ServerState>) -> ServerStatus {
    stop_inner(&state);
    status_of(&state)
}

#[tauri::command]
fn add_device(name: String, state: State<ServerState>) -> Result<config::AppConfig, String> {
    let mut c = config::AppConfig::load_or_init();
    let name: String = name.trim().chars().filter(|ch| !ch.is_control()).take(40).collect();
    if name.is_empty() {
        return Err("имя пустое".to_string());
    }
    if c.devices.len() >= 8 {
        return Err("больше 8 устройств не нужно".to_string());
    }
    let token = config::new_token();
    let mut n = c.devices.len() + 2;
    let connector_id = loop {
        let cid = format!("dsh-phone-{n}");
        if cid != c.connector_id && !c.devices.iter().any(|d| d.connector_id == cid) {
            break cid;
        }
        n += 1;
    };
    c.devices.push(config::DeviceEntry {
        name,
        token,
        connector_id,
    });
    c.save()?;
    restart_if_running(&state);
    Ok(c)
}

#[tauri::command]
fn remove_device(token: String, state: State<ServerState>) -> Result<config::AppConfig, String> {
    let mut c = config::AppConfig::load_or_init();
    let before = c.devices.len();
    c.devices.retain(|d| d.token != token);
    if c.devices.len() == before {
        return Err("устройство не найдено".to_string());
    }
    c.save()?;
    restart_if_running(&state);
    Ok(c)
}

#[tauri::command]
fn tailscale_status() -> serde_json::Value {
    tailscale::detect()
}

/// Перевязывает сокеты tailscaled - лечит потерю связи после вкл/выкл WARP.
#[tauri::command]
fn heal_tailnet() -> serde_json::Value {
    let ts = match crate::tailscale::cli_path() {
        Some(p) => p,
        None => {
            return serde_json::json!({
                "ok": false,
                "rebind": false,
                "restun": false,
                "ip": crate::config::tailscale_ip(),
                "error": "tailscale CLI not found",
            })
        }
    };
    let run = |args: &[&str]| -> bool {
        crate::tailscale::hidden_command(&ts)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    let rebind = run(&["debug", "rebind"]);
    let restun = run(&["debug", "restun"]);
    let ip = crate::config::tailscale_ip();
    serde_json::json!({
        "ok": rebind || restun,
        "rebind": rebind,
        "restun": restun,
        "ip": ip,
    })
}

#[tauri::command]
fn tailscale_install() -> Result<String, String> {
    tailscale::install()
}

#[tauri::command]
fn get_autostart() -> bool {
    let out = crate::tailscale::hidden_command("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "DSHPhone"])
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

fn autostart_command_value() -> String {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "dsh-phone.exe".to_string());
    format!("\"{exe}\" --hidden")
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        let out = crate::tailscale::hidden_command("reg")
            .args(["add", key, "/v", "DSHPhone", "/t", "REG_SZ", "/d", &autostart_command_value(), "/f"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("reg add failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    } else {
        let out = crate::tailscale::hidden_command("reg")
            .args(["delete", key, "/v", "DSHPhone", "/f"])
            .output()
            .map_err(|e| e.to_string())?;
        let err = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if !out.status.success() && !err.contains("unable to find") {
            return Err(format!("reg delete failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }
    Ok(get_autostart())
}

/// QR для подключения телефона: URL PWA с токеном в hash-фрагменте.
/// Токен в QR - это ровно то, зачем фича существует (не набирать 32 символа
/// руками), поэтому код показывается только в дашборде на самом ПК.
#[tauri::command]
fn connect_qr() -> Result<qr::QrPayload, String> {
    let c = config::AppConfig::load_or_init();
    qr::payload(&c)
}

#[derive(serde::Serialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    /// Версия из релиза (если есть обновление).
    pub version: Option<String>,
    /// Текущая версия приложения - всегда заполнена, чтобы дашборд мог
    /// показать «у вас 0.3.0» даже когда проверка не нашла ничего нового.
    pub current: String,
    pub notes: Option<String>,
    /// Причина, по которой проверить не удалось. Ошибка сети - не повод
    /// валить команду: дашборд показывает её текстом вместо тихого «обновлений нет».
    pub error: Option<String>,
}

/// Проверяет GitHub Releases на новую версию.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("updater не собрался: {e}"))?;
    match updater.check().await {
        Ok(Some(u)) => Ok(UpdateInfo {
            available: true,
            version: Some(u.version.clone()),
            current,
            notes: u.body.clone(),
            error: None,
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            current,
            notes: None,
            error: None,
        }),
        Err(e) => Ok(UpdateInfo {
            available: false,
            version: None,
            current,
            notes: None,
            error: Some(e.to_string()),
        }),
    }
}

/// Качает и ставит обновление, шля прогресс событием `update-progress`.
///
/// Узел гасим до установки: NSIS не перезапишет занятый `dsh-phone.exe`
/// (мы на этом уже горели при локальных сборках - os error 5). После
/// установки приложение перезапускается, и узел поднимается снова.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("updater не собрался: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("проверка обновлений: {e}"))?
        .ok_or_else(|| "нет доступного обновления".to_string())?;
    let version = update.version.clone();

    {
        let state = app.state::<ServerState>();
        stop_inner(&state);
    }

    let h = app.clone();
    let mut downloaded: u64 = 0;
    let mut total: Option<u64> = None;
    update
        .download_and_install(
            move |chunk, len| {
                downloaded += chunk as u64;
                if let Some(t) = len {
                    total = Some(t);
                }
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| ((downloaded * 100) / t).min(100));
                let _ = h.emit(
                    "update-progress",
                    serde_json::json!({
                        "downloaded": downloaded,
                        "total": total,
                        "percent": percent,
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("установка обновления: {e}"))?;

    Ok(version)
}

/// Перезапуск после установки. request_restart, а не restart: первый идёт
/// через RunEvent::Exit и потому срабатывает надёжно из любого потока.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.request_restart();
}

#[tauri::command]
fn set_start_hidden(enabled: bool) -> config::AppConfig {
    let mut c = config::AppConfig::load_or_init();
    c.start_hidden = enabled;
    let _ = c.save();
    c
}

#[tauri::command]
fn set_allowed_ips(ips: Vec<String>) -> config::AppConfig {
    let mut c = config::AppConfig::load_or_init();
    c.allowed_ips = ips;
    let _ = c.save();
    c
}

#[tauri::command]
fn set_tls_enabled(enabled: bool, state: State<ServerState>) -> config::AppConfig {
    let mut c = config::AppConfig::load_or_init();
    c.tls_enabled = enabled;
    let _ = c.save();
    // Without this the old listener keeps serving the previous scheme: the
    // toggle looked like it did nothing until the next node restart.
    restart_if_running(&state);
    c
}

/// Копирует локальный CA на рабочий стол и возвращает путь. По https телефон
/// его скачать не может (не доверяет ещё), а по http файл бы ушёл любому в
/// сети - поэтому экспорт только с самого ПК, руками.
#[tauri::command]
fn tls_export_ca() -> Result<String, String> {
    let pem = crate::tls::ca_pem().ok_or_else(|| {
        "CA ещё не создан - включи TLS и дай узлу перезапуститься".to_string()
    })?;
    let desktop = dirs::desktop_dir().ok_or("нет рабочего стола")?;
    let out = desktop.join("dsh-phone-ca.pem");
    std::fs::write(&out, pem).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
pub struct PushStatus {
    pub subscriptions: usize,
    pub vapid_ready: bool,
    pub ntfy_enabled: bool,
    pub ntfy_url: String,
    pub ntfy_topic: String,
    pub ntfy_token: String,
}

fn push_status_of() -> PushStatus {
    let c = config::AppConfig::load_or_init();
    PushStatus {
        subscriptions: c.push_subscriptions.len(),
        vapid_ready: c.vapid_keys.is_some(),
        ntfy_enabled: c.ntfy_enabled,
        ntfy_url: c.ntfy_url.clone().unwrap_or_default(),
        ntfy_topic: c.ntfy_topic.clone().unwrap_or_default(),
        ntfy_token: c.ntfy_token.clone().unwrap_or_default(),
    }
}

#[tauri::command]
fn push_status() -> PushStatus {
    push_status_of()
}

/// ntfy channel settings. Empty url defaults to ntfy.sh; empty topic gets
/// regenerated into a fresh random one.
#[tauri::command]
fn set_ntfy(enabled: bool, url: String, topic: String, token: String) -> config::AppConfig {
    let mut c = config::AppConfig::load_or_init();
    c.ntfy_enabled = enabled;
    c.ntfy_url = Some(url.trim().to_string());
    let t = topic.trim().to_string();
    if t.is_empty() && c.ntfy_topic.as_deref().unwrap_or("").is_empty() {
        c.ntfy_topic = Some(config::random_topic());
    } else if !t.is_empty() {
        c.ntfy_topic = Some(t);
    }
    c.ntfy_token = Some(token.trim().to_string());
    let _ = c.save();
    c
}

/// Fire a test notification through every enabled channel so the user can
/// verify the phone side before trusting it.
#[tauri::command]
async fn push_test() -> Result<serde_json::Value, String> {
    let st = push_status_of();
    if !st.ntfy_enabled && st.subscriptions == 0 {
        return Err("нет включённых каналов: включи ntfy или подпишись из PWA".into());
    }
    let notice = push::Notice {
        title: "DSH Phone · тест".into(),
        body: "канал жив - если видишь это, всё настроено".into(),
        tag: "test".into(),
        session_id: None,
    };
    push::PushRouter.dispatch(&notice);
    Ok(serde_json::json!({
        "ok": true,
        "channels": {
            "webpush": st.subscriptions,
            "ntfy": st.ntfy_enabled,
        }
    }))
}

#[tauri::command]
fn push_clear() -> PushStatus {
    push::PushRouter.clear_subscriptions();
    push_status_of()
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn fallback_icon() -> tauri::image::Image<'static> {
    const N: usize = 32;
    let mut px = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            let dx = (x as f32 + 0.5 - N as f32 / 2.0).abs() / (N as f32 / 2.0);
            let dy = (y as f32 + 0.5 - N as f32 / 2.0).abs() / (N as f32 / 2.0);
            if dx + dy <= 1.0 {
                let i = (y * N + x) * 4;
                px[i] = 138;
                px[i + 1] = 56;
                px[i + 2] = 56;
                px[i + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(px, N as u32, N as u32)
}

pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![
            app_config,
            regenerate_token,
            server_status,
            start_server,
            stop_server,
            tailscale_status,
            heal_tailnet,
            tailscale_install,
            get_autostart,
            set_autostart,
            set_start_hidden,
            set_allowed_ips,
            set_tls_enabled,
            tls_export_ca,
            connect_qr,
            update_check,
            update_install,
            restart_app,
            set_ntfy,
            push_status,
            push_test,
            push_clear,
            add_device,
            remove_device
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        // автообновление из GitHub Releases (рестарт делает ядро: request_restart)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Закрыть", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let icon = app
                .default_window_icon()
                .map(|img| tauri::image::Image::new_owned(img.rgba().to_vec(), img.width(), img.height()))
                .unwrap_or_else(fallback_icon);
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("DSH Phone")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let state = app.state::<ServerState>();
            let _ = do_start(&state);

            let args: Vec<String> = std::env::args().collect();
            let cfg = config::AppConfig::load_or_init();
            if cfg.start_hidden || args.iter().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DSH Phone");
}