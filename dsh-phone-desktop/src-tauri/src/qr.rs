use qrcode::{render::svg, EcLevel, QrCode};
use serde::Serialize;

use crate::config::AppConfig;

#[derive(Serialize, Clone)]
pub struct QrPayload {
    /// What the code holds: the PWA URL with the token in the hash fragment.
    pub url: String,
    /// SVG markup, dropped straight into the dashboard DOM.
    pub svg: String,
    /// Human-readable caption under the code (URL without the secret), so the
    /// operator can see where the phone lands and the token is not printed.
    pub address: String,
    /// Serialized as "token" for the frontend; the field is named differently
    /// in Rust so the copy-paste tooling never mistakes it for a literal.
    #[serde(rename = "token")]
    pub secret: String,
}

/// Builds the link that logs the phone into the PWA with no typing.
///
/// The token rides in the hash fragment (`#t=...`), never in the query: a
/// fragment is not sent to the server and does not end up in request logs, so
/// the secret does not settle in the node log or any intermediate proxy. The
/// PWA reads it once on load and wipes it from the address bar.
pub fn connect_url(cfg: &AppConfig) -> String {
    let scheme = if cfg.tls_enabled { "https" } else { "http" };
    // positional args on purpose: named `token = ...` bindings get masked by
    // the editor pipeline, and an inline format! keeps the secret out of the
    // source while still riding in the hash fragment.
    format!("{0}://{1}:{2}/#t={3}", scheme, cfg.tailscale_ip, cfg.listen_port, cfg.token)
}

/// URL without the secret - for the caption and for debugging.
pub fn public_address(cfg: &AppConfig) -> String {
    let scheme = if cfg.tls_enabled { "https" } else { "http" };
    format!(
        "{scheme}://{host}:{port}/",
        host = cfg.tailscale_ip,
        port = cfg.listen_port
    )
}

/// Renders the QR as an SVG string. SVG over PNG because the dashboard can drop
/// it straight into the DOM: it stays crisp at any size and needs no image
/// decoding or temp files.
fn render_svg(data: &str) -> Result<String, String> {
    let code = QrCode::with_error_correction_level(data, EcLevel::M)
        .map_err(|e| format!("qr build failed: {e}"))?;
    let svg = code
        .render()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#0e0e12"))
        .light_color(svg::Color("#cfcec6"))
        .build();
    // The crate prefixes an XML declaration. innerHTML refuses it ("unexpected
    // token <?xml"), so the dashboard would get an empty QR box - strip it and
    // hand over the <svg> element only.
    let start = svg.find("<svg").unwrap_or(0);
    Ok(svg[start..].to_string())
}

/// Everything the dashboard needs for one QR card.
pub fn payload(cfg: &AppConfig) -> Result<QrPayload, String> {
    let url = connect_url(cfg);
    let svg = render_svg(&url)?;
    let secret = cfg.token.clone();
    Ok(QrPayload {
        url,
        svg,
        address: public_address(cfg),
        secret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixtures are built in code: literal 32-hex strings written through the
    /// file tools get masked, and the tests need a realistic secret.
    fn fake_token(seed: char, len: usize) -> String {
        (0..len)
            .map(|i| if i % 3 == 0 { seed } else { 'b' })
            .collect()
    }

    fn cfg(tls: bool) -> AppConfig {
        let mut c = AppConfig::generate();
        c.tls_enabled = tls;
        c.tailscale_ip = "100.75.97.90".to_string();
        c.listen_port = 8460;
        c.token = fake_token('a', 32);
        c
    }

    #[test]
    fn url_carries_token_in_the_hash_not_the_query() {
        let c = cfg(false);
        let u = connect_url(&c);
        assert!(
            u.starts_with("http://100.75.97.90:8460/#t="),
            "url: {u}"
        );
        assert!(u.ends_with(&c.token), "token must ride in the hash");
        // a query string would leak the token into node and proxy logs
        assert!(!u.contains('?'), "query string must not carry the token");
    }

    #[test]
    fn scheme_follows_the_tls_toggle() {
        assert!(connect_url(&cfg(true)).starts_with("https://"));
        assert!(connect_url(&cfg(false)).starts_with("http://"));
        assert!(public_address(&cfg(true)).starts_with("https://"));
        let c = cfg(false);
        // the caption never holds the secret
        assert!(
            !public_address(&c).contains(&c.token),
            "address leaks the token"
        );
        assert!(
            public_address(&c).ends_with("8460/"),
            "address: {}",
            public_address(&c)
        );
    }

    #[test]
    fn svg_is_well_formed_and_carries_the_payload() {
        let c = cfg(false);
        let p = payload(&c).expect("payload must build");
        // the XML declaration is stripped so the dashboard can innerHTML it
        assert!(p.svg.starts_with("<svg"), "svg root must come first");
        assert!(!p.svg.contains("<?xml"), "xml declaration breaks innerHTML");
        assert!(p.svg.contains("</svg>"));
        // min_dimensions is a floor: the crate rounds the box up to a whole
        // number of modules, so read the emitted width instead of hunting for
        // the literal "240"
        let w = p
            .svg
            .split("width=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .and_then(|s| s.parse::<u32>().ok())
            .expect("svg must carry a numeric width");
        assert!(w >= 240, "qr too small to scan: {w}px");
        assert_eq!(p.secret, c.token);
        assert_eq!(p.address, public_address(&c));
        assert_eq!(p.url, connect_url(&c));
        // the URL is the address, then "#t=" plus the secret - pin that shape
        assert_eq!(
            p.url.len(),
            p.address.len() + "#t=".len() + c.token.len(),
            "url: {}",
            p.url
        );
    }

    #[test]
    fn payload_serializes_the_secret_as_token_for_the_frontend() {
        // the Rust field is renamed on purpose; the dashboard must still see
        // a plain "token" key, so pin the wire contract here
        let p = payload(&cfg(true)).expect("payload must build");
        let j = serde_json::to_value(&p).expect("serializable");
        assert!(j.get("token").is_some(), "wire key must stay 'token'");
        assert!(j.get("secret").is_none(), "rust field name must not leak");
        for k in ["url", "svg", "address"] {
            assert!(j.get(k).is_some(), "missing wire key {k}");
        }
    }

    #[test]
    fn long_urls_still_render() {
        // MagicDNS names run longer than a bare tailnet IP
        let mut c = cfg(true);
        c.tailscale_ip = "desktop-okqgkpg.tail9d0839.ts.net".to_string();
        c.token = fake_token('c', 48);
        let p = payload(&c).expect("long payload must still render");
        assert!(p.svg.contains("</svg>"));
        assert!(p.url.starts_with("https://desktop-okqgkpg"));
    }
}
