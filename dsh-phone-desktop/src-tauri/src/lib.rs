mod bridge;
mod config;
mod gateway;
mod pwa;
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
}

fn status_of(state: &ServerState) -> ServerStatus {
    let tls_sha256 = crate::tls::cert_sha256();
    match state.running.lock().unwrap().as_ref() {
        Some(s) => ServerStatus {
            running: true,
            port: s.port,
            uptime_seconds: s.started_at.elapsed().as_secs(),
            requests: s.requests.load(Ordering::Relaxed),
            tls_sha256,
        },
        None => ServerStatus {
            running: false,
            port: 8460,
            uptime_seconds: 0,
            requests: 0,
            tls_sha256,
        },
    }
}

fn is_running(state: &ServerState) -> bool {
    state.running.lock().unwrap().is_some()
}

fn do_start(state: &ServerState) -> Result<ServerStatus, String> {
    if is_running(state) {
        return Ok(status_of(state));
    }

    let cfg = Arc::new(config::AppConfig::load_or_init());
    let port = cfg.listen_port;
    let started_at = std::time::Instant::now();
    let requests = Arc::new(AtomicU64::new(0));
    let (gw, notify_rx) = gateway::Gateway::new(cfg, requests.clone());
    let bg = gw.start_background(notify_rx);
    let (tx, rx) = tokio::sync::mpsc::channel::<()>(1);
    let handle = tauri::async_runtime::spawn(server::serve(gw, rx));

    {
        let mut g = state.running.lock().unwrap();
        *g = Some(RunningServer {
            handle,
            bg,
            shutdown: tx,
            started_at,
            port,
            requests,
        });
    }
    Ok(status_of(state))
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
    let taken = {
        let mut g = state.running.lock().unwrap();
        g.take()
    };
    if let Some(s) = taken {
        let _ = s.shutdown.try_send(());
        s.handle.abort();
        for h in s.bg {
            h.abort();
        }
    }
    status_of(&state)
}

#[tauri::command]
fn tailscale_status() -> serde_json::Value {
    tailscale::detect()
}

#[tauri::command]
fn tailscale_install() -> Result<String, String> {
    tailscale::install()
}

#[tauri::command]
fn get_autostart() -> bool {
    let out = std::process::Command::new("reg")
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
        let out = std::process::Command::new("reg")
            .args(["add", key, "/v", "DSHPhone", "/t", "REG_SZ", "/d", &autostart_command_value(), "/f"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("reg add failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    } else {
        let out = std::process::Command::new("reg")
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
fn set_tls_enabled(enabled: bool) -> config::AppConfig {
    let mut c = config::AppConfig::load_or_init();
    c.tls_enabled = enabled;
    let _ = c.save();
    c
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
            tailscale_install,
            get_autostart,
            set_autostart,
            set_start_hidden,
            set_allowed_ips,
            set_tls_enabled
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
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