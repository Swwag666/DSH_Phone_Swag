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
    #[serde(default = "default_staging_retention_secs")]
    pub staging_retention_secs: u64,
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
    1.0
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
fn default_staging_retention_secs() -> u64 {
    7 * 86400
}

pub fn config_dir() -> PathBuf {
    // Test/local override: keeps `cargo test` from ever touching the real
    // user config (a regression here once regenerated a live token).
    if let Ok(dir) = std::env::var("DSH_PHONE_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-phone")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Timestamped copy of a config we could not parse. A single `.bak` slot was
/// overwritten by the next failure, which once destroyed the only backup of a
/// working token - the phone then could not authenticate at all.
fn backup_config(cp: &std::path::Path) {
    let stamp = chrono_stamp();
    let target = cp.with_file_name(format!("config-corrupt-{stamp}.json"));
    let _ = fs::copy(cp, &target);
    // и обычный .bak на всякий случай, для тех кто ищет привычное имя
    let _ = fs::copy(cp, cp.with_extension("json.bak"));
    // держим не больше 10 копий
    if let Some(dir) = cp.parent() {
        if let Ok(entries) = fs::read_dir(dir) {
            let mut corrupt: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("config-corrupt-"))
                        .unwrap_or(false)
                })
                .collect();
            corrupt.sort();
            while corrupt.len() > 10 {
                let oldest = corrupt.remove(0);
                let _ = fs::remove_file(&oldest);
            }
        }
    }
}

fn chrono_stamp() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{s}")
}

/// A corrupt config must not cost the user their token, VAPID keys or ntfy
/// topic. Two passes:
///  1. the JSON still parses but one field changed type -> read field by field;
///  2. the JSON is truncated/garbage (torn write, disk full) -> scrape the
///     secrets out of the raw text, which is where most real corruption lands.
fn salvage(raw: &str) -> Option<AppConfig> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(obj) = v.as_object() {
            if let Some(c) = salvage_fields(obj) {
                return Some(c);
            }
        }
    }
    salvage_text(raw)
}

/// Last-resort scrape from raw text. Only pulls the values that cost the user
/// real pain to lose: the token (phone auth), the ntfy topic (secret channel)
/// and the VAPID key pair (push identity). Everything else regenerates safely.
fn salvage_text(raw: &str) -> Option<AppConfig> {
    fn grab_str(raw: &str, key: &str) -> Option<String> {
        // допускаем пробелы вокруг ':' и обрезанный хвост файла
        let pat = format!("\"{key}\"");
        let at = raw.find(&pat)?;
        let rest = &raw[at + pat.len()..];
        let colon = rest.find(':')?;
        let after = rest[colon + 1..].trim_start();
        if !after.starts_with('"') {
            return None;
        }
        let body = &after[1..];
        let end = body.find('"')?;
        let v = body[..end].to_string();
        if v.is_empty() {
            return None;
        }
        Some(v)
    }

    let mut c = AppConfig::generate();
    let mut kept_any = false;
    if let Some(t) = grab_str(raw, "token") {
        if t.len() >= 16 {
            c.token = t;
            kept_any = true;
        }
    }
    if let Some(topic) = grab_str(raw, "ntfy_topic") {
        if topic.starts_with("dsh-") {
            c.ntfy_topic = Some(topic);
            kept_any = true;
        }
    }
    if let Some(pub_hex) = grab_str(raw, "public_hex") {
        if let Some(private_hex) = grab_str(raw, "private_hex") {
            if pub_hex.len() >= 64 && private_hex.len() >= 32 {
                c.vapid_keys = Some(crate::push::VapidKeys {
                    public_hex: pub_hex,
                    private_hex,
                });
                kept_any = true;
            }
        }
    }
    if !kept_any {
        return None;
    }
    eprintln!("dsh-phone: config unparsable - scraped secrets out of the raw text");
    Some(c)
}

fn salvage_fields(obj: &serde_json::Map<String, serde_json::Value>) -> Option<AppConfig> {
    let mut c = AppConfig::generate();
    let mut kept_any = false;
    if let Some(t) = obj.get("token").and_then(|x| x.as_str()) {
        if t.len() >= 16 {
            c.token = t.to_string();
            kept_any = true;
        }
    }
    if let Some(p) = obj.get("listen_port").and_then(|x| x.as_u64()) {
        c.listen_port = p as u16;
    }
    if let Some(h) = obj.get("listen_host").and_then(|x| x.as_str()) {
        c.listen_host = h.to_string();
    }
    if let Some(id) = obj.get("connector_id").and_then(|x| x.as_str()) {
        c.connector_id = id.to_string();
    }
    if let Some(st) = obj.get("staging_path").and_then(|x| x.as_str()) {
        c.staging_path = st.to_string();
    }
    if let Some(tls) = obj.get("tls_enabled").and_then(|x| x.as_bool()) {
        c.tls_enabled = tls;
    }
    if let Some(devs) = obj.get("devices") {
        if let Ok(d) = serde_json::from_value::<Vec<DeviceEntry>>(devs.clone()) {
            if !d.is_empty() {
                kept_any = true;
            }
            c.devices = d;
        }
    }
    if let Some(vk) = obj.get("vapid_keys") {
        if let Ok(k) = serde_json::from_value::<crate::push::VapidKeys>(vk.clone()) {
            c.vapid_keys = Some(k);
            kept_any = true;
        }
    }
    if let Some(subs) = obj.get("push_subscriptions") {
        if let Ok(s) = serde_json::from_value::<Vec<crate::push::PushSubscription>>(subs.clone()) {
            if !s.is_empty() {
                kept_any = true;
            }
            c.push_subscriptions = s;
        }
    }
    for (key, out) in [
        ("ntfy_url", &mut c.ntfy_url),
        ("ntfy_topic", &mut c.ntfy_topic),
        ("ntfy_token", &mut c.ntfy_token),
    ] {
        if let Some(s) = obj.get(key).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                *out = Some(s.to_string());
                kept_any = true;
            }
        }
    }
    if let Some(n) = obj.get("ntfy_enabled").and_then(|x| x.as_bool()) {
        c.ntfy_enabled = n;
    }
    if !kept_any {
        return None;
    }
    eprintln!("dsh-phone: salvaged config (token kept: {})", c.token.len() >= 16);
    Some(c)
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

/// Сколько живёт закэшированный IP tailnet. Адрес перевыпускается редко
/// (минуты/часы), а вот load_or_init() дёргается на каждый push-dispatch и на
/// каждый HTTP-запрос телефона - поэтому детект не должен быть чаще TTL.
const TS_IP_TTL: std::time::Duration = std::time::Duration::from_secs(30);

static TS_IP_CACHE: std::sync::Mutex<Option<(std::time::Instant, String)>> =
    std::sync::Mutex::new(None);

fn ts_ip_cache_get() -> Option<String> {
    let g = TS_IP_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some((at, ip)) if at.elapsed() < TS_IP_TTL => Some(ip.clone()),
        _ => None,
    }
}

fn ts_ip_cache_put(ip: &str) {
    *TS_IP_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((std::time::Instant::now(), ip.to_string()));
}

/// Всегда свежий IP: дёргает CLI и обновляет кеш. Только для редких явных
/// запросов - например heal_tailnet() сразу после rebind/restun, где
/// закэшированное значение заведомо устарело.
pub fn tailscale_ip() -> String {
    let ip = detect_tailscale_ip();
    ts_ip_cache_put(&ip);
    ip
}

/// IP из кеша; детект - лишь когда кеш пуст или протух (не чаще раза в TTL на
/// процесс). Это путь load_or_init()/generate(): QR и SAN сертификата по-прежнему
/// видят актуальный адрес, но внешний процесс больше не запускается на каждое
/// перечитывание конфига - а оно происходит под CONFIG_LOCK в push.rs, то есть
/// блокирующий spawn tailscale.exe вешал глобальный мьютекс на tokio-worker'е.
pub fn cached_tailscale_ip() -> String {
    if let Some(ip) = ts_ip_cache_get() {
        return ip;
    }
    tailscale_ip()
}

fn detect_tailscale_ip() -> String {
    // 1) авторитетный источник - сам tailscale CLI (hidden: консольное окно не
    // должно мелькать)
    for exe in [
        r"C:\Program Files\Tailscale\tailscale.exe".to_string(),
        "tailscale.exe".to_string(),
    ] {
        if let Ok(out) = crate::tailscale::hidden_command(&exe)
            .arg("ip")
            .arg("-4")
            .output()
        {
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
            tailscale_ip: cached_tailscale_ip(),
            connector_id: "dsh-phone".to_string(),
            created_at_unix: now(),
            bridge_endpoint_path: default_bridge_endpoint(),
            poll_seconds: default_poll_seconds(),
            event_buffer_max: 400,
            max_attachment_bytes: 50 * 1024 * 1024,
            start_hidden: false,
            tls_enabled: false,
            allowed_ips: Vec::new(),
            staging_retention_secs: default_staging_retention_secs(),
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
                        // из кеша, а не детектом: load_or_init() вызывается под
                        // CONFIG_LOCK (push.rs) и на каждый HTTP-запрос телефона,
                        // спавнить tailscale.exe там нельзя
                        c.tailscale_ip = cached_tailscale_ip();
                        if c.vapid_keys.is_none() {
                            c.vapid_keys = Some(crate::push::VapidKeys::generate());
                        }
                        if c.ntfy_topic.is_none() {
                            c.ntfy_topic = Some(random_topic());
                        }
                        // миграция: старый дефолт 2.0 тормозил подхват чатов
                        // на клиенте; поднимаем до 1.0, если юзер не выставил
                        // своё значение ниже.
                        if c.poll_seconds > 1.9 && c.poll_seconds <= 2.1 {
                            c.poll_seconds = default_poll_seconds();
                        }
                        let _ = c.save();
                        return c;
                    }
                    Err(e) => {
                        // не теряем файл молча: копия с меткой времени (простая
                        // .bak затиралась при следующем сбое и уносила последний
                        // живой токен), плюс пробуем вытащить ценности из битого
                        // JSON - один повреждённый хвост не должен стоить юзеру
                        // токена, VAPID-ключей и ntfy-топика.
                        eprintln!("dsh-phone: config parse failed ({e}); backing up and salvaging");
                        backup_config(&cp);
                        if let Some(mut c) = salvage(&s) {
                            c.config_path = cp.to_string_lossy().to_string();
                            c.tailscale_ip = cached_tailscale_ip();
                            if c.vapid_keys.is_none() {
                                c.vapid_keys = Some(crate::push::VapidKeys::generate());
                            }
                            if c.ntfy_topic.is_none() {
                                c.ntfy_topic = Some(random_topic());
                            }
                            let _ = c.save();
                            return c;
                        }
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
        // атомарно: пишем во временный и переименовываем. Обычный fs::write
        // рвал конфиг пополам при падении/выключении в момент записи, а битый
        // конфиг дальше регенерил токен и телефон терял доступ.
        let tmp = p.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        // rename атомарен и на Windows заменяет существующий файл
        fs::rename(&tmp, p).map_err(|e| e.to_string())
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
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn v4(s: &str) -> IpAddr {
        IpAddr::V4(s.parse::<Ipv4Addr>().unwrap())
    }

    /// Тесты ниже крутят DSH_PHONE_CONFIG_DIR - процесс-глобальную переменную.
    /// Без замка они читают конфиг из каталога соседа и падают случайно, поэтому
    /// все, кто её трогает, держат этот мьютекс.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn gen_writes_file() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("dsh-phone-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("DSH_PHONE_CONFIG_DIR", &dir);
        let c = AppConfig::generate();
        c.save().unwrap();
        let p = std::path::Path::new(&c.config_path);
        println!("config_path={}", c.config_path);
        println!("token_len={} tailscale={}", c.token.len(), c.tailscale_ip);
        assert!(p.exists());
        assert_eq!(c.token.len(), 32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_defaults_have_staging_retention() {
        let c = AppConfig::generate();
        assert_eq!(c.staging_retention_secs, 7 * 86400);
    }

    #[test]
    fn deserialising_old_config_gets_default_retention() {
        let raw = serde_json::json!({
            "config_path": "x.json",
            "token": "0123456789abcdef0123456789abcdef",
            "listen_host": "0.0.0.0",
            "listen_port": 8460,
            "staging_path": "stage",
            "tailscale_ip": "127.0.0.1",
            "connector_id": "dsh-phone",
            "created_at_unix": 1,
        });
        let c: AppConfig = serde_json::from_value(raw).unwrap();
        assert_eq!(c.staging_retention_secs, 7 * 86400);
        assert!(c.allowed_ips.is_empty());
    }

    #[test]
    fn allow_ip_loopback_always_allowed() {
        let mut c = AppConfig::generate();
        c.allowed_ips = vec!["10.0.0.1".to_string()];
        assert!(c.allow_ip(v4("127.0.0.1")));
        assert!(c.allow_ip(IpAddr::V6("::1".parse::<Ipv6Addr>().unwrap())));
        assert!(!c.allow_ip(v4("10.0.0.5")));
    }

    #[test]
    fn allow_ip_empty_list_allows_all() {
        let c = AppConfig::generate();
        assert!(c.allow_ip(v4("8.8.8.8")));
    }

    #[test]
    fn allow_ip_exact_match() {
        let mut c = AppConfig::generate();
        c.allowed_ips = vec!["100.75.97.90".to_string()];
        assert!(c.allow_ip(v4("100.75.97.90")));
        assert!(!c.allow_ip(v4("100.75.97.91")));
    }

    #[test]
    fn allow_ip_cidr() {
        let mut c = AppConfig::generate();
        c.allowed_ips = vec!["100.64.0.0/10".to_string()];
        assert!(c.allow_ip(v4("100.64.0.0")));
        assert!(c.allow_ip(v4("100.75.97.90")));
        assert!(c.allow_ip(v4("100.127.255.255")));
        // boundary: outside the CGNAT /10 tailnet range
        assert!(!c.allow_ip(v4("100.128.0.1")));
        assert!(!c.allow_ip(v4("100.63.255.255")));
        assert!(!c.allow_ip(v4("101.0.0.1")));
    }

    #[test]
    fn allow_ip_cidr_slash_zero_allows_everything() {
        let mut c = AppConfig::generate();
        c.allowed_ips = vec!["0.0.0.0/0".to_string()];
        assert!(c.allow_ip(v4("1.2.3.4")));
        assert!(c.allow_ip(v4("255.255.255.255")));
    }

    #[test]
    fn allow_ip_garbage_entries_do_not_panic() {
        let mut c = AppConfig::generate();
        c.allowed_ips = vec![
            "not-an-ip".to_string(),
            "".to_string(),
            "100.0.0.0/".to_string(),
            "100.0.0.0/99".to_string(),
        ];
        assert!(!c.allow_ip(v4("100.1.2.3")));
    }

    #[test]
    fn allow_ip_v6_exact() {
        let mut c = AppConfig::generate();
        // stored in expanded form, compared via normalised to_string()
        c.allowed_ips = vec!["fd7a:115c:a1e0::1".to_string()];
        assert!(c
            .allow_ip(IpAddr::V6("fd7a:115c:a1e0::1".parse::<Ipv6Addr>().unwrap())));
        // a different host is rejected
        assert!(!c
            .allow_ip(IpAddr::V6("fd7a:115c:a1e0::2".parse::<Ipv6Addr>().unwrap())));
        assert!(!c
            .allow_ip(IpAddr::V6("fd7a::1".parse::<Ipv6Addr>().unwrap())));
    }
    // ---- регрессия: битый конфиг однажды стоил юзеру токена и VAPID-ключей ----
    // Значения в фикстурах собираются кодом (а не вписаны готовыми строками),
    // чтобы тест не зависел от того, как файл прошёл через редактор/маскиратор.

    /// Токен вида "aaaa..." - заведомо не секрет, но по формату совпадает с
    /// тем, что кладёт new_token() (32 символа).
    fn fake_token(seed: char) -> String {
        std::iter::repeat_n(seed, 32).collect()
    }

    fn fake_hex(seed: &str, len: usize) -> String {
        let mut s = String::new();
        while s.len() < len {
            s.push_str(seed);
        }
        s.truncate(len);
        s
    }

    #[test]
    fn salvage_keeps_secrets_from_truncated_json() {
        // оборванная запись: файл не парсится как JSON вовсе
        let tok = fake_token('a');
        let topic = format!("dsh-{}", fake_hex("6136aa0b", 32));
        let pub_hex = format!("04{}", fake_hex("ab", 64));
        let priv_hex = fake_hex("cd", 64);
        let raw = format!(
            r#"{{
  "config_path": "C:\\x\\config.json",
  "token": "{tok}",
  "listen_host": "0.0.0.0",
  "ntfy_topic": "{topic}",
  "vapid_keys": {{
    "public_hex": "{pub_hex}",
    "private_hex": "{priv_hex}"
  }},
  "push_subs"#
        );
        let c = salvage(&raw).expect("truncated config must still yield secrets");
        assert_eq!(c.token, tok);
        assert_eq!(c.ntfy_topic.as_deref(), Some(topic.as_str()));
        let vk = c.vapid_keys.expect("vapid keys must survive");
        assert_eq!(vk.public_hex, pub_hex);
        assert_eq!(vk.private_hex, priv_hex);
    }

    #[test]
    fn salvage_keeps_secrets_when_a_field_changed_type() {
        // JSON валиден, но listen_port стал строкой - serde роняет весь файл
        let tok = fake_token('b');
        let topic = format!("dsh-{}", fake_hex("7767cc55", 32));
        let raw = format!(
            r#"{{
  "config_path": "x.json",
  "token": "{tok}",
  "listen_host": "0.0.0.0",
  "listen_port": "8460",
  "staging_path": "stage",
  "tailscale_ip": "100.1.2.3",
  "connector_id": "dsh-phone",
  "created_at_unix": 1,
  "ntfy_topic": "{topic}"
}}"#
        );
        let c = salvage(&raw).expect("type-drift must not cost the token");
        assert_eq!(c.token, tok);
        assert_eq!(c.ntfy_topic.as_deref(), Some(topic.as_str()));
        // порт сменил тип - остаётся дефолт, это безопасно
        assert_eq!(c.listen_port, 8460);
    }

    #[test]
    fn salvage_refuses_when_there_is_nothing_to_keep() {
        assert!(salvage("это вообще не json").is_none());
        assert!(salvage(r#"{"listen_port": 8460}"#).is_none());
        // короткий токен не берём - это мусор, а не секрет
        let short = format!(
            r#"{{"token": "{}"}}"#,
            fake_token('c').chars().take(8).collect::<String>()
        );
        assert!(salvage(&short).is_none());
    }

    #[test]
    fn salvage_keeps_devices_even_when_a_field_changed_type() {
        let tok = fake_token('d');
        let dev_tok = fake_token('e');
        let raw = format!(
            r#"{{
  "config_path": "x.json",
  "token": "{tok}",
  "listen_host": "0.0.0.0",
  "listen_port": "nope",
  "staging_path": "stage",
  "tailscale_ip": "100.1.2.3",
  "connector_id": "dsh-phone",
  "created_at_unix": 1,
  "devices": [{{"name": "iphone", "token": "{dev_tok}", "connector_id": "c1"}}]
}}"#
        );
        let c = salvage(&raw).expect("devices must survive");
        assert_eq!(c.token, tok);
        assert_eq!(c.devices.len(), 1);
        assert_eq!(c.devices[0].name, "iphone");
        assert_eq!(c.devices[0].token, dev_tok);
    }

    #[test]
    fn save_is_atomic_and_leaves_no_tmp_behind() {
        let dir = std::env::temp_dir()
            .join(format!("dsh-atomic-{}-{}", std::process::id(), new_token()));
        let _ = std::fs::create_dir_all(&dir);
        let mut c = AppConfig::generate();
        c.config_path = dir.join("config.json").to_string_lossy().to_string();
        c.save().unwrap();
        let updated = fake_token('f');
        c.token = updated.clone();
        c.save().unwrap();
        let raw = fs::read_to_string(&c.config_path).unwrap();
        assert!(raw.contains(&updated), "second save must land");
        assert!(
            !dir.join("config.json.tmp").exists(),
            "tmp file must not linger"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_config_on_disk_keeps_the_token() {
        // сквозной сценарий: файл на диске битый -> load_or_init возвращает
        // прежний токен и оставляет бэкап, а не регенерит новый
        let dir = std::env::temp_dir().join(format!("dsh-corrupt-{}", new_token()));
        let _ = fs::create_dir_all(&dir);
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("DSH_PHONE_CONFIG_DIR").ok();
        std::env::set_var("DSH_PHONE_CONFIG_DIR", &dir);
        let path = dir.join("config.json");
        let tok = fake_token('a');
        let broken = format!(r#"{{ "token": "{tok}", "listen_port": "oops""#);
        fs::write(&path, &broken).unwrap();

        let c = AppConfig::load_or_init();
        assert_eq!(c.token, tok, "live token must survive a corrupt config");
        let has_backup = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("config-corrupt-"));
        assert!(has_backup, "a timestamped backup must be kept");

        let _ = fs::remove_dir_all(&dir);
        match prev {
            Some(v) => std::env::set_var("DSH_PHONE_CONFIG_DIR", v),
            None => std::env::remove_var("DSH_PHONE_CONFIG_DIR"),
        }
    }
}
