use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

/// Reports whether Tailscale is installed, logged in and its current IP.
pub fn detect() -> Value {
    let installed = tailscale_installed();
    if !installed {
        return json!({ "installed": false, "logged_in": false, "ip": Value::Null });
    }
    match cli_path() {
        None => json!({ "installed": true, "logged_in": false, "ip": Value::Null }),
        Some(exe) => match Command::new(&exe).args(["ip", "-4"]).output() {
            Ok(o) if o.status.success() => {
                let ip = String::from_utf8_lossy(&o.stdout).trim().to_string();
                json!({
                    "installed": true,
                    "logged_in": !ip.is_empty(),
                    "ip": if ip.is_empty() { Value::Null } else { Value::String(ip) }
                })
            }
            _ => json!({ "installed": true, "logged_in": false, "ip": Value::Null }),
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
    let out = Command::new("where").arg("tailscale").output().ok()?;
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