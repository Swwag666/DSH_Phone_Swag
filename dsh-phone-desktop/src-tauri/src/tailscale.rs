use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

/// Console apps spawned from a GUI process flash their own window on Windows.
/// The dashboard polls status every 2s, and each `tailscale.exe`/`where` call
/// used to paint a terminal box that immediately vanished - so the user saw a
/// window flickering forever. Every background probe goes through this helper
/// (winget is the exception: its installer raises UAC and must stay visible).
#[cfg(windows)]
pub fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(windows))]
pub fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

/// Reports whether Tailscale is installed, logged in and its current IP.
pub fn detect() -> Value {
    let installed = tailscale_installed();
    if !installed {
        return json!({ "installed": false, "logged_in": false, "ip": Value::Null, "dns_name": Value::Null });
    }
    match cli_path() {
        None => json!({ "installed": true, "logged_in": false, "ip": Value::Null }),
        Some(exe) => match hidden_command(&exe).args(["ip", "-4"]).output() {
            Ok(o) if o.status.success() => {
                let ip = String::from_utf8_lossy(&o.stdout).trim().to_string();
                json!({
                    "installed": true,
                    "logged_in": !ip.is_empty(),
                    "ip": if ip.is_empty() { Value::Null } else { Value::String(ip) },
                    "dns_name": magicdns_name()
                })
            }
            _ => json!({ "installed": true, "logged_in": false, "ip": Value::Null, "dns_name": Value::Null }),
        },
    }
}

/// Kick off a winget install of Tailscale. Returns immediately; the installer
/// runs in its own window and raises UAC itself.
pub fn install() -> Result<String, String> {
    if tailscale_installed() {
        return Ok("already installed".to_string());
    }
    let _child = Command::new("winget")
        .args([
            "install",
            "-e",
            "--id",
            "Tailscale.Tailscale",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .spawn()
        .map_err(|e| {
            format!("winget недоступен ({e}) — поставь tailscale вручную с tailscale.com")
        })?;
    Ok("install started".to_string())
}

/// MagicDNS fully-qualified name of this machine (desktop-xxx.tailNNN.ts.net).
/// Stable across tailnet IP reissues, which a raw IP SAN is not - so the TLS
/// cert carries it too and the phone can connect by name.
pub fn magicdns_name() -> Option<String> {
    let exe = cli_path()?;
    let out = hidden_command(&exe).args(["status", "--json"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(&text).ok()?;
    let name = v.get("Self")?.get("DNSName")?.as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn tailscale_installed() -> bool {
    cli_path().is_some()
        || [
            r"C:\Program Files\Tailscale\tailscaled.exe",
            r"C:\Program Files (x86)\Tailscale\tailscaled.exe",
        ]
        .iter()
        .any(|m| Path::new(m).exists())
        || Path::new(r"C:\ProgramData\Tailscale").exists()
}

/// Absolute path of the tailscale CLI, or None when it is not found.
/// Checked from the two default install locations and then from PATH.
pub(crate) fn cli_path() -> Option<String> {
    for c in [
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ] {
        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    let out = hidden_command("where").arg("tailscale").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    for line in text.lines() {
        let t = line.trim();
        let low = t.to_lowercase();
        if low.ends_with("tailscale.exe") && !low.contains("tailscaled") {
            return Some(t.to_string());
        }
    }
    None
}