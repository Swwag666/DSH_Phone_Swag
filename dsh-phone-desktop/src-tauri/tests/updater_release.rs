//! Контракт автообновления: конфиг updater в tauri.conf.json и подпись
//! собранного артефакта.
//!
//! Зачем это вынесено в тесты: самая дорогая ошибка в автообновлении -
//! публичный ключ в конфиге не совпадает с приватным, которым подписан релиз.
//! Ни сборка, ни тесты узла её не показывают, а у пользователей она выглядит
//! как «обновление скачалось и не ставится». Ловим до публикации.
//!
//! Тесты на артефакты сами скипаются, если бандл ещё не собран: они проверяют
//! реальную подпись, а не мок, поэтому им нужен настоящий setup.exe + .sig
//! ( scripts\build-release.cmd -Sign ).

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn conf() -> serde_json::Value {
    let p = manifest_dir().join("tauri.conf.json");
    let raw =
        fs::read_to_string(&p).unwrap_or_else(|e| panic!("не прочитал {}: {e}", p.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("tauri.conf.json не парсится: {e}"))
}

fn updater_conf() -> serde_json::Value {
    conf()
        .pointer("/plugins/updater")
        .cloned()
        .expect("в tauri.conf.json нет plugins.updater")
}

fn nsis_dir() -> PathBuf {
    manifest_dir().join("target/release/bundle/nsis")
}

/// Самый свежий установщик и его подпись. None, если бандла нет.
fn newest_artifact() -> Option<(PathBuf, PathBuf)> {
    let dir = nsis_dir();
    let entries = fs::read_dir(&dir).ok()?;
    let mut setups: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.to_string_lossy().ends_with("-setup.exe"))
        .collect();
    setups.sort_by_key(|p| {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    let setup = setups.pop()?;
    let sig = PathBuf::from(format!("{}.sig", setup.display()));
    Some((setup, sig))
}

/// .sig от tauri - это base64 от четырёхстрочной minisign-подписи.
fn decode_sig(p: &Path) -> Signature {
    let b64 = fs::read_to_string(p).unwrap_or_else(|e| panic!("не прочитал {}: {e}", p.display()));
    decode_signature_b64(b64.trim())
}

/// Ровно тот путь, которым идёт tauri-plugin-updater в verify_signature():
/// base64 -> строка -> Signature::decode. Важно не перепутать с
/// PublicKey::from_base64, который ждёт «голые» 42 байта ключа.
fn decode_signature_b64(b64: &str) -> Signature {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .expect("подпись не base64");
    let text = String::from_utf8(bytes).expect("подпись не utf-8");
    Signature::decode(&text).expect("подпись не является minisign-подписью")
}

/// Публичный ключ из tauri.conf.json тем же способом, что и updater:
/// base64 -> текст minisign-ключа -> PublicKey::decode.
fn config_pubkey() -> PublicKey {
    let u = updater_conf();
    let b64 = u["pubkey"].as_str().expect("pubkey обязателен");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .expect("pubkey не base64");
    let text = String::from_utf8(bytes).expect("pubkey не utf-8");
    PublicKey::decode(&text).expect("pubkey не является minisign-ключом")
}

fn skip(why: &str) {
    eprintln!("SKIP: {why}");
}

#[test]
fn updater_artifacts_are_enabled() {
    // без этого bundler не создаёт .sig и автообновлению нечего проверять
    let c = conf();
    let v = c
        .pointer("/bundle/createUpdaterArtifacts")
        .expect("нет bundle.createUpdaterArtifacts");
    assert_eq!(v.as_bool(), Some(true), "bundler не подпишет апдейтер");
}

#[test]
fn endpoint_is_https_and_points_at_the_repo_releases() {
    let u = updater_conf();
    let eps = u["endpoints"]
        .as_array()
        .expect("endpoints должен быть списком");
    assert!(!eps.is_empty(), "без endpoint автообновление мертво");
    for e in eps {
        let s = e.as_str().expect("endpoint - строка");
        // плагин сам отвергает не-https, но лучше узнать об этом в тесте
        assert!(s.starts_with("https://"), "updater откажется от не-https: {s}");
        assert!(s.contains("/releases/"), "endpoint мимо релизов: {s}");
        assert!(
            s.ends_with("latest.json"),
            "ожидали .../latest/download/latest.json, получили {s}"
        );
    }
}

#[test]
fn pubkey_is_a_valid_minisign_key() {
    let u = updater_conf();
    let pk = u["pubkey"]
        .as_str()
        .expect("pubkey обязателен - без него updater не соберётся");
    assert!(pk.len() > 50, "pubkey подозрительно короткий: {}", pk.len());
    // тот же путь декодирования, что у updater: если он не сходится, обновление
    // не поставится ни у кого
    config_pubkey();
}

#[test]
fn downgrades_stay_blocked() {
    // allowDowngrades снимает единственную защиту от установки старой, но
    // валидно подписанной версии. Если её включат намеренно - тест надо
    // обновить осознанно, а не случайно.
    assert_ne!(
        updater_conf().get("allowDowngrades").and_then(|v| v.as_bool()),
        Some(true),
        "allowDowngrades разрешает откат на старую подписанную версию"
    );
}

#[test]
fn signed_artifact_verifies_against_the_configured_pubkey() {
    let Some((setup, sigp)) = newest_artifact() else {
        skip(&format!(
            "бандл не собран ({}); запусти scripts\\build-release.cmd -Sign",
            nsis_dir().display()
        ));
        return;
    };
    if !sigp.exists() {
        skip(&format!(
            "{} без .sig - сборка не подписана (нужен -Sign)",
            setup.display()
        ));
        return;
    }

    let pk = config_pubkey();
    let sig = decode_sig(&sigp);
    let bytes = fs::read(&setup).expect("артефакт читается");

    // allow_legacy=false: tauri подписывает в prehashed-режиме, и только он
    // считается безопасным
    pk.verify(&bytes, &sig, false).unwrap_or_else(|e| {
        panic!(
            "подпись не сошлась: {} не соответствует pubkey из tauri.conf.json ({e}). \
             Автообновление такой релиз отвергнет.",
            setup.display()
        )
    });
}

#[test]
fn signature_carries_the_version_required_by_config() {
    // requireSignedVersion=true отвергает подписи без версии в trusted comment:
    // без неё злоумышленник может подсунуть старый, но валидно подписанный
    // артефакт под новым номером версии. Если CLI перестанет писать версию,
    // обновления сломаются у всех сразу - проверяем на своём же артефакте.
    if updater_conf()
        .get("requireSignedVersion")
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        skip("requireSignedVersion выключен - версия в подписи не обязательна");
        return;
    }
    let Some((setup, sigp)) = newest_artifact() else {
        skip("бандл не собран");
        return;
    };
    if !sigp.exists() {
        skip("сборка не подписана");
        return;
    }

    let sig = decode_sig(&sigp);
    let tc = sig.trusted_comment().to_string();
    let c = conf();
    let version = c["version"].as_str().expect("нет version в конфиге");

    assert!(
        tc.contains(&format!("version:{version}")),
        "в trusted comment нет version:{version} - requireSignedVersion отвергнет \
         такое обновление. comment: {tc}"
    );
    let name = setup.file_name().unwrap().to_string_lossy().to_string();
    assert!(
        tc.contains(&name),
        "подпись относится к другому файлу: {tc}"
    );
}

#[test]
fn local_latest_json_has_the_shape_the_updater_expects() {
    // releases/latest.example.json генерит build-release.ps1 для локальной
    // проверки. В CI его заменяет latest.json от tauri-action, но форма обязана
    // совпадать, иначе локальная проверка врала бы про рабочий сценарий.
    let p = manifest_dir().join("../../releases/latest.example.json");
    let Ok(raw) = fs::read_to_string(&p) else {
        skip("нет releases/latest.example.json (собери с -Latest)");
        return;
    };
    let j: serde_json::Value =
        serde_json::from_str(&raw).expect("releases/latest.example.json не парсится");

    assert_eq!(
        j["version"].as_str(),
        conf()["version"].as_str(),
        "версия в манифесте не совпадает с tauri.conf.json"
    );
    let plat = &j["platforms"]["windows-x86_64"];
    let url = plat["url"].as_str().expect("нет platforms.windows-x86_64.url");
    assert!(url.starts_with("https://"), "url манифеста не https: {url}");

    let sigb64 = plat["signature"].as_str().expect("нет signature в манифесте");
    decode_signature_b64(sigb64);
}
