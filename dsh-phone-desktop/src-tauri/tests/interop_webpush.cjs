// Interop test helper: two directions, run by cargo test (push.rs ::node_interop).
//
//   node interop_webpush.js reference   -> reference web-push lib encrypts a
//                                          payload; prints JSON {privHex,
//                                          authHex, bodyB64, payload} for the
//                                          Rust decryptor.
//   node interop_webpush.js decrypt     -> reads the same JSON from stdin but
//                                          with a body produced by OUR Rust
//                                          encrypt_payload; prints plaintext.
//
// Direction 2 validates our RFC 8291/8188 bytes against node's TLS-grade
// crypto (ECDH + HKDF + AES-128-GCM) without any third-party library.

const crypto = require("crypto");
const fs = require("fs");

function hkdfExtract(salt, ikm) {
  return crypto.createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk, info, len) {
  let okm = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  let i = 1;
  while (okm.length < len) {
    t = crypto.createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i++])])).digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.slice(0, len);
}

// De-facto derivation (http_ece): ikm = Extract(auth, Z);
// secret = Expand(ikm, "WebPush: info\0" || clientPub || serverPub, 32);
// prk = Extract(header_salt, secret); CEK/nonce = Expand(prk, "Content-Encoding: ...").
function decryptAes128gcm(privHex, authHex, body) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privHex, "hex"));
  const clientPub = ecdh.getPublicKey(); // 65 bytes uncompressed
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const serverPub = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const Z = ecdh.computeSecret(serverPub);
  const auth = Buffer.from(authHex, "hex");
  const ikm = hkdfExtract(auth, Z);
  const secret = hkdfExpand(
    ikm,
    Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0]), clientPub, serverPub]),
    32
  );
  const prk = hkdfExtract(salt, secret);
  const cek = hkdfExpand(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0])]), 16);
  const nonce = hkdfExpand(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0])]), 12);
  const tag = ciphertext.slice(ciphertext.length - 16);
  const data = ciphertext.slice(0, ciphertext.length - 16);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(data), d.final()]);
  if (plain[plain.length - 1] !== 0x02) throw new Error("missing delimiter");
  return plain.slice(0, plain.length - 1).toString("utf8");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "reference") {
    const https = require("https");
    const webpush = require("web-push");
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    // getPrivateKey("hex") не дополняет ведущие нули: если скаляр начинается с
    // 0x00, строка короче 64 символов и Rust-декодер падает с "priv len".
    // Приводим к фиксированным 32 байтам.
    const privHex = ecdh.getPrivateKey("hex").padStart(64, "0");
    const authBuf = crypto.randomBytes(16);
    const payload = JSON.stringify({ title: "Работа завершена", body: "интероп-тест" });
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/interop-test",
      keys: { p256dh: ecdh.getPublicKey("base64"), auth: authBuf.toString("base64") },
    };

    // web-push always goes through https.request - shim it instead of running
    // a TLS server: capture headers + body, then fake a 201 response back.
    const captured = { headers: {}, body: Buffer.alloc(0) };
    https.request = function (options, cb) {
      const EventEmitter = require("events");
      const req = new EventEmitter();
      req.setNoDelay = () => req;
      req.setSocketKeepAlive = () => req;
      req.setTimeout = () => req;
      req.destroy = () => {};
      req.write = (chunk) => {
        if (chunk) captured.body = Buffer.concat([captured.body, Buffer.from(chunk)]);
      };
      req.end = (chunk) => {
        if (chunk) req.write(chunk);
        const hdrs = (options && options.headers) || {};
        captured.headers = Object.fromEntries(
          Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : String(v)])
        );
        const res = new EventEmitter();
        res.statusCode = 201;
        res.headers = {};
        setImmediate(() => {
          cb && cb(res);
          res.emit("data", Buffer.alloc(0));
          res.emit("end");
        });
      };
      return req;
    };

    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    webpush.setVapidDetails("mailto:test@dsh-phone.local", publicKey, privateKey);
    await webpush.sendNotification(sub, payload, { TTL: 60 });

    const result = {
      privHex,
      authHex: authBuf.toString("hex"),
      bodyB64: captured.body.toString("base64"),
      vapidAuth: captured.headers["authorization"] || "",
      contentEncoding: captured.headers["content-encoding"] || "",
      payload,
    };
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (mode === "decrypt") {
    const input = fs.readFileSync(0, "utf8");
    const j = JSON.parse(input);
    const body = Buffer.from(j.bodyB64, "base64");
    const plain = decryptAes128gcm(j.privHex, j.authHex, body);
    process.stdout.write(plain);
    return;
  }
  process.stderr.write("usage: interop_webpush.cjs reference|decrypt\n");
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
