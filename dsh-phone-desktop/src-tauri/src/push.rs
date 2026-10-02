//! Web Push (RFC 8030/8291/8188 + VAPID) and ntfy notification delivery.
//!
//! One module, three jobs:
//! 1. VAPID P-256 keypair, generated once, stored in config (hex).
//! 2. `aes128gcm` content encryption for push payloads (ECDH + HKDF + AES-GCM).
//! 3. Actual delivery: Web Push POST to the endpoint + ntfy POST to a topic.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes128Gcm, Key, KeyInit, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::rand_core::OsRng;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;

fn b64u() -> base64::engine::GeneralPurpose {
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// SEC1-uncompressed public key matching a secret scalar (via the ecdsa types,
/// which expose reliable conversions).
fn public_key_of(secret: &SecretKey) -> PublicKey {
    let signing = p256::ecdsa::SigningKey::from(secret);
    let point = signing.verifying_key().to_encoded_point(false); // 65B, 0x04 || X || Y
    PublicKey::from_sec1_bytes(point.as_bytes()).expect("derived point is valid")
}

/// VAPID keypair in the wire-friendly form: public = 65-byte SEC1 uncompressed
/// (0x04 || X || Y), private = 32-byte scalar. Both hex in the config file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VapidKeys {
    pub public_hex: String,
    pub private_hex: String,
}

impl VapidKeys {
    pub fn generate() -> Self {
        let secret = SecretKey::random(&mut OsRng);
        let priv_bytes = secret.to_bytes(); // 32 BE bytes
        let public = public_key_of(&secret);
        let pub_bytes = public.to_sec1_bytes(); // 65 bytes, 0x04 prefix
        VapidKeys {
            public_hex: bytes_to_hex(&pub_bytes),
            private_hex: bytes_to_hex(&priv_bytes),
        }
    }

    fn secret_key(&self) -> Option<SecretKey> {
        let raw = hex_to_bytes(&self.private_hex)?;
        let arr: [u8; 32] = raw.as_slice().try_into().ok()?;
        SecretKey::from_bytes(&p256::FieldBytes::from(arr)).ok()
    }

    fn public_bytes(&self) -> Option<Vec<u8>> {
        hex_to_bytes(&self.public_hex)
    }
}

/// One browser push subscription, exactly what the SW hands us.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PushSubscription {
    pub device: String,
    pub endpoint: String,
    /// base64url, 65-byte SEC1 with 0x04 prefix (some browsers send 64 raw)
    pub p256dh: String,
    /// base64url, 16-byte auth secret
    pub auth: String,
    #[serde(default = "crate::gateway::now_ts")]
    pub created_at: f64,
}

/// Notification content as delivered to every channel.
#[derive(Debug, Clone)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub tag: String,
    pub session_id: Option<String>,
}

impl Notice {
    fn json(&self) -> String {
        serde_json::to_string(&json!({
            "title": self.title,
            "body": self.body,
            "tag": self.tag,
            "sessionId": self.session_id,
        }))
        .unwrap_or_else(|_| "{}".into())
    }
}

// ---------------- RFC 8188 aes128gcm content coding ----------------

const RS: u32 = 4096; // record size; one record fits payloads up to RS-18 bytes

/// Derive CEK and NONCE exactly as the reference http_ece/web-push stack does
/// (the de-facto wire format FCM and web.push.apple.com accept):
///   ikm    = HKDF-Extract(auth_secret, dh_secret)
///   secret = HKDF-Expand(ikm, "WebPush: info\0" || client_pub || server_pub, 32)
///   prk    = HKDF-Extract(header_salt, secret)
///   CEK    = HKDF-Expand(prk, "Content-Encoding: aes128gcm\0", 16)
///   NONCE  = HKDF-Expand(prk, "Content-Encoding: nonce\0", 12)
fn derive_keys(
    auth: &[u8],
    ikm: &[u8],
    salt: &[u8],
    client_pub: &[u8],
    server_pub: &[u8],
) -> ([u8; 16], [u8; 12]) {
    let ikm1 = Hkdf::<Sha256>::extract(Some(auth), ikm).0;
    let h1 = Hkdf::<Sha256>::from_prk(ikm1.as_slice()).expect("hkdf ikm");
    let mut info = b"WebPush: info".to_vec();
    info.push(0x00);
    info.extend_from_slice(client_pub);
    info.extend_from_slice(server_pub);
    let mut secret = [0u8; 32];
    h1.expand(&info, &mut secret).expect("hkdf secret");

    let prk = Hkdf::<Sha256>::extract(Some(salt), &secret).0;
    let h = Hkdf::<Sha256>::from_prk(prk.as_slice()).expect("hkdf prk");
    let mut cek = [0u8; 16];
    h.expand(b"Content-Encoding: aes128gcm\0", &mut cek).expect("hkdf cek");
    let mut nonce = [0u8; 12];
    h.expand(b"Content-Encoding: nonce\0", &mut nonce).expect("hkdf nonce");
    (cek, nonce)
}

fn client_public(p256dh_b64: &str) -> Result<PublicKey, String> {
    let raw = b64u()
        .decode(p256dh_b64.as_bytes())
        .map_err(|e| format!("p256dh b64: {e}"))?;
    // Chrome/Android send the 65-byte uncompressed point, iOS Safari too;
    // a 64-byte raw X||Y means the 0x04 prefix was stripped - restore it.
    let full = if raw.len() == 64 {
        let mut v = vec![0x04];
        v.extend_from_slice(&raw);
        v
    } else {
        raw
    };
    PublicKey::from_sec1_bytes(&full).map_err(|e| format!("p256dh point: {e}"))
}

/// Encrypt `payload` for one subscription. Returns the full aes128gcm body
/// (13+65-byte header || ciphertext || 16-byte GCM tag).
pub fn encrypt_payload(
    sub: &PushSubscription,
    payload: &str,
) -> Result<Vec<u8>, String> {
    let auth = b64u()
        .decode(sub.auth.as_bytes())
        .map_err(|e| format!("auth b64: {e}"))?;
    if auth.len() != 16 {
        return Err("auth secret must be 16 bytes".into());
    }
    let client_pub = client_public(&sub.p256dh)?;
    let client_pub_bytes = client_pub.to_sec1_bytes().to_vec();

    let secret = EphemeralSecret::random(&mut OsRng);
    let server_public = secret.public_key();
    let server_pub_bytes = server_public.to_sec1_bytes().to_vec();
    let shared = secret.diffie_hellman(&client_pub);
    let ikm = shared.raw_secret_bytes();

    // Random 16-byte header salt (RFC 8291 §2: salt feeds the second HKDF extract).
    let mut salt = [0u8; 16];
    use p256::elliptic_curve::rand_core::RngCore;
    OsRng.fill_bytes(&mut salt);

    let (cek, nonce) = derive_keys(&auth, ikm, &salt, &client_pub_bytes, &server_pub_bytes);

    // RFC 8188: plaintext || last-record delimiter 0x02, then AES-GCM.
    // One record keeps us well under RS-18 for notification-sized payloads.
    let mut plaintext = payload.as_bytes().to_vec();
    if plaintext.len() + 1 > (RS as usize) - 18 {
        plaintext.truncate((RS as usize) - 18 - 1);
    }
    plaintext.push(0x02);

    let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: &[] })
        .map_err(|_| "aes-gcm encrypt".to_string())?;

    let mut out = Vec::with_capacity(17 + server_pub_bytes.len() + ciphertext.len());
    // header: salt(16) || rs(4, big endian) || idlen(1) || server key
    out.extend_from_slice(&salt);
    out.extend_from_slice(&RS.to_be_bytes());
    out.push(server_pub_bytes.len() as u8);
    out.extend_from_slice(&server_pub_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decode an aes128gcm body back to plaintext, given the receiver's keypair.
/// Inverse of `encrypt_payload` - used by unit tests to verify the wire format.
#[cfg(test)]
pub fn decrypt_payload(
    receiver_priv_hex: &str,
    auth_hex: &str,
    body: &[u8],
) -> Result<String, String> {
    let auth = hex_to_bytes(auth_hex).ok_or("bad auth hex")?;
    if body.len() < 18 {
        return Err("short body".into());
    }
    let salt = body[0..16].to_vec();
    let _rs = u32::from_be_bytes([body[16], body[17], body[18], body[19]]);
    let idlen = body[20] as usize;
    let server_pub_bytes = &body[21..21 + idlen];
    let ciphertext = &body[21 + idlen..];
    let server_pub = PublicKey::from_sec1_bytes(server_pub_bytes).map_err(|e| e.to_string())?;

    let raw = hex_to_bytes(receiver_priv_hex).ok_or("bad priv hex")?;
    let arr: [u8; 32] = raw.as_slice().try_into().map_err(|_| "priv len")?;
    let secret = p256::SecretKey::from_bytes(&p256::FieldBytes::from(arr)).map_err(|e| e.to_string())?;
    // Static-key ECDH: the receiver side of RFC 8291.
    let scalar = secret.to_nonzero_scalar();
    let shared = p256::elliptic_curve::ecdh::diffie_hellman(scalar, *server_pub.as_affine());
    let ikm = shared.raw_secret_bytes().to_vec();

    let client_public = public_key_of(&secret);
    let client_pub_bytes = client_public.to_sec1_bytes().to_vec();
    let (cek, nonce) = derive_keys(&auth, &ikm, &salt, &client_pub_bytes, server_pub_bytes);

    let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: ciphertext, aad: &[] })
        .map_err(|_| "aes-gcm decrypt".to_string())?;
    if plain.last() != Some(&0x02) {
        return Err("missing delimiter".into());
    }
    Ok(String::from_utf8_lossy(&plain[..plain.len() - 1]).to_string())
}

// ---------------- VAPID Authorization ----------------

fn b64u_encode(data: &[u8]) -> String {
    b64u().encode(data)
}

fn origin_of(endpoint: &str) -> Option<String> {
    let (scheme, rest) = endpoint.split_once("://")?;
    let host = rest.split('/').next()?;
    Some(format!("{scheme}://{host}"))
}

/// Build the `Authorization: vapid t=<jwt>, k=<b64url pub>` header value.
fn vapid_auth_header(vapid: &VapidKeys, endpoint: &str) -> Result<String, String> {
    let aud = origin_of(endpoint).ok_or_else(|| "bad endpoint".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let header = json!({"typ": "JWT", "alg": "ES256"});
    let claims = json!({
        "aud": aud,
        "exp": now + 12 * 3600,
        "sub": "mailto:dsh-phone@local",
    });
    let signing_input = format!(
        "{}.{}",
        b64u_encode(header.to_string().as_bytes()),
        b64u_encode(claims.to_string().as_bytes())
    );
    let secret = vapid.secret_key().ok_or("bad vapid private key")?;
    let signing = SigningKey::from(&secret);
    let sig: Signature = signing.sign(signing_input.as_bytes());
    let sig_bytes = sig.to_bytes(); // r||s, 64 bytes - the JOSE raw form
    let jwt = format!("{}.{}", signing_input, b64u_encode(&sig_bytes));
    let pub_bytes = vapid.public_bytes().ok_or("bad vapid public key")?;
    Ok(format!("vapid t={}, k={}", jwt, b64u_encode(&pub_bytes)))
}

// ---------------- delivery ----------------

/// Guards load-mutate-save cycles on config.json (phone HTTP + dashboard IPC
/// can race; notifications are rare, so a coarse file lock is plenty).
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Notification router. Stateless: every operation re-reads config.json under
/// the lock, so subscriptions added by the phone and ntfy toggles set in the
/// dashboard are visible immediately, with no shared in-memory state to drift.
#[derive(Clone, Default)]
pub struct PushRouter;

impl PushRouter {
    pub fn new() -> Self {
        PushRouter
    }

    /// Fire a notification to every enabled channel. Errors are logged, never fatal.
    pub fn dispatch(&self, notice: &Notice) {
        let notice = notice.clone();
        tauri::async_runtime::spawn(async move {
            let (subs, ntfy, vapid) = {
                let _g = CONFIG_LOCK.lock().unwrap();
                let c = crate::config::AppConfig::load_or_init();
                (
                    c.push_subscriptions.clone(),
                    (
                        c.ntfy_enabled,
                        c.ntfy_url.clone().unwrap_or_default(),
                        c.ntfy_topic.clone().unwrap_or_default(),
                        c.ntfy_token.clone(),
                    ),
                    c.vapid_keys.clone(),
                )
            };
            if let Some(vapid) = vapid {
                if !subs.is_empty() {
                    let client = match reqwest_client() {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("dsh-phone: webpush client: {e}");
                            return;
                        }
                    };
                    let router = PushRouter;
                    for sub in &subs {
                        if let Err(e) = web_push_send(&vapid, sub, &client, &router, &notice).await {
                            eprintln!("dsh-phone: webpush to {} failed: {e}", sub.device);
                        }
                    }
                }
            }
            let (on, url, topic, token) = ntfy;
            if on && !topic.is_empty() {
                if let Err(e) = ntfy_send(&url, &topic, token.as_deref(), &notice).await {
                    eprintln!("dsh-phone: ntfy failed: {e}");
                }
            }
        });
    }

    pub fn remove_subscription(&self, endpoint: &str) {
        let _g = CONFIG_LOCK.lock().unwrap();
        let mut c = crate::config::AppConfig::load_or_init();
        let before = c.push_subscriptions.len();
        c.push_subscriptions.retain(|s| s.endpoint != endpoint);
        if c.push_subscriptions.len() != before {
            let _ = c.save();
        }
    }

    pub fn add_subscription(&self, sub: PushSubscription) {
        let _g = CONFIG_LOCK.lock().unwrap();
        let mut c = crate::config::AppConfig::load_or_init();
        c.push_subscriptions.retain(|s| s.endpoint != sub.endpoint);
        c.push_subscriptions.push(sub);
        let _ = c.save();
    }

    pub fn clear_subscriptions(&self) {
        let _g = CONFIG_LOCK.lock().unwrap();
        let mut c = crate::config::AppConfig::load_or_init();
        c.push_subscriptions.clear();
        let _ = c.save();
    }

    pub fn subscriptions_snapshot(&self) -> Vec<PushSubscription> {
        let _g = CONFIG_LOCK.lock().unwrap();
        crate::config::AppConfig::load_or_init().push_subscriptions
    }
}

fn reqwest_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

async fn web_push_send(
    vapid: &VapidKeys,
    sub: &PushSubscription,
    client: &reqwest::Client,
    router: &PushRouter,
    notice: &Notice,
) -> Result<(), String> {
    let body = encrypt_payload(sub, &notice.json())?;
    let auth = vapid_auth_header(vapid, &sub.endpoint)?;
    let ttl = if notice.session_id.is_some() { 3600u64 } else { 600 };
    let urgency = if notice.title.contains("ответ") { "high" } else { "normal" };
    let resp = client
        .post(&sub.endpoint)
        .header("TTL", ttl.to_string())
        .header("Urgency", urgency)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", auth)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    // 404/410 = subscription is gone: prune it from the config.
    if status.as_u16() == 404 || status.as_u16() == 410 {
        router.remove_subscription(&sub.endpoint);
        return Ok(());
    }
    if !status.is_success() {
        return Err(format!("endpoint returned {status}"));
    }
    Ok(())
}

pub async fn ntfy_send(
    url: &str,
    topic: &str,
    token: Option<&str>,
    notice: &Notice,
) -> Result<(), String> {
    let base = if url.is_empty() { "https://ntfy.sh" } else { url };
    let base = base.trim_end_matches('/');
    let endpoint = format!("{base}/{topic}");
    let mut req = reqwest::Client::new()
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(20))
        .json(&json!({
            "title": notice.title,
            "message": notice.body,
            "tags": ["speech_balloon"],
        }));
    if let Some(t) = token {
        // Basic auth with token as password (ntfy's scheme: username can be empty).
        req = req.header("Authorization", format!("Basic {}", b64_std(format!(":{t}"))));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("ntfy returned {status}"));
    }
    Ok(())
}

fn b64_std(s: String) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_sub(pub_hex: &str, auth_hex: &str) -> (VapidKeys, PushSubscription) {
        let vapid = VapidKeys::generate();
        let secret = vapid.secret_key().unwrap();
        let client_pub = public_key_of(&secret);
        let p256dh = b64u_encode(&client_pub.to_sec1_bytes());
        let auth = b64u_encode(&[7u8; 16]);
        let _ = (pub_hex, auth_hex);
        (
            vapid,
            PushSubscription {
                device: "test".into(),
                endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
                p256dh,
                auth,
                created_at: 0.0,
            },
        )
    }

    #[test]
    fn roundtrip() {
        // Receiver == VAPID owner (a real subscription belongs to the phone,
        // but for the roundtrip any P-256 pair works).
        let (vapid, sub) = fake_sub("", "");
        let receiver_priv_hex = vapid.private_hex.clone();
        let auth = b64u().decode(sub.auth.as_bytes()).unwrap();
        let auth_hex = bytes_to_hex(&auth);
        let payload = r#"{"title":"Ход завершён","body":"мост жив"}"#;
        let body = encrypt_payload(&sub, payload).unwrap();
        let back = decrypt_payload(&receiver_priv_hex, &auth_hex, &body).unwrap();
        assert_eq!(back, payload);
    }

    #[test]
    fn vapid_header_shape() {
        let (vapid, _) = fake_sub("", "");
        let h = vapid_auth_header(&vapid, "https://fcm.googleapis.com/fcm/send/abc").unwrap();
        assert!(h.starts_with("vapid t="));
        assert!(h.contains(", k="));
        let jwt = h.trim_start_matches("vapid t=").split(',').next().unwrap().trim_end_matches(',');
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "jwt must have 3 parts");
        let claims_b = b64u().decode(parts[1].as_bytes()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&claims_b).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:dsh-phone@local");
    }

    #[test]
    fn header_layout() {
        let (_, sub) = fake_sub("", "");
        let body = encrypt_payload(&sub, "x").unwrap();
        assert_eq!(&body[16..20], &4096u32.to_be_bytes(), "rs field");
        assert_eq!(body[20], 65, "idlen = 65");
        assert_eq!(body[21], 0x04, "uncompressed point prefix");
        assert_eq!(body.len(), 21 + 65 + 2 + 16, "ciphertext + tag"); // 'x' + 0x02 delimiter
    }

    /// Wire-format interop with the reference node web-push library (the thing
    /// real backends use). Direction 1: web-push encrypts, our decryptor reads
    /// it back. Direction 2: we encrypt, node's TLS-grade crypto decrypts.
    /// Skipped silently when node or the module is not around.
    #[test]
    fn node_interop() {
        let node = std::env::var("DSH_NODE_EXE").unwrap_or_else(|_| "node".to_string());
        let script = format!("{}\\tests\\interop_webpush.cjs", env!("CARGO_MANIFEST_DIR"));
        let wp = std::env::var("DSH_WP_INTEROP_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("wp-interop"));
        if !std::path::Path::new(&script).exists() || !wp.join("node_modules").exists() {
            eprintln!("node interop skipped: script/web-push module not present");
            return;
        }

        // ---- direction 1: reference library encrypts ----
        let out = std::process::Command::new(&node)
            .arg(&script)
            .arg("reference")
            .env("NODE_PATH", wp.join("node_modules"))
            .output()
            .expect("spawn node");
        assert!(
            out.status.success(),
            "node reference failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let j: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let payload = j["payload"].as_str().unwrap().to_string();
        let body_b64 = j["bodyB64"].as_str().unwrap();
        let vapid_auth = j["vapidAuth"].as_str().unwrap_or("");
        let encoding = j["contentEncoding"].as_str().unwrap_or("");
        assert_eq!(encoding, "aes128gcm", "reference lib must use aes128gcm");
        assert!(vapid_auth.starts_with("vapid t="), "reference vapid header shape");
        let body = base64::engine::general_purpose::STANDARD
            .decode(body_b64.as_bytes())
            .expect("body b64");
        let back = decrypt_payload(
            j["privHex"].as_str().unwrap(),
            j["authHex"].as_str().unwrap(),
            &body,
        )
        .expect("decrypt reference body");
        assert_eq!(back, payload, "reference payload must roundtrip through our decoder");

        // ---- direction 2: our encryptor, node decrypts ----
        let vapid = VapidKeys::generate();
        let receiver = vapid.secret_key().unwrap();
        let client_pub = public_key_of(&receiver);
        let sub = PushSubscription {
            device: "node-interop".into(),
            endpoint: "https://fcm.googleapis.com/fcm/send/interop".into(),
            p256dh: b64u_encode(&client_pub.to_sec1_bytes()),
            auth: b64u_encode(&[9u8; 16]),
            created_at: 0.0,
        };
        let our_payload = r#"{"title":"Нужен твой ответ","body":"интероп"}"#;
        let body = encrypt_payload(&sub, our_payload).unwrap();
        let input = serde_json::json!({
            "privHex": vapid.private_hex,
            "authHex": bytes_to_hex(&[9u8; 16]),
            "bodyB64": base64::engine::general_purpose::STANDARD.encode(&body),
        });
        use std::io::Write;
        let mut child = std::process::Command::new(&node)
            .arg(&script)
            .arg("decrypt")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .expect("spawn node decrypt");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "node decrypt failed");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            our_payload,
            "node must read our aes128gcm body"
        );
    }
}
