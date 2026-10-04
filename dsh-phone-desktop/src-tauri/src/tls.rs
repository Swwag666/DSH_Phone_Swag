use std::net::IpAddr;

use crate::config::{config_dir, AppConfig};

fn cert_path() -> std::path::PathBuf {
    config_dir().join("tls_cert.pem")
}

fn key_path() -> std::path::PathBuf {
    config_dir().join("tls_key.pem")
}

fn ca_cert_path() -> std::path::PathBuf {
    config_dir().join("tls_ca.pem")
}

fn ca_key_path() -> std::path::PathBuf {
    config_dir().join("tls_ca.key.pem")
}

/// Records which tailscale IP the leaf cert was minted for. The IP is not
/// stable (tailnet reissues happen), and a cert whose SAN no longer matches
/// makes every browser refuse the connection - so we regenerate the leaf on
/// mismatch instead of serving a stale cert forever.
fn cert_ip_marker() -> std::path::PathBuf {
    config_dir().join("tls_cert.ip")
}

/// The CA cert is what the phone installs once (profile on iOS, user cert on
/// Android). Exported from the PC via the `tls_export_ca` command - it cannot
/// be fetched over https (the phone does not trust the cert yet) and serving it
/// over plain http would hand it to anyone on the network.
pub fn ca_pem() -> Option<String> {
    std::fs::read_to_string(ca_cert_path()).ok()
}

/// Generates a small local CA plus a leaf cert signed by it (SAN: tailscale IP,
/// MagicDNS name, localhost), then returns an axum-server rustls config.
///
/// A CA-signed chain matters: with a bare self-signed leaf, iOS refuses to give
/// Web Push to an installed PWA even after the user taps through the browser
/// warning, while a user-installed CA makes the origin properly secure.
pub async fn rustls_config(
    cfg: &AppConfig,
) -> Result<axum_server::tls_rustls::RustlsConfig, String> {
    let cp = cert_path();
    let kp = key_path();
    let ip = cfg
        .tailscale_ip
        .parse::<IpAddr>()
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    let stale = std::fs::read_to_string(cert_ip_marker())
        .map(|s| s.trim() != cfg.tailscale_ip.trim())
        .unwrap_or(true);
    let chain_incomplete = !cp.exists() || !kp.exists() || !ca_cert_path().exists();
    if chain_incomplete || stale {
        // Выпуск цепочки - fs::write, генерация двух ключевых пар и
        // magicdns_name(), который блокирующе спавнит `tailscale status --json`.
        // rustls_config() async (старт узла), поэтому уносим это на blocking-пул
        // вместо того чтобы держать tokio-worker.
        let owned = cfg.clone();
        tokio::task::spawn_blocking(move || ensure_chain(&owned, ip))
            .await
            .map_err(|e| e.to_string())??;
    }
    axum_server::tls_rustls::RustlsConfig::from_pem_file(cp, kp)
        .await
        .map_err(|e| e.to_string())
}

fn ensure_chain(cfg: &AppConfig, ip: IpAddr) -> Result<(), String> {
    if let Some(parent) = cert_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // --- CA: generated once, kept forever (the phone trusts it) ---
    let ca_cert;
    let ca_key;
    // Байты CA, которые кладём в цепочку. При перечитывании CA мы
    // пересобираем сертификат из параметров (rcgen не умеет из PEM в
    // Certificate), и пересобранный DER отличается от исходного. Подпись от
    // этого остаётся валидной - ключ тот же, - но в цепочке телефон должен
    // увидеть ровно тот CA, который он установил, поэтому для chain берём
    // оригинальный PEM с диска.
    let ca_pem_for_chain: String;
    if ca_cert_path().exists() && ca_key_path().exists() {
        let ca_pem = std::fs::read_to_string(ca_cert_path()).map_err(|e| e.to_string())?;
        let ca_key_pem = std::fs::read_to_string(ca_key_path()).map_err(|e| e.to_string())?;
        ca_key = rcgen::KeyPair::from_pem(&ca_key_pem).map_err(|e| e.to_string())?;
        let params = rcgen::CertificateParams::from_ca_cert_pem(&ca_pem)
            .map_err(|e| format!("CA unreadаем ({e}) - удали tls_ca.pem/tls_ca.key.pem для перегенерации"))?;
        ca_cert = params
            .self_signed(&ca_key)
            .map_err(|e| format!("CA не пересобрался ({e}) - удали tls_ca.pem/tls_ca.key.pem"))?;
        ca_pem_for_chain = ca_pem;
    } else {
        let mut ca_params = rcgen::CertificateParams::default();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "dsh-phone local CA");
        ca_params.not_before = rcgen::date_time_ymd(2024, 1, 1);
        ca_params.not_after = rcgen::date_time_ymd(2035, 1, 1);
        ca_params.key_usages.push(rcgen::KeyUsagePurpose::KeyCertSign);
        ca_params.key_usages.push(rcgen::KeyUsagePurpose::CrlSign);
        ca_key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        ca_cert = ca_params
            .self_signed(&ca_key)
            .map_err(|e| e.to_string())?;
        ca_pem_for_chain = ca_cert.pem();
        std::fs::write(ca_cert_path(), &ca_pem_for_chain).map_err(|e| e.to_string())?;
        std::fs::write(ca_key_path(), ca_key.serialize_pem())
            .map_err(|e| e.to_string())?;
        eprintln!("dsh-phone: minted local CA (install tls_ca.pem on the phone once)");
    }

    // --- leaf: signed by the CA, regenerated when the tailnet IP changes ---
    let mut params = rcgen::CertificateParams::default();
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2035, 1, 1);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "dsh-phone");
    params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(IpAddr::V4(
            std::net::Ipv4Addr::LOCALHOST,
        )));
    params.subject_alt_names.push(rcgen::SanType::DnsName(
        rcgen::Ia5String::try_from("localhost").map_err(|e| e.to_string())?,
    ));
    // MagicDNS имя (desktop-xxx.tailNNN.ts.net) - по нему телефон ходит
    // стабильнее, чем по IP, который tailnet может перевыпустить.
    if let Some(dns) = crate::tailscale::magicdns_name() {
        if let Ok(name) = rcgen::Ia5String::try_from(dns.trim_end_matches('.')) {
            params.subject_alt_names.push(rcgen::SanType::DnsName(name));
        }
    }
    let leaf_key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let leaf = params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|e| e.to_string())?;

    // цепочка: leaf + исходный CA (тот самый байт, что стоит на телефоне)
    let chain = format!("{}{}", leaf.pem(), ca_pem_for_chain);
    std::fs::write(cert_path(), chain).map_err(|e| e.to_string())?;
    std::fs::write(key_path(), leaf_key.serialize_pem()).map_err(|e| e.to_string())?;
    std::fs::write(cert_ip_marker(), &cfg.tailscale_ip).map_err(|e| e.to_string())?;
    eprintln!("dsh-phone: minted leaf cert for {ip} (CA-signed)");
    Ok(())
}

/// Кеш отпечатка. cert_sha256() зовётся из status_of() (lib.rs) на каждый
/// поллинг дашборда - раз в 2с - и из серверного /info на каждый запрос
/// телефона, а внутри fs::read + разбор PEM-цепочки + SHA-256. Файл меняется
/// только при (пере)выпуске цепочки, поэтому ключ кеша - mtime и размер.
type ShaCacheEntry = ((std::time::SystemTime, u64), Option<String>);
static SHA_CACHE: std::sync::Mutex<Option<ShaCacheEntry>> = std::sync::Mutex::new(None);

/// SHA-256 of the served leaf certificate DER, for pinning on the device.
pub fn cert_sha256() -> Option<String> {
    let cp = cert_path();
    // файла нет -> и отпечатка нет; кеш не трогаем, следующий вызов после
    // выпуска сертификата увидит новый mtime
    let meta = std::fs::metadata(&cp).ok()?;
    let stamp = (meta.modified().ok()?, meta.len());
    {
        let g = SHA_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached, sha)) = g.as_ref() {
            if *cached == stamp {
                return sha.clone();
            }
        }
    }
    let sha = compute_cert_sha256(&cp);
    *SHA_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((stamp, sha.clone()));
    sha
}

fn compute_cert_sha256(cp: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(cp).ok()?;
    let certs: Vec<_> = rustls_pemfile::certs(&mut &bytes[..])
        .collect::<Result<_, _>>()
        .ok()?;
    let der = certs.first()?;
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(der.as_ref());
    Some(d.iter().map(|b| format!("{b:02x}")).collect())
}
