import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppConfig,
  ServerStatus,
  TailscaleStatus,
  PushStatus,
  QrPayload,
  UpdateInfo,
  UpdateProgress,
  getConfig,
  regenerateToken,
  serverStatus,
  startServer,
  stopServer,
  tailscaleStatus,
  tailscaleInstall,
  healTailnet,
  getAutostart,
  setAutostart,
  setStartHidden,
  setTlsEnabled,
  tlsExportCa,
  connectQr,
  updateCheck,
  updateInstall,
  restartApp,
  setAllowedIps,
  addDevice,
  removeDevice,
  pushStatus,
  setNtfy,
  pushTest,
  pushClear,
} from "./lib/bridge";

type Lang = "ru" | "en";

const dict: Record<Lang, Record<string, string>> = {
  ru: {
    sub: "локальный мост · телефон ↔ ПК",
    winMin: "свернуть",
    winMax: "развернуть",
    winRestore: "восстановить",
    winClose: "закрыть",
    nodeOn: "узел активен",
    nodeOff: "узел заглушён",
    hero: "Связь на проводе.",
    heroSub:
      "DSH Desktop на этом ПК, агент — в поле на телефоне. Между вами один ключ и этот узел. Облака нет.",
    node: "Узел",
    nodeDesc: "ядро связи · слушает порт",
    stop: "заглушить",
    start: "поднять",
    port: "порт",
    uptime: "аптайм",
    req: "запросов",
    bridgeLbl: "мост",
    standby: "дежурный",
    copy: "копия",
    steps: "Подключение",
    s1t: "Сеть",
    s1: "Телефон и ПК в один Tailscale. ПК отвечает как",
    s2t: "Узел",
    s2: "Подними узел выше — он встанет на порт",
    s3t: "Линия",
    s3: "Открой на телефоне",
    s4t: "Ключ",
    s4: "Вставь токен из карточки справа.",
    note: "Без запущенного DSH Desktop на этом ПК узел молчит. Пропуск - плагин dsh-phone-bridge (рекомендуется) или Agents Anywhere.",
    key: "Ключ доступа",
    issuing: "выдаю…",
    copyBtn: "Скопировать",
    regen: "Сменить",
    keyHint: "Смени, если засветил — старый отвалится сразу.",
    keyShow: "показать ключ",
    keyHide: "скрыть ключ",
    config: "Конфиг",
    host: "хост",
    cPort: "порт",
    tailscale: "tailscale",
    connector: "коннектор",
    staging: "стейджинг",
    cfgFile: "файл конфига",
    foot: "данные не покидают твою сеть",
    ver: "DSH Phone · v0.2",
    tOn: "узел поднят",
    tOff: "узел заглушён",
    errPrefix: "ошибка: ",
    tCopied: "адрес скопирован",
    tCopyFail: "не скопировалось",
    tKeyCopied: "ключ скопирован",
    tRegen: "ключ пересоздан",
    confirm: "Сменить ключ? Старый перестанет работать.",
    lang: "EN",
    tsLoggedIn: "в tailscale ·",
    tsNotLogged: "установлен, не вошёл",
    tsMissing: "tailscale не найден",
    tsInstall: "установить",
    tsInstalling: "запускаю установку…",
    tsHeal: "лечить связь",
    tsHealed: "сокеты перевязаны ·",
    tsHealFail: "перевязка не удалась",
    autoStart: "Автозапуск с Windows",
    autoStartHint: "узел поднимается при входе в систему, свёрнуто в трее",
    autoStartOn: "автозапуск включён",
    autoStartOff: "автозапуск выключен",
    startHidden: "Стартовать свёрнуто",
    startHiddenHint: "при запуске только значок в трее, без окна",
    startHiddenOn: "старт в трее включён",
    startHiddenOff: "старт с окном",
    tls: "TLS поверх tailscale",
    tlsHint: "нужен для пушей в браузере телефона · свой CA + серт на IP тейлнета, узел перезапускается сам",
    tlsOn: "TLS включён",
    tlsOff: "TLS выключен",
    tlsServingHttps: "https поднят",
    tlsServingHttp: "внимание: узел отдаёт http, а не https",
    tlsCaExport: "скачать CA на ПК",
    tlsCaExported: "CA сохранён на рабочий стол",
    tlsCaFailed: "не удалось сохранить CA",
    tlsCaHint: "файл dsh-phone-ca.pem на рабочем столе — поставь его на телефон один раз: iOS через «Профиль» (Настройки → Основные → Профиль) и включи полное доверие, Android через установку сертификата CA. Без этого Safari не даст пуши даже после «всё равно перейти».",
    qr: "QR-подключение",
    qrHint: "наведи камеру телефона — зайдёт само, без набора 32 символов",
    qrHowto: "открой камеру (iPhone) или Google Lens (Android), наведи на код и тапни по ссылке. Телефон попадёт сразу в список сессий.",
    qrCopy: "скопировать ссылку",
    qrCopied: "ссылка в буфере",
    qrCopyFailed: "не удалось скопировать",
    qrSelectManually: "выдели ссылку в поле и скопируй вручную",
    qrStale: "QR собран для других настроек — обнови",
    qrRefresh: "обновить QR",
    qrWarnPlain: "код ведёт по http: без TLS браузер телефона покажет предупреждение, а iOS не даст пуши. Включи TLS выше.",
    qrFailed: "не удалось собрать QR",
    upd: "Обновление",
    updHint: "проверяет GitHub Releases и ставит новую версию",
    updCheck: "проверить",
    updNew: "доступна версия",
    updInstall: "обновить и перезапустить",
    updUpToDate: "у вас свежая версия",
    updCurrent: "установлена",
    updFailed: "обновление не поставилось",
    updInstalled: "поставлена версия",
    updCheckFailed: "релизы не ответили",
    updDownloading: "качаем",
    allowlist: "Белый список IP",
    allowlistHint: "кто из тейлнета достучится. пусто = все. можно CIDR",
    allowlistPlaceholder: "100.75.97.90, 100.64.0.0/10",
    allowlistApply: "применить",
    allowlistSaved: "список сохранён",
    push: "Уведомления",
    pushHint: "ход завершён / агент ждёт ответа - прилетает на телефон, даже когда PWA закрыта",
    pushTest: "тест",
    pushTestOk: "тест ушёл: webpush {n} · ntfy {on}",
    pushNoChannels: "нет каналов: включи ntfy или подпишись из PWA",
    webPush: "Web Push",
    webPushHint: "подписка делается с телефона: PWA → меню ☰ → «пуши»",
    pushClear: "сбросить",
    pushCleared: "подписки сброшены",
    ntfyLbl: "ntfy-канал",
    ntfyHint: "сторонний канал без Google/Apple: ntfy-приложение на телефоне подписывается на топик",
    ntfyUrlPh: "https://ntfy.sh",
    ntfyTopicPh: "топик",
    ntfyTokenPh: "токен (не обязателен)",
    ntfyApply: "применить",
    ntfySaved: "ntfy настроен",
    fingerprint: "отпечаток серта",
    devices: "Устройства",
    devicesHint: "каждому телефону — свой ключ и своё окно агента в DSH",
    deviceName: "имя телефона",
    addDevice: "добавить",
    deviceAdded: "устройство добавлено, узел перезапущен",
    deviceRemoved: "устройство убрано, узел перезапущен",
    devConfirm: "Убрать устройство? Его телефон сразу отвалится.",
    devMain: "основное",
    bridgeLive: "мост жив",
    bridgeDown: "мост лежит",
  },
  en: {
    sub: "local bridge · phone ↔ PC",
    winMin: "minimize",
    winMax: "maximize",
    winRestore: "restore",
    winClose: "close",
    nodeOn: "node online",
    nodeOff: "node offline",
    hero: "The line is live.",
    heroSub:
      "DSH Desktop on this PC, the agent out in the field on your phone. One key and this node between you. No cloud.",
    node: "Node",
    nodeDesc: "link core · listening port",
    stop: "shut down",
    start: "bring up",
    port: "port",
    uptime: "uptime",
    req: "requests",
    bridgeLbl: "bridge",
    standby: "standby",
    copy: "copy",
    steps: "Connect",
    s1t: "Network",
    s1: "Phone and PC on one Tailscale. The PC answers as",
    s2t: "Node",
    s2: "Bring the node up above — it listens on port",
    s3t: "Line",
    s3: "Open this on the phone",
    s4t: "Key",
    s4: "Paste the token from the card on the right.",
    note: "Without DSH Desktop running on this PC the node stays silent. The way in is the dsh-phone-bridge plugin (recommended) or Agents Anywhere.",
    key: "Access key",
    issuing: "issuing…",
    copyBtn: "Copy",
    regen: "Rotate",
    keyHint: "Rotate it if it's leaked — the old one dies immediately.",
    keyShow: "reveal key",
    keyHide: "hide key",
    config: "Config",
    host: "host",
    cPort: "port",
    tailscale: "tailscale",
    connector: "connector",
    staging: "staging",
    cfgFile: "config file",
    foot: "your data never leaves your network",
    ver: "DSH Phone · v0.2",
    tOn: "node up",
    tOff: "node stopped",
    errPrefix: "error: ",
    tCopied: "address copied",
    tCopyFail: "copy failed",
    tKeyCopied: "key copied",
    tRegen: "key rotated",
    confirm: "Rotate the key? The old one stops working.",
    lang: "RU",
    tsLoggedIn: "signed in ·",
    tsNotLogged: "installed, not signed in",
    tsMissing: "tailscale not found",
    tsInstall: "install",
    tsInstalling: "starting install…",
    tsHeal: "heal link",
    tsHealed: "sockets rebound ·",
    tsHealFail: "rebind failed",
    autoStart: "Start with Windows",
    autoStartHint: "brings the node up at login, minimized to tray",
    autoStartOn: "autostart on",
    autoStartOff: "autostart off",
    startHidden: "Start minimized",
    startHiddenHint: "only the tray icon on launch, no window",
    startHiddenOn: "tray start on",
    startHiddenOff: "window start on",
    tls: "TLS over tailscale",
    tlsHint: "required for push in the phone browser · own CA + cert for the tailnet IP, node restarts itself",
    tlsOn: "TLS on",
    tlsOff: "TLS off",
    tlsServingHttps: "https is up",
    tlsServingHttp: "warning: node is serving http, not https",
    tlsCaExport: "download CA to this PC",
    tlsCaExported: "CA saved to the desktop",
    tlsCaFailed: "could not save the CA",
    tlsCaHint: "dsh-phone-ca.pem lands on the desktop — install it on the phone once: iOS via a downloaded Profile (Settings → General → Profile) plus full trust, Android as a CA certificate. Without it Safari will not grant push even after tapping through the warning.",
    qr: "QR sign-in",
    qrHint: "point the phone camera at it — no typing 32 characters",
    qrHowto: "open the camera (iPhone) or Google Lens (Android), point it at the code and tap the link. The phone lands straight in the session list.",
    qrCopy: "copy link",
    qrCopied: "link copied",
    qrCopyFailed: "copy failed",
    qrSelectManually: "select the link in the field and copy it manually",
    qrStale: "this QR was built for other settings — refresh it",
    qrRefresh: "refresh QR",
    qrWarnPlain: "the code points at http: without TLS the phone browser shows a warning and iOS will not grant push. Turn on TLS above.",
    qrFailed: "could not build the QR",
    upd: "Update",
    updHint: "checks GitHub Releases and installs the new version",
    updCheck: "check",
    updNew: "available",
    updInstall: "update and restart",
    updUpToDate: "you are on the latest version",
    updCurrent: "installed",
    updFailed: "update failed",
    updInstalled: "installed version",
    updCheckFailed: "releases did not respond",
    updDownloading: "downloading",
    allowlist: "IP allowlist",
    allowlistHint: "who in the tailnet can reach it. empty = everyone. CIDR allowed",
    allowlistPlaceholder: "100.75.97.90, 100.64.0.0/10",
    allowlistApply: "apply",
    allowlistSaved: "allowlist saved",
    push: "Notifications",
    pushHint: "turn finished / agent needs you - lands on the phone even with the PWA closed",
    pushTest: "test",
    pushTestOk: "test sent: webpush {n} · ntfy {on}",
    pushNoChannels: "no channels on: enable ntfy or subscribe from the PWA",
    webPush: "Web Push",
    webPushHint: "subscribe from the phone: PWA → menu ☰ → «push»",
    pushClear: "reset",
    pushCleared: "subscriptions cleared",
    ntfyLbl: "ntfy channel",
    ntfyHint: "third channel without Google/Apple: the ntfy app subscribes to a topic",
    ntfyUrlPh: "https://ntfy.sh",
    ntfyTopicPh: "topic",
    ntfyTokenPh: "token (optional)",
    ntfyApply: "apply",
    ntfySaved: "ntfy configured",
    fingerprint: "cert fingerprint",
    devices: "Devices",
    devicesHint: "every phone gets its own key and its own agent window in DSH",
    deviceName: "phone name",
    addDevice: "add",
    deviceAdded: "device added, node restarted",
    deviceRemoved: "device removed, node restarted",
    devConfirm: "Remove the device? Its phone drops immediately.",
    devMain: "main",
    bridgeLive: "bridge live",
    bridgeDown: "bridge down",
  },
};

function copyText(t: string): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => resolve(ok);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(t)
        .then(() => done(true))
        .catch(() => fallback());
    } else {
      fallback();
    }
    function fallback() {
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done(true);
      } catch {
        done(false);
      }
    }
  });
}

function fmtUptime(s: number, lang: Lang): string {
  const u = lang === "ru" ? ["с", "м", "ч"] : ["s", "m", "h"];
  if (s < 60) return `${s}${u[0]}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${u[1]} ${s % 60}${u[0]}`;
  const h = Math.floor(m / 60);
  return `${h}${u[2]} ${m % 60}${u[1]}`;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-edge last:border-0">
      <span className="text-ash text-[12px] shrink-0">{k}</span>
      <span className="text-right text-[12.5px] break-all text-bone mono-badge">{v}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-sm bg-ink/55 border border-edge px-3 py-2">
      <div className="lbl">{label}</div>
      <div className={`mono-badge text-[15px] mt-1 ${accent ? "text-moss" : "text-bone"}`}>
        {value}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <div className="h-6 w-6 shrink-0 rounded-sm border border-blood/30 text-blood text-[11px] mono-badge flex items-center justify-center">
        {n}
      </div>
      <div className="text-[13px] leading-relaxed text-ash">
        <span className="text-bone">{title}. </span>
        {children}
      </div>
    </li>
  );
}

type FeedKind = "ok" | "err" | "data";
type FeedLine = { k: FeedKind; t: string };

function makeFeedLine(): FeedLine {
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const hb = () => rnd(256).toString(16).padStart(2, "0");
  const ip = () => `100.${rnd(128)}.${rnd(256)}.${rnd(256)}`;
  const n = rnd(11);
  if (n === 0) return { k: "err", t: `[ERR] relay timeout ${ip()}:${rnd(65535)}` };
  if (n === 1) return { k: "ok", t: `[ OK ] auth seq ${rnd(999999)} route ${ip()}` };
  if (n === 2) return { k: "ok", t: `[SYN] ${rnd(2) ? "tcp" : "udp"} ${ip()}:${rnd(65535)} -> 100.75.97.90:8460` };
  if (n === 3) return { k: "data", t: `recv ${rnd(1500) + 40} bytes · ${Array.from({ length: 8 }, hb).join(" ")}` };
  if (n === 4) return { k: "data", t: `0x${Array.from({ length: 12 }, hb).join("")}  ${Array.from({ length: 4 }, () => hb() + hb() + hb() + hb()).join("")}` };
  if (n === 5) return { k: "ok", t: `handshake ${ip()} <-> 100.75.97.90 · ${rnd(3) ? "direct" : "derp-relay"}` };
  if (n === 6) return { k: "data", t: `${rnd(3) ? "mtu 1280" : "keepalive 25s"} · rx ${rnd(9999)} tx ${rnd(9999)}` };
  if (n === 7) return { k: "err", t: `retry ${rnd(10)} · ${ip()} expiring key #${rnd(99999)}` };
  if (n === 8) return { k: "ok", t: `bridge ${rnd(2) ? "sync" : "poll"} ok · ${hb()}${hb()}${hb()}` };
  if (n === 9) return { k: "data", t: `>>> ${Array.from({ length: 18 }, () => "0123456789abcdef"[rnd(16)]).join("")}` };
  return { k: "data", t: `hop ${rnd(4) + 1} · ${ip()} latency ${rnd(40) + 1}ms` };
}

function TunnelFeed({ active }: { active: boolean }) {
  const [lines, setLines] = useState<FeedLine[]>([]);
  useEffect(() => {
    if (!active) {
      setLines([]);
      return;
    }
    const add = () => setLines((prev) => [...prev, makeFeedLine()].slice(-13));
    add();
    const id = window.setInterval(add, 90);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) return null;
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <span className="lbl">tunnel // live</span>
        <span className="mono-badge text-[10px] text-blood animate-pulse">●</span>
      </div>
      <div className="tunnel-feed-body">
        {lines.map((l, i) => (
          <div key={i} className={"tfl " + l.k}>{l.t}</div>
        ))}
      </div>
    </div>
  );
}

// Своя панель окна. Системную рамку выключили (decorations: false в
// tauri.conf.json), поэтому свернуть/развернуть/закрыть и перетаскивание окна
// живут здесь, в стиле дашборда, а не в сером хроме Windows. Панель - зона
// перетаскивания (data-tauri-drag-region), двойной клик по ней разворачивает
// окно, как это делала системная рамка.
function TitleBar({ t }: { t: (k: string) => string }) {
  const [maximized, setMaximized] = useState(false);
  const [inTauri, setInTauri] = useState(false);

  useEffect(() => {
    // Вне Tauri (обычный браузер, скриншоты, тесты рендера) окна нет: панель
    // отрисуется, но кнопки молчат вместо исключения.
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    setInTauri(true);
    let off: (() => void) | undefined;
    let dead = false;
    const w = getCurrentWindow();
    const refresh = () => {
      w.isMaximized()
        .then((m) => {
          if (!dead) setMaximized(m);
        })
        .catch(() => {});
    };
    refresh();
    w.onResized(refresh)
      .then((fn) => {
        off = fn;
      })
      .catch(() => {});
    return () => {
      dead = true;
      if (off) off();
    };
  }, []);

  const act = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) => () => {
    if (!inTauri) return;
    fn(getCurrentWindow()).catch(() => {});
  };

  const btn =
    "flex h-8 w-11 items-center justify-center text-ash transition hover:bg-edge/40 hover:text-bone";

  return (
    <div
      data-tauri-drag-region
      className="relative z-30 flex h-9 shrink-0 select-none items-center justify-between border-b border-edge bg-ink/85 pl-3 pr-1"
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <span data-tauri-drag-region className="text-[10px] text-blood">
          ◆
        </span>
        <span data-tauri-drag-region className="mono-badge text-[10.5px] tracking-[0.18em] text-ash">
          DSH PHONE
        </span>
      </div>
      <div className="flex items-center">
        <button
          className={btn}
          onClick={act((w) => w.minimize())}
          title={t("winMin")}
          aria-label={t("winMin")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          className={btn}
          onClick={act((w) => w.toggleMaximize())}
          title={maximized ? t("winRestore") : t("winMax")}
          aria-label={maximized ? t("winRestore") : t("winMax")}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M3.5 3.5h5v5h-5z" stroke="currentColor" strokeWidth="1.1" />
              <path d="M1.5 6.5v-5h5" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          )}
        </button>
        <button
          className="flex h-8 w-11 items-center justify-center text-ash transition hover:bg-blood/80 hover:text-bone"
          onClick={act((w) => w.close())}
          title={t("winClose")}
          aria-label={t("winClose")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [ts, setTs] = useState<TailscaleStatus | null>(null);
  const [tsBusy, setTsBusy] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [autostart, setAutostartState] = useState(false);
  const [ipList, setIpList] = useState("");
  const [devName, setDevName] = useState("");
  const [push, setPush] = useState<PushStatus | null>(null);
  const [ntfyUrl, setNtfyUrl] = useState("");
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfyToken, setNtfyToken] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [updBusy, setUpdBusy] = useState(false);
  const [updPct, setUpdPct] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [lang, setLang] = useState<Lang>(() =>
    localStorage.getItem("dsh-lang") === "en" ? "en" : "ru"
  );
  const toastTimer = useRef<number | null>(null);
  const spotRef = useRef<HTMLDivElement | null>(null);

  const t = (key: string) => dict[lang][key] || key;

  const fireToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  }, []);

  const refreshTailscale = useCallback(() => {
    tailscaleStatus().then(setTs).catch(() => {});
  }, []);

  const onInstall = async () => {
    setTsBusy(true);
    try {
      await tailscaleInstall();
      fireToast(t("tsInstalling"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
    setTsBusy(false);
    let tries = 0;
    const iv = window.setInterval(() => {
      tries += 1;
      tailscaleStatus().then(setTs).catch(() => {});
      if (tries >= 15) window.clearInterval(iv);
    }, 4000);
  };

  const onHealTailnet = async () => {
    setTsBusy(true);
    try {
      const r = await healTailnet();
      if (r.ok) fireToast(t("tsHealed") + " " + (r.ip || ""));
      else fireToast(t("tsHealFail"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
    setTsBusy(false);
    refreshTailscale();
    getConfig().then(setCfg).catch(() => {});
  };

  const onToggleAutostart = async () => {
    try {
      const v = await setAutostart(!autostart);
      setAutostartState(v);
      fireToast(v ? t("autoStartOn") : t("autoStartOff"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const onToggleStartHidden = async () => {
    try {
      const c = await setStartHidden(!(cfg?.start_hidden));
      setCfg(c);
      fireToast(c.start_hidden ? t("startHiddenOn") : t("startHiddenOff"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const onToggleTls = async () => {
    try {
      const c = await setTlsEnabled(!(cfg?.tls_enabled));
      setCfg(c);
      // схема поменялась - QR надо пересобрать, иначе он поведёт телефон по http
      refreshQr();
      fireToast(c.tls_enabled ? t("tlsOn") : t("tlsOff"));
      // узел перезапустился - подтягиваем честный статус (https поднялся или нет)
      await new Promise((r) => setTimeout(r, 1200));
      try { setStatus(await serverStatus()); } catch { /* poll подхватит */ }
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const onExportCa = async () => {
    try {
      await tlsExportCa();
      fireToast(t("tlsCaExported"));
    } catch (e) {
      fireToast(t("tlsCaFailed") + ": " + e);
    }
  };

  // QR пересобирается при любом изменении адреса, порта или TLS: код обязан
  // вести туда же, куда смотрит дашборд, иначе телефон уйдёт по http при
  // включённом TLS и упрётся в предупреждение браузера.
  const refreshQr = useCallback(() => {
    connectQr()
      .then(setQr)
      .catch(() => setQr(null));
  }, []);

  const qrUrlRef = useRef<HTMLInputElement | null>(null);

  const onCopyQrUrl = async () => {
    if (!qr) return;
    // clipboard API в webview доступен не всегда (зависит от схемы origin),
    // поэтому держим запасной путь через выделение поля и execCommand
    try {
      await navigator.clipboard.writeText(qr.url);
      fireToast(t("qrCopied"));
      return;
    } catch (_) {
      /* fallthrough */
    }
    try {
      const el = qrUrlRef.current;
      if (el) {
        el.focus();
        el.select();
        const done = document.execCommand("copy");
        fireToast(done ? t("qrCopied") : t("qrSelectManually"));
        return;
      }
    } catch (_) {
      /* fallthrough */
    }
    fireToast(t("qrSelectManually"));
  };

  // Проверка обновлений. Ошибку сети показываем текстом: «обновлений нет» и
  // «релизы не ответили» — принципиально разные сообщения для пользователя.
  const refreshUpd = useCallback(() => {
    updateCheck()
      .then(setUpd)
      .catch((e) =>
        setUpd({ available: false, version: null, current: "", notes: null, error: String(e) })
      );
  }, []);

  const onUpdateInstall = async () => {
    setUpdBusy(true);
    setUpdPct(0);
    // прогресс приходит из Rust событием; отписываемся в любом исходе
    let un: (() => void) | null = null;
    try {
      un = await listen<UpdateProgress>("update-progress", (ev) => {
        setUpdPct(ev.payload?.percent ?? null);
      });
    } catch (_) {
      /* без прогресса установка всё равно работает */
    }
    try {
      const v = await updateInstall();
      fireToast(t("updInstalled") + " " + v);
      // узел уже погашен установщиком, перезапускаем приложение
      await restartApp();
    } catch (e) {
      fireToast(t("updFailed") + ": " + e);
      setUpdBusy(false);
      setUpdPct(null);
      refreshUpd();
    } finally {
      if (un) un();
    }
  };

  const onSaveAllowlist = async () => {
    try {
      const ips = ipList.split(",").map((s) => s.trim()).filter(Boolean);
      const c = await setAllowedIps(ips);
      setCfg(c);
      setIpList((c.allowed_ips ?? []).join(", "));
      fireToast(t("allowlistSaved"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const refreshPush = useCallback(() => {
    pushStatus()
      .then((p) => {
        setPush(p);
        setNtfyUrl((v) => (v ? v : p.ntfy_url));
        setNtfyTopic((v) => (v ? v : p.ntfy_topic));
        setNtfyToken((v) => (v ? v : p.ntfy_token));
      })
      .catch(() => {});
  }, []);

  const onToggleNtfy = async () => {
    try {
      const next = !(push?.ntfy_enabled);
      await setNtfy(next, ntfyUrl, ntfyTopic, ntfyToken);
      refreshPush();
      fireToast(next ? t("ntfySaved") : t("ntfyLbl") + " off");
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const onSaveNtfy = async () => {
    try {
      await setNtfy(push?.ntfy_enabled ?? false, ntfyUrl, ntfyTopic, ntfyToken);
      refreshPush();
      fireToast(t("ntfySaved"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const onPushTest = async () => {
    setPushBusy(true);
    try {
      const r = await pushTest();
      fireToast(
        t("pushTestOk")
          .replace("{n}", String(r.channels.webpush))
          .replace("{on}", r.channels.ntfy ? "on" : "off")
      );
    } catch (e) {
      fireToast(t("errPrefix") + e);
    } finally {
      setPushBusy(false);
    }
  };

  const onPushClear = async () => {
    try {
      const p = await pushClear();
      setPush(p);
      fireToast(t("pushCleared"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    }
  };

  const onAddDevice = async () => {
    if (!devName.trim()) return;
    setBusy(true);
    try {
      const c = await addDevice(devName.trim());
      setCfg(c);
      setDevName("");
      fireToast(t("deviceAdded"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    } finally {
      setBusy(false);
    }
  };

  const onRemoveDevice = async (token: string) => {
    if (!window.confirm(t("devConfirm"))) return;
    setBusy(true);
    try {
      const c = await removeDevice(token);
      setCfg(c);
      fireToast(t("deviceRemoved"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    getConfig()
      .then((c) => {
        setCfg(c);
        setIpList((c.allowed_ips ?? []).join(", "));
      })
      .catch((e) => fireToast(t("errPrefix") + e));
    refreshTailscale();
    getAutostart().then(setAutostartState).catch(() => {});
    refreshPush();
    refreshQr();
    refreshUpd();
    const poll = () => serverStatus().then(setStatus).catch(() => {});
    poll();
    const id = window.setInterval(poll, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireToast]);

  // mouse magic: soft spotlight chases the cursor with a little lag
  useEffect(() => {
    let tx = -400;
    let ty = -400;
    let x = -400;
    let y = -400;
    let raf = 0;
    const move = (e: MouseEvent) => {
      tx = e.clientX;
      ty = e.clientY;
    };
    const loop = () => {
      x += (tx - x) * 0.12;
      y += (ty - y) * 0.12;
      if (spotRef.current) {
        spotRef.current.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      }
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("mousemove", move);
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("mousemove", move);
      cancelAnimationFrame(raf);
    };
  }, []);

  const toggleLang = () => {
    const next: Lang = lang === "ru" ? "en" : "ru";
    setLang(next);
    localStorage.setItem("dsh-lang", next);
  };

  const onToggleServer = async () => {
    setBusy(true);
    try {
      const st = status?.running ? await stopServer() : await startServer();
      setStatus(st);
      if (cfg) setCfg(await getConfig());
      fireToast(st.running ? t("tOn") : t("tOff"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    } finally {
      setBusy(false);
    }
  };

  const onRegen = async () => {
    if (!window.confirm(t("confirm"))) return;
    setBusy(true);
    try {
      const c = await regenerateToken();
      setCfg(c);
      // старый токен мёртв - QR с ним больше не работает, пересобираем
      refreshQr();
      fireToast(t("tRegen"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    } finally {
      setBusy(false);
    }
  };

  const scheme = cfg?.tls_enabled ? "https" : "http";
  const url = cfg ? `${scheme}://${cfg.tailscale_ip}:${cfg.listen_port}` : "";
  const running = status?.running ?? false;

  return (
    <div className="flex h-full w-full flex-col">
      <TitleBar t={t} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid-backdrop" />
      <div className="blood-glow" />
      <div className="vignette" />
      <div className="grain" />
      <div ref={spotRef} className="spotlight" />

      <div className="relative z-10 mx-auto max-w-6xl px-7 py-7">
        {/* header */}
        <header className="flex items-center justify-between mb-9">
          <div className="flex items-center gap-3">
            <div className="emblem">◆</div>
            <div>
              <div className="text-[18px] text-bone font-semibold serif">DSH PHONE</div>
              <div className="text-[12px] text-ash mt-0.5">{t("sub")}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleLang}
              className="px-2.5 py-1.5 rounded-full border border-edge text-[12px] text-ash hover:text-bone hover:border-faint transition"
              title="EN / RU"
            >
              {t("lang")}
            </button>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-edge bg-panel/70 text-[12px] text-ash">
              <span className={`pulse-dot ${running ? "dot-on" : "dot-off"}`} />
              <span className={running ? "text-moss" : "text-blood"}>
                {running ? t("nodeOn") : t("nodeOff")}
              </span>
            </div>
          </div>
        </header>

        {/* hero */}
        <section className="fade-up mb-9">
          <h1 className="text-5xl sm:text-6xl font-semibold leading-[1.05] text-bone serif">
            {t("hero")}
          </h1>
          <p className="mt-4 text-ash max-w-xl text-[15px] leading-relaxed">{t("heroSub")}</p>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* left column */}
          <div className="lg:col-span-3 flex flex-col gap-5">
            {/* server card */}
            <section
              className="panel rounded-md p-5 fade-up"
              style={{ animationDelay: ".05s" }}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-[16px] font-semibold text-bone">{t("node")}</h2>
                  <div className="text-[12px] text-ash mt-0.5">{t("nodeDesc")}</div>
                </div>
                <button
                  onClick={onToggleServer}
                  disabled={busy}
                  className={`px-4 py-1.5 rounded-sm text-[12px] border transition disabled:opacity-40 ${
                    running
                      ? "text-blood border-blood/40 hover:bg-blood/10"
                      : "text-moss border-moss/40 hover:bg-moss/10"
                  }`}
                >
                  {running ? t("stop") : t("start")}
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <Stat label={t("port")} value={String(status?.port ?? cfg?.listen_port ?? "—")} />
                <Stat
                  label={t("uptime")}
                  value={status ? fmtUptime(status.uptime_seconds, lang) : "—"}
                />
                <Stat label={t("req")} value={String(status?.requests ?? 0)} />
                <Stat label={t("bridgeLbl")} value={t("standby")} accent />
              </div>
              <div className="rounded-sm bg-ink/55 border border-edge px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-bone text-[12px] break-all mono-badge opacity-80">
                  {url || "…"}
                </span>
                <button
                  onClick={async () =>
                    fireToast((await copyText(url)) ? t("tCopied") : t("tCopyFail"))
                  }
                  className="shrink-0 text-blood hover:text-ember transition p-1 rounded-sm hover:bg-blood/10"
                  title={t("copy")}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </div>
            </section>

            {/* steps card */}
            <section
              className="panel rounded-md p-5 fade-up"
              style={{ animationDelay: ".1s" }}
            >
              <h2 className="text-[16px] font-semibold text-bone mb-4">{t("steps")}</h2>
              <ol className="space-y-3">
                <Step n="01" title={t("s1t")}>
                  {t("s1")}{" "}
                  <span className="text-blood mono-badge">
                    {cfg?.tailscale_ip || "100.x.x.x"}
                  </span>
                  .
                </Step>
                <Step n="02" title={t("s2t")}>
                  {t("s2")}{" "}
                  <span className="text-blood mono-badge">{cfg?.listen_port ?? 8460}</span>.
                </Step>
                <Step n="03" title={t("s3t")}>
                  {t("s3")}{" "}
                  <span className="text-blood mono-badge">
                    {url || `http://${cfg?.tailscale_ip}:${cfg?.listen_port}`}
                  </span>
                  .
                </Step>
                <Step n="04" title={t("s4t")}>
                  {t("s4")}
                </Step>
              </ol>
              <div className="mt-4 rounded-sm border border-blood/20 bg-blood/5 px-4 py-3 text-[12.5px] text-bone/80">
                {t("note")}
              </div>
            </section>

            {/* QR + уведомления: отдельный блок в левой колонке */}
            <section className="panel rounded-md p-5 fade-up">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[16px] font-semibold text-bone">{t("qr")}</h2>
                  <div className="text-[11.5px] text-ash mt-0.5">{t("qrHint")}</div>
                </div>
                <button
                  type="button"
                  onClick={refreshQr}
                  className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-bone border border-edge hover:bg-rise/40 transition"
                >
                  {t("qrRefresh")}
                </button>
              </div>
              <div className="mt-3 rounded-sm border border-edge bg-ink/55 px-4 py-3">
                {qr ? (
                  <>
                    <div className="flex gap-4 items-start">
                      {/* data-URI в <img>, а не innerHTML: браузер не исполняет
                          скрипты из SVG по ссылке, так что разметка кода не
                          может стать вектором даже если адрес подменён */}
                      <img
                        src={"data:image/svg+xml;utf8," + encodeURIComponent(qr.svg)}
                        alt={qr.address}
                        width={188}
                        height={188}
                        className="shrink-0 rounded-sm bg-bone p-1.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11.5px] text-bone break-all">{qr.address}</div>
                        <div className="text-[11px] text-ash mt-2 leading-relaxed">{t("qrHowto")}</div>
                        {!cfg?.tls_enabled && (
                          <div className="text-[11px] text-ember mt-2 leading-relaxed">{t("qrWarnPlain")}</div>
                        )}
                        {qr.address !== url + "/" && (
                          <div className="text-[11px] text-ember mt-2">{t("qrStale")}</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        ref={qrUrlRef}
                        readOnly
                        value={qr.url}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 min-w-0 bg-ink border border-edge rounded-sm px-2.5 py-1.5 text-[11px] text-ash font-mono"
                        aria-label={t("qrCopy")}
                      />
                      <button
                        type="button"
                        onClick={onCopyQrUrl}
                        className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-bone border border-edge hover:bg-rise/40 transition"
                      >
                        {t("qrCopy")}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="text-[11.5px] text-ember">{t("qrFailed")}</div>
                )}
              </div>

              {/* уведомления */}
              <div className="mt-5 border-t border-edge pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[16px] font-semibold text-bone">{t("push")}</h2>
                    <div className="text-[11.5px] text-ash mt-0.5">{t("pushHint")}</div>
                  </div>
                  <button
                    type="button"
                    onClick={onPushTest}
                    disabled={pushBusy}
                    className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-blood border border-blood/40 hover:bg-blood/10 transition disabled:opacity-40"
                  >
                    {t("pushTest")}
                  </button>
                </div>
                <div className="mt-3 rounded-sm border border-edge bg-ink/55 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11.5px] text-ash">
                      {t("webPush")}:{" "}
                      <span className="text-bone mono-badge">{push?.subscriptions ?? 0}</span>
                    </span>
                    <button
                      type="button"
                      onClick={onPushClear}
                      disabled={(push?.subscriptions ?? 0) === 0}
                      className="px-2 py-0.5 rounded-sm text-[10.5px] text-ash hover:text-blood border border-edge transition disabled:opacity-40"
                    >
                      {t("pushClear")}
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] text-ash/80">{t("webPushHint")}</div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] text-bone">{t("ntfyLbl")}</div>
                    <div className="text-[11.5px] text-ash">{t("ntfyHint")}</div>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleNtfy}
                    className={"toggle" + (push?.ntfy_enabled ? " on" : "")}
                    aria-pressed={!!push?.ntfy_enabled}
                  >
                    <span className="knob" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <input
                    value={ntfyUrl}
                    onChange={(e) => setNtfyUrl(e.target.value)}
                    placeholder={t("ntfyUrlPh")}
                    spellCheck={false}
                    className="bg-ink/55 border border-edge rounded-sm px-3 py-1.5 text-[12px] text-bone outline-none focus:border-moss/50 placeholder:text-ash/60 transition"
                  />
                  <input
                    value={ntfyTopic}
                    onChange={(e) => setNtfyTopic(e.target.value)}
                    placeholder={t("ntfyTopicPh")}
                    spellCheck={false}
                    className="bg-ink/55 border border-edge rounded-sm px-3 py-1.5 text-[12px] text-bone outline-none focus:border-moss/50 placeholder:text-ash/60 transition"
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={ntfyToken}
                    onChange={(e) => setNtfyToken(e.target.value)}
                    placeholder={t("ntfyTokenPh")}
                    spellCheck={false}
                    type="password"
                    className="flex-1 min-w-0 bg-ink/55 border border-edge rounded-sm px-3 py-1.5 text-[12px] text-bone outline-none focus:border-moss/50 placeholder:text-ash/60 transition"
                  />
                  <button
                    type="button"
                    onClick={onSaveNtfy}
                    className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-moss border border-moss/40 hover:bg-moss/10 transition"
                  >
                    {t("ntfyApply")}
                  </button>
                </div>
              </div>
            </section>
          </div>

          {/* right column */}
          <div className="lg:col-span-2 flex flex-col gap-5">
            {/* token card */}
            <section
              className="panel rounded-md p-5 fade-up"
              style={{ animationDelay: ".15s" }}
            >
              <h2 className="text-[16px] font-semibold text-bone mb-3">{t("key")}</h2>
              <div className="rounded-sm bg-ink/55 border border-blood/25 p-3">
                <div
                  onClick={() => setKeyVisible((v) => !v)}
                  title={keyVisible ? t("keyHide") : t("keyShow")}
                  className={`text-blood text-[14px] break-all leading-relaxed mono-badge cursor-pointer transition-all ${keyVisible ? "" : "select-none"}`}
                  style={{ filter: keyVisible ? "none" : "blur(6px)", transition: "filter .18s ease" }}
                >
                  {cfg ? cfg.token : t("issuing")}
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={async () =>
                    cfg &&
                    fireToast((await copyText(cfg.token)) ? t("tKeyCopied") : t("tCopyFail"))
                  }
                  className="flex-1 px-3 py-2 rounded-sm bg-blood/12 text-blood text-[12px] hover:bg-blood/20 border border-blood/25 transition"
                >
                  {t("copyBtn")}
                </button>
                <button
                  onClick={() => setKeyVisible((v) => !v)}
                  className="px-3 py-2 rounded-sm text-ash hover:bg-white/5 border border-edge transition"
                  title={keyVisible ? t("keyHide") : t("keyShow")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {keyVisible ? (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    ) : (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </svg>
                </button>
                <button
                  onClick={onRegen}
                  disabled={busy}
                  className="px-3 py-2 rounded-sm text-[12px] text-ash hover:bg-white/5 border border-edge transition disabled:opacity-40"
                >
                  {t("regen")}
                </button>
              </div>
              <div className="mt-3 text-[11.5px] text-ash">{t("keyHint")}</div>

              <div className="mt-4 border-t border-edge pt-3">
                <div className="flex items-baseline justify-between mb-1">
                  <div className="lbl">{t("devices")}</div>
                  <div className="text-[10.5px] text-ash">{t("devicesHint")}</div>
                </div>
                <div className="divide-y divide-edge">
                  {(status?.devices ?? []).map((d) => (
                    <div key={d.token} className="py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${d.connected ? "bg-moss" : "bg-ash/50"}`}
                          />
                          <span className="text-[13px] text-bone truncate">{d.name}</span>
                          {d.main && (
                            <span className="shrink-0 text-[10px] uppercase tracking-wider text-ash border border-edge rounded-full px-2 py-0.5">
                              {t("devMain")}
                            </span>
                          )}
                          <span className="mono-badge text-[10.5px] text-ash truncate">{d.connector_id}</span>
                        </div>
                        <span className={`shrink-0 text-[11px] ${d.connected ? "text-moss" : "text-ash"}`}>
                          {d.connected ? t("bridgeLive") : t("bridgeDown")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span
                          className={`mono-badge text-[11px] text-blood break-all min-w-0 flex-1 ${keyVisible ? "" : "select-none"}`}
                          style={{ filter: keyVisible ? "none" : "blur(4px)", transition: "filter .18s ease" }}
                          title={keyVisible ? d.token : undefined}
                        >
                          {d.token}
                        </span>
                        <button
                          onClick={async () =>
                            fireToast((await copyText(d.token)) ? t("tKeyCopied") : t("tCopyFail"))
                          }
                          className="shrink-0 text-blood hover:text-ember transition p-1 rounded-sm hover:bg-blood/10"
                          title={t("copyBtn")}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                        {!d.main && (
                          <button
                            onClick={() => onRemoveDevice(d.token)}
                            disabled={busy}
                            className="shrink-0 px-2 py-1 rounded-sm text-[11px] text-ash hover:text-blood hover:border-blood/40 border border-edge transition disabled:opacity-40"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {!(status?.devices ?? []).length && (
                    <div className="py-2 text-[12px] text-ash">{running ? "…" : t("nodeOff")}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-2.5">
                  <input
                    value={devName}
                    onChange={(e) => setDevName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onAddDevice();
                      }
                    }}
                    placeholder={t("deviceName")}
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-ink/55 border border-edge rounded-sm px-3 py-1.5 text-[12px] text-bone outline-none focus:border-blood/50 placeholder:text-ash/60 transition"
                  />
                  <button
                    type="button"
                    onClick={onAddDevice}
                    disabled={busy || !devName.trim()}
                    className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-blood border border-blood/40 hover:bg-blood/10 transition disabled:opacity-40"
                  >
                    + {t("addDevice")}
                  </button>
                </div>
              </div>
            </section>

            {/* config card */}
            <section
              className="panel rounded-md p-5 fade-up"
              style={{ animationDelay: ".2s" }}
            >
              <h2 className="text-[16px] font-semibold text-bone mb-2">{t("config")}</h2>
              <div>
                <Row k={t("host")} v={cfg?.listen_host ?? "—"} />
                <Row k={t("cPort")} v={String(cfg?.listen_port ?? "—")} />
                <Row k={t("tailscale")} v={cfg?.tailscale_ip ?? "—"} />
                <Row k={t("connector")} v={cfg?.connector_id ?? "—"} />
                <Row k={t("staging")} v={cfg?.staging_path ?? "—"} />
                <Row k={t("cfgFile")} v={cfg?.config_path ?? "—"} />
              </div>
              <div className="mt-3 rounded-sm border border-edge bg-ink/55 px-4 py-3 flex items-center justify-between gap-3">
                <div className="text-[12px]">
                  {ts && ts.installed
                    ? <span className={ts.logged_in ? "text-moss" : "text-ash"}>
                        {ts.logged_in ? t("tsLoggedIn") : t("tsNotLogged")}
                        {ts.ip ? <span className="ml-1 text-blood mono-badge">{ts.ip}</span> : null}
                      </span>
                    : <span className="text-blood">{t("tsMissing")}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {ts && ts.installed && (
                    <button
                      onClick={onHealTailnet}
                      disabled={tsBusy}
                      className="px-3 py-1.5 rounded-sm text-[12px] text-blood border border-blood/40 hover:bg-blood/10 transition disabled:opacity-40"
                      title="перевязать сокеты tailscale после включения/выключения WARP"
                    >
                      {t("tsHeal")}
                    </button>
                  )}
                  {ts && !ts.installed && (
                    <button
                      onClick={onInstall}
                      disabled={tsBusy}
                      className="px-3 py-1.5 rounded-sm text-[12px] text-moss border border-moss/40 hover:bg-moss/10 transition disabled:opacity-40"
                    >
                      {t("tsInstall")}
                    </button>
                  )}
                </div>
              </div>
              <TunnelFeed active={!!(status?.running)} />
              <div className="mt-3 border-t border-edge pt-1 divide-y divide-edge">
                <div className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <div className="text-[13px] text-bone">{t("autoStart")}</div>
                    <div className="text-[11.5px] text-ash">{t("autoStartHint")}</div>
                  </div>
                  <button type="button" onClick={onToggleAutostart} className={"toggle" + (autostart ? " on" : "")} aria-pressed={autostart}>
                    <span className="knob" />
                  </button>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <div className="text-[13px] text-bone">{t("startHidden")}</div>
                    <div className="text-[11.5px] text-ash">{t("startHiddenHint")}</div>
                  </div>
                  <button type="button" onClick={onToggleStartHidden} className={"toggle" + (cfg?.start_hidden ? " on" : "")} aria-pressed={!!cfg?.start_hidden}>
                    <span className="knob" />
                  </button>
                </div>
                <div className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] text-bone">{t("tls")}</div>
                      <div className="text-[11.5px] text-ash">{t("tlsHint")}</div>
                    </div>
                    <button type="button" onClick={onToggleTls} className={"shrink-0 toggle" + (cfg?.tls_enabled ? " on" : "")} aria-pressed={!!cfg?.tls_enabled}>
                      <span className="knob" />
                    </button>
                  </div>
                  {cfg?.tls_enabled && (
                    <div className="mt-2 rounded-sm border border-edge bg-ink/55 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11.5px]">
                            {status?.running ? (
                              <span className={status.tls_serving === "https" ? "text-moss" : "text-ember"}>
                                {status.tls_serving === "https" ? "● " + t("tlsServingHttps") : "● " + t("tlsServingHttp")}
                              </span>
                            ) : (
                              <span className="text-ash">● {t("nodeOff")}</span>
                            )}
                          </div>
                          {status?.tls_sha256 && (
                            <div className="text-[11px] text-ash mt-1.5">
                              {t("fingerprint")}{" "}
                              <span className="mono-badge break-all">{status.tls_sha256}</span>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={onExportCa}
                          className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-moss border border-moss/40 hover:bg-moss/10 transition"
                        >
                          {t("tlsCaExport")}
                        </button>
                      </div>
                      {status?.tls_error && (
                        <div className="text-[11px] text-ember mt-2 break-all">{status.tls_error}</div>
                      )}
                      <div className="text-[11px] text-ash mt-2 leading-relaxed">{t("tlsCaHint")}</div>
                    </div>
                  )}
                </div>
                <div className="py-2.5 border-t border-edge">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] text-bone">{t("upd")}</div>
                      <div className="text-[11.5px] text-ash">{t("updHint")}</div>
                    </div>
                    <button
                      type="button"
                      onClick={refreshUpd}
                      disabled={updBusy}
                      className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-bone border border-edge hover:bg-rise/40 transition disabled:opacity-40"
                    >
                      {t("updCheck")}
                    </button>
                  </div>
                  {upd && (
                    <div className="mt-2 rounded-sm border border-edge bg-ink/55 px-4 py-3">
                      {upd.error ? (
                        <div className="text-[11.5px] text-ember break-all">
                          {t("updCheckFailed")}: {upd.error}
                        </div>
                      ) : upd.available ? (
                        <>
                          <div className="text-[11.5px] text-moss">
                            {t("updNew")} {upd.version} · {t("updCurrent")} {upd.current}
                          </div>
                          {upd.notes && (
                            <div className="text-[11px] text-ash mt-1.5 whitespace-pre-line">
                              {upd.notes}
                            </div>
                          )}
                          {updBusy && updPct !== null && (
                            <div className="mt-2">
                              <div className="h-1 rounded-sm bg-edge overflow-hidden">
                                <div
                                  className="h-full bg-moss transition-all"
                                  style={{ width: `${updPct}%` }}
                                />
                              </div>
                              <div className="text-[11px] text-ash mt-1">
                                {t("updDownloading")} {updPct}%
                              </div>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={onUpdateInstall}
                            disabled={updBusy}
                            className="mt-2 px-3 py-1.5 rounded-sm text-[12px] text-moss border border-moss/40 hover:bg-moss/10 transition disabled:opacity-40"
                          >
                            {updBusy && updPct !== null
                              ? `${t("updDownloading")} ${updPct}%`
                              : t("updInstall")}
                          </button>
                        </>
                      ) : (
                        <div className="text-[11.5px] text-ash">
                          {t("updUpToDate")}
                          {upd.current ? ` (${upd.current})` : ""}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="py-2.5">
                  <div className="text-[13px] text-bone mb-0.5">{t("allowlist")}</div>
                  <div className="text-[11.5px] text-ash mb-2">{t("allowlistHint")}</div>
                  <div className="flex items-center gap-2">
                    <input
                      value={ipList}
                      onChange={(e) => setIpList(e.target.value)}
                      placeholder={t("allowlistPlaceholder")}
                      spellCheck={false}
                      className="flex-1 min-w-0 bg-ink/55 border border-edge rounded-sm px-3 py-1.5 text-[12px] text-bone outline-none focus:border-moss/50 placeholder:text-ash/60 transition"
                    />
                    <button
                      type="button"
                      onClick={onSaveAllowlist}
                      className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-moss border border-moss/40 hover:bg-moss/10 transition"
                    >
                      {t("allowlistApply")}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* footer */}
        <footer className="mt-9 flex items-center justify-between text-[12px] text-ash">
          <span className="flex items-center gap-2">
            <span className="pulse-dot dot-on" style={{ width: 5, height: 5 }} />
            {t("foot")}
          </span>
          <span className="mono-badge">{t("ver")}</span>
        </footer>
      </div>
      </div>

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-sm panel text-[12px] text-bone fade-up">
          {toast}
        </div>
      )}
    </div>
  );
}