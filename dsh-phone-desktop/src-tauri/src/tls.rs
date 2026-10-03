use std::net::IpAddr;
use std::path::Path;

use crate::config::{config_dir, AppConfig};

fn cert_path() -> std::path::PathBuf {
    config_dir().join("tls_cert.pem")
}

fn key_path() -> std::path::PathBuf {
    config_dir().join("tls_key.pem")
}

/// Records which tailscale IP the cert was minted for. The IP is not stable
/// (tailnet reissues happen), and a cert whose SAN no longer matches makes every
/// browser refuse the connection - so we regenerate on mismatch instead of
/// serving a stale cert forever.
fn cert_ip_marker() -> std::path::PathBuf {
    config_dir().join("tls_cert.ip")
}

/// Generates the self-signed cert (with the tailscale IP in the SAN) if it is
/// missing or stale, then returns an axum-server rustls config for `bind_rustls`.
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
    if !cp.exists() || !kp.exists() || stale {
        generate(&cp, &kp, ip, &cfg.tailscale_ip)?;
    }
    axum_server::tls_rustls::RustlsConfig::from_pem_file(cp, kp)
        .await
        .map_err(|e| e.to_string())
}

fn generate(cp: &Path, kp: &Path, ip: IpAddr, marker: &str) -> Result<(), String> {
    let mut params = rcgen::CertificateParams::default();
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2035, 1, 1);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "dsh-phone");
    params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
    // Loopback too, so the node can be smoke-tested over https locally.
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(IpAddr::V4(
            std::net::Ipv4Addr::LOCALHOST,
        )));
    params.subject_alt_names.push(rcgen::SanType::DnsName(
        rcgen::Ia5String::try_from("localhost").map_err(|e| e.to_string())?,
    ));
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    if let Some(parent) = cp.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(cp, cert.pem()).map_err(|e| e.to_string())?;
    std::fs::write(kp, key.serialize_pem()).map_err(|e| e.to_string())?;
    std::fs::write(cert_ip_marker(), marker).map_err(|e| e.to_string())?;
    eprintln!("dsh-phone: minted self-signed cert for {ip}");
    Ok(())
}

/// SHA-256 of the served certificate DER, for pinning on the device.
pub fn cert_sha256() -> Option<String> {
    let cp = cert_path();
    if !cp.exists() {
        return None;
    }
    let bytes = std::fs::read(cp).ok()?;
    let certs: Vec<_> = rustls_pemfile::certs(&mut &bytes[..])
        .collect::<Result<_, _>>()
        .ok()?;
    let der = certs.first()?;
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(der.as_ref());
    Some(d.iter().map(|b| format!("{b:02x}")).collect())
}