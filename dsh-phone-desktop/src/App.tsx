import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppConfig,
  ServerStatus,
  TailscaleStatus,
  getConfig,
  regenerateToken,
  serverStatus,
  startServer,
  stopServer,
  tailscaleStatus,
  tailscaleInstall,
  getAutostart,
  setAutostart,
  setStartHidden,
  setTlsEnabled,
  setAllowedIps,
} from "./lib/bridge";

type Lang = "ru" | "en";

const dict: Record<Lang, Record<string, string>> = {
  ru: {
    sub: "локальный мост · телефон ↔ ПК",
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
    note: "Без запущенного DSH Desktop на этом ПК узел молчит. Плагин Agents Anywhere — единственный пропуск.",
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
    ver: "DSH Phone · v0.1",
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
    autoStart: "Автозапуск с Windows",
    autoStartHint: "узел поднимается при входе в систему, свёрнуто в трее",
    autoStartOn: "автозапуск включён",
    autoStartOff: "автозапуск выключен",
    startHidden: "Стартовать свёрнуто",
    startHiddenHint: "при запуске только значок в трее, без окна",
    startHiddenOn: "старт в трее включён",
    startHiddenOff: "старт с окном",
    tls: "TLS поверх tailscale",
    tlsHint: "самоподписанный серт, белый список IP, отсечка чужих даже в тейлнете · нужен рестарт узла",
    tlsOn: "TLS включён",
    tlsOff: "TLS выключен",
    allowlist: "Белый список IP",
    allowlistHint: "кто из тейлнета достучится. пусто = все. можно CIDR",
    allowlistPlaceholder: "100.75.97.90, 100.64.0.0/10",
    allowlistApply: "применить",
    allowlistSaved: "список сохранён",
    fingerprint: "отпечаток серта",
  },
  en: {
    sub: "local bridge · phone ↔ PC",
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
    note: "Without DSH Desktop running on this PC the node stays silent. The Agents Anywhere plugin is the only way in.",
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
    ver: "DSH Phone · v0.1",
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
    autoStart: "Start with Windows",
    autoStartHint: "brings the node up at login, minimized to tray",
    autoStartOn: "autostart on",
    autoStartOff: "autostart off",
    startHidden: "Start minimized",
    startHiddenHint: "only the tray icon on launch, no window",
    startHiddenOn: "tray start on",
    startHiddenOff: "window start on",
    tls: "TLS over tailscale",
    tlsHint: "self-signed cert, IP allowlist, drops strangers even inside the tailnet · node restart required",
    tlsOn: "TLS on",
    tlsOff: "TLS off",
    allowlist: "IP allowlist",
    allowlistHint: "who in the tailnet can reach it. empty = everyone. CIDR allowed",
    allowlistPlaceholder: "100.75.97.90, 100.64.0.0/10",
    allowlistApply: "apply",
    allowlistSaved: "allowlist saved",
    fingerprint: "cert fingerprint",
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

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [ts, setTs] = useState<TailscaleStatus | null>(null);
  const [tsBusy, setTsBusy] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [autostart, setAutostartState] = useState(false);
  const [ipList, setIpList] = useState("");
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
      fireToast(c.tls_enabled ? t("tlsOn") : t("tlsOff"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
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

  useEffect(() => {
    getConfig()
      .then((c) => {
        setCfg(c);
        setIpList((c.allowed_ips ?? []).join(", "));
      })
      .catch((e) => fireToast(t("errPrefix") + e));
    refreshTailscale();
    getAutostart().then(setAutostartState).catch(() => {});
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
      fireToast(t("tRegen"));
    } catch (e) {
      fireToast(t("errPrefix") + e);
    } finally {
      setBusy(false);
    }
  };

  const url = cfg ? `http://${cfg.tailscale_ip}:${cfg.listen_port}` : "";
  const running = status?.running ?? false;

  return (
    <div className="relative h-full w-full overflow-y-auto">
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
                {ts && !ts.installed && (
                  <button
                    onClick={onInstall}
                    disabled={tsBusy}
                    className="shrink-0 px-3 py-1.5 rounded-sm text-[12px] text-moss border border-moss/40 hover:bg-moss/10 transition disabled:opacity-40"
                  >
                    {t("tsInstall")}
                  </button>
                )}
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
                <div className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <div className="text-[13px] text-bone">{t("tls")}</div>
                    <div className="text-[11.5px] text-ash">{t("tlsHint")}</div>
                    {cfg?.tls_enabled && status?.tls_sha256 && (
                      <div className="text-[11px] text-ash mt-1.5">
                        {t("fingerprint")}{" "}
                        <span className="mono-badge">{status.tls_sha256}</span>
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={onToggleTls} className={"toggle" + (cfg?.tls_enabled ? " on" : "")} aria-pressed={!!cfg?.tls_enabled}>
                    <span className="knob" />
                  </button>
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

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-sm panel text-[12px] text-bone fade-up">
          {toast}
        </div>
      )}
    </div>
  );
}