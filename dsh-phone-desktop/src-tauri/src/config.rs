use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceEntry {
    pub name: String,
    pub token: String,
    pub connector_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub config_path: String,
    pub token: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub staging_path: String,
    pub tailscale_ip: String,
    pub connector_id: String,
    pub created_at_unix: u64,
    #[serde(default = "default_bridge_endpoint")]
    pub bridge_endpoint_path: String,
    #[serde(default = "default_poll_seconds")]
    pub poll_seconds: f64,
    #[serde(default = "default_event_buffer_max")]
    pub event_buffer_max: usize,
    #[serde(default = "default_max_attachment_bytes")]
    pub max_attachment_bytes: u64,
    #[serde(default = "default_start_hidden")]
    pub start_hidden: bool,
    #[serde(default)]
    pub tls_enabled: bool,
    #[serde(default)]
    pub allowed_ips: Vec<String>,
    #[serde(default)]
    pub devices: Vec<DeviceEntry>,
    #[serde(default)]
    pub vapid_keys: Option<crate::push::VapidKeys>,
    #[serde(default)]
    pub push_subscriptions: Vec<crate::push::PushSubscription>,
    #[serde(default)]
    pub ntfy_enabled: bool,
    #[serde(default, serialize_with = "ser_opt_string", deserialize_with = "de_opt_string")]
    pub ntfy_url: Option<String>,
    #[serde(default, serialize_with = "ser_opt_string", deserialize_with = "de_opt_string")]
    pub ntfy_topic: Option<String>,
    #[serde(default, serialize_with = "ser_opt_string", deserialize_with = "de_opt_string")]
    pub ntfy_token: Option<String>,
}

fn ser_opt_string<S: serde::Serializer>(v: &Option<String>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(v.as_deref().unwrap_or(""))
}

fn de_opt_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let s: Option<String> = Option::deserialize(d)?;
    Ok(Some(s.unwrap_or_default()))
}

/// Random ntfy topic: unguessable in practice (a secret by itself).
pub fn random_topic() -> String {
    format!("dsh-{}", new_token())
}

fn default_bridge_endpoint() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".dsh")
        .join("agents-anywhere")
        .join("bridge")
        .join("endpoint.json")
        .to_string_lossy()
        .to_string()
}
fn default_poll_seconds() -> f64 {
    2.0
}
fn default_event_buffer_max() -> usize {
    400
}
fn default_max_attachment_bytes() -> u64 {
    50 * 1024 * 1024
}
fn default_start_hidden() -> bool {
    false
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-phone")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn new_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn tailscale_ip() -> String {
    // 1) авторитетный источник - сам tailscale CLI
    for exe in [
        r"C:\Program Files\Tailscale\tailscale.exe".to_string(),
        "tailscale.exe".to_string(),
    ] {
        if let Ok(out) = std::process::Command::new(&exe).arg("ip").arg("-4").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if s.starts_with("100.") {
                    return s;
                }
            }
        }
    }
    // 2) интерфейс из CGNAT-диапазона tailnet
    if let Ok(addrs) = get_if_addrs::get_if_addrs() {
        for a in &addrs {
            if let std::net::IpAddr::V4(v4) = a.ip() {
                let o = v4.octets();
                if o[0] == 100 && o[1] >= 64 && o[1] <= 127 {
                    return v4.to_string();
                }
            }
        }
    }
    // 3) не врём про чужие адаптеры (WARP/виртуалки) - честный loopback
    "127.0.0.1".to_string()
}

impl AppConfig {
    pub fn generate() -> Self {
        let cp = config_path();
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let staging = home
            .join(".dsh")
            .join("agents-anywhere")
            .join("bridge")
            .join("attachments")
            .join("staging");
        AppConfig {
            config_path: cp.to_string_lossy().to_string(),
            token: new_token(),
            listen_host: "0.0.0.0".to_string(),
            listen_port: 8460,
            staging_path: staging.to_string_lossy().to_string(),
            tailscale_ip: tailscale_ip(),
            connector_id: "dsh-phone".to_string(),
            created_at_unix: now(),
            bridge_endpoint_path: default_bridge_endpoint(),
            poll_seconds: 2.0,
            event_buffer_max: 400,
            max_attachment_bytes: 50 * 1024 * 1024,
            start_hidden: false,
            tls_enabled: false,
            allowed_ips: Vec::new(),
            devices: Vec::new(),
            vapid_keys: Some(crate::push::VapidKeys::generate()),
            push_subscriptions: Vec::new(),
            ntfy_enabled: false,
            ntfy_url: None,
            ntfy_topic: Some(random_topic()),
            ntfy_token: None,
        }
    }

    pub fn load_or_init() -> Self {
        let cp = config_path();
        if cp.exists() {
            if let Ok(s) = fs::read_to_string(&cp) {
                match serde_json::from_str::<AppConfig>(&s) {
                    Ok(mut c) => {
                        c.config_path = cp.to_string_lossy().to_string();
                        c.tailscale_ip = tailscale_ip();
                        if c.vapid_keys.is_none() {
                            c.vapid_keys = Some(crate::push::VapidKeys::generate());
                        }
                        if c.ntfy_topic.is_none() {
                            c.ntfy_topic = Some(random_topic());
                        }
                        let _ = c.save();
                        return c;
                    }
                    Err(e) => {
                        // не теряем файл молча: сохраняем копию, чтобы ключ можно было вернуть руками
                        eprintln!("dsh-phone: config parse failed ({e}); backed up");
                        let _ = fs::copy(&cp, cp.with_extension("json.bak"));
                    }
                }
            }
        }
        let c = AppConfig::generate();
        let _ = c.save();
        c
    }

    pub fn save(&self) -> Result<(), String> {
        let p = std::path::Path::new(&self.config_path);
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(p, json).map_err(|e| e.to_string())
    }

    /// True when a connection from this peer IP should be accepted.
    /// Empty allowlist = allow all. Loopback is always allowed. Supports exact
    /// IPv4/IPv6 entries and IPv4 CIDR (e.g. "100.75.97.90" or "100.64.0.0/10").
    pub fn allow_ip(&self, ip: std::net::IpAddr) -> bool {
        if ip.is_loopback() || self.allowed_ips.is_empty() {
            return true;
        }
        match ip {
            std::net::IpAddr::V4(v4) => {
                let ip_u = u32::from_be_bytes(v4.octets());
                for a in &self.allowed_ips {
                    let a = a.trim();
                    if a.is_empty() {
                        continue;
                    }
                    if a == v4.to_string() {
                        return true;
                    }
                    if let Some((base, bits)) = a.split_once('/') {
                        if let (Ok(b), Ok(n)) =
                            (base.parse::<std::net::Ipv4Addr>(), bits.parse::<u32>())
                        {
                            if n <= 32 {
                                let mask = if n == 0 { 0u32 } else { u32::MAX << (32 - n) };
                                if (ip_u & mask) == (u32::from_be_bytes(b.octets()) & mask) {
                                    return true;
                                }
                            }
                        }
                    }
                }
                false
            }
            std::net::IpAddr::V6(v6) => {
                let s = v6.to_string();
                self.allowed_ips.iter().any(|a| a.trim() == s)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gen_writes_file() {
        let c = AppConfig::generate();
        c.save().unwrap();
        let p = std::path::Path::new(&c.config_path);
        println!("config_path={}", c.config_path);
        println!("token_len={} tailscale={}", c.token.len(), c.tailscale_ip);
        assert!(p.exists());
        assert_eq!(c.token.len(), 32);
    }
}