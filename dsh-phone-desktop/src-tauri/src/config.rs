use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    if let Ok(addrs) = get_if_addrs::get_if_addrs() {
        for a in &addrs {
            if let std::net::IpAddr::V4(v4) = a.ip() {
                let o = v4.octets();
                if o[0] == 100 && o[1] >= 64 && o[1] <= 127 {
                    return v4.to_string();
                }
            }
        }
        for a in &addrs {
            if let std::net::IpAddr::V4(v4) = a.ip() {
                let o = v4.octets();
                if o[0] == 10 || o[0] == 172 || o[0] == 192 {
                    return v4.to_string();
                }
            }
        }
    }
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
        }
    }

    pub fn load_or_init() -> Self {
        let cp = config_path();
        if cp.exists() {
            if let Ok(s) = fs::read_to_string(&cp) {
                if let Ok(mut c) = serde_json::from_str::<AppConfig>(&s) {
                    c.config_path = cp.to_string_lossy().to_string();
                    c.tailscale_ip = tailscale_ip();
                    let _ = c.save();
                    return c;
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