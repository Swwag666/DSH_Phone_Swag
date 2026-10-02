// Embedded phone PWA assets. These come from the sibling `dsh-phone/web` tree so
// the exe ships the exact same PWA the Python gateway used to serve - one canonical
// client, baked straight into the binary at compile time.
pub const INDEX_HTML: &str = include_str!("../../../dsh-phone/web/index.html");
pub const MD_JS: &str = include_str!("../../../dsh-phone/web/md.js");
pub const APP_JS: &str = include_str!("../../../dsh-phone/web/app.js");
pub const STYLE_CSS: &str = include_str!("../../../dsh-phone/web/style.css");
pub const MANIFEST: &str = include_str!("../../../dsh-phone/web/manifest.json");
pub const SW_JS: &str = include_str!("../../../dsh-phone/web/sw.js");
pub const ICON_SVG: &str = include_str!("../../../dsh-phone/web/icon.svg");

/// Maps a request path (no leading slash, no query) to `(body, content-type)`.
pub fn lookup(path: &str) -> Option<(&'static str, &'static str)> {
    match path.trim_start_matches('/') {
        "" | "index.html" => Some((INDEX_HTML, "text/html; charset=utf-8")),
        "md.js" => Some((MD_JS, "text/javascript; charset=utf-8")),
        "app.js" => Some((APP_JS, "text/javascript; charset=utf-8")),
        "style.css" => Some((STYLE_CSS, "text/css; charset=utf-8")),
        "manifest.json" => Some((MANIFEST, "application/manifest+json")),
        "sw.js" => Some((SW_JS, "text/javascript; charset=utf-8")),
        "icon.svg" => Some((ICON_SVG, "image/svg+xml")),
        _ => None,
    }
}