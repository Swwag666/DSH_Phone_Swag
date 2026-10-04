# Фиксы M4 (push.rs / config.rs) и L9 (tls.rs)

Правки внесены **только** в три файла:

- `dsh-phone-desktop/src-tauri/src/push.rs`
- `dsh-phone-desktop/src-tauri/src/config.rs`
- `dsh-phone-desktop/src-tauri/src/tls.rs`

`cargo` не запускался (по заданию — сборку проверит родительский агент). Свежие правки
в push.rs (`urgency_for`, TTL/cap в `add_subscription`, тест
`approval_tag_is_high_urgency_others_normal`) сохранены дословно, изменилась только
«обёртка» вокруг них (тело `add_subscription` переехало внутрь замыкания `run_blocking`).

---

## M4 — блокирующий spawn tailscale.exe под глобальным мьютексом + неограниченная конкурентность dispatch

### 1. config.rs: детект IP убран из горячего пути `load_or_init()`

Старый код: `load_or_init()` на каждом вызове делал `c.tailscale_ip = tailscale_ip()`,
а `tailscale_ip()` блокирующе спавнила `tailscale.exe ip -4` и ждала `.output()`
(плюс fallback на `get_if_addrs`). Поскольку `load_or_init()` вызывается из push.rs
под `CONFIG_LOCK`, получался синхронный запуск внешнего процесса под глобальным
мьютексом на tokio-worker'е — на каждый `session.turnEnded` / `waiting_approval`
и на каждый HTTP-запрос телефона.

Новая структура (config.rs ~303–378):

```rust
const TS_IP_TTL: Duration = Duration::from_secs(30);
static TS_IP_CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

fn ts_ip_cache_get() -> Option<String>        // только свежее значение, без детекта
fn ts_ip_cache_put(ip: &str)
pub fn tailscale_ip() -> String               // ВСЕГДА свежий детект + обновляет кеш
pub fn cached_tailscale_ip() -> String        // кеш; детект лишь когда пуст/протух
fn detect_tailscale_ip() -> String            // прежнее тело tailscale_ip()
```

- `load_or_init()` (обе ветки: успешный парсинг и salvage) и `generate()` теперь берут
  `cached_tailscale_ip()` → внешний процесс стартует **не чаще раза в 30 с на процесс**,
  а не на каждое перечитывание конфига.
- Публичная `tailscale_ip()` осталась «всегда свежей» (инвалидирует/обновляет кеш),
  потому что её единственные внешние потребители — `lib.rs::heal_tailnet()`
  (строки 262 и 276), где она вызывается **сразу после** `debug rebind`/`debug restun`:
  кешированное значение там было бы заведомо неверным. Поведение heal_tailnet не изменилось.

**Осознанное отклонение от формулировки аудита.** Аудит предлагал «убрать `tailscale_ip()`
из `load_or_init()` совсем». Полное удаление сломало бы функциональность, которую я не
имею права править (файлы вне списка): `cfg.tailscale_ip` читают

- `qr.rs::payload()` (URL/хост в QR для подключения телефона) — вызывается из
  `lib.rs::connect_qr()` ровно как `load_or_init()` → `qr::payload(&c)`;
- `tls.rs::rustls_config()` — SAN листового сертификата + сравнение с маркером
  `tls_cert.ip` (перевыпуск цепочки при смене адреса);
- `server.rs:97` — поле `"tailscale"` в статусе узла.

Ни один из них не зовёт `config::tailscale_ip()` напрямую, поэтому «отдельный кеш для
QR/health» при пустом поле в конфиге показывал бы телефону устаревший/loopback адрес,
а TLS выпускал бы лист с неверным SAN. Отсюда компромисс: детект остаётся в
`load_or_init()`, но через TTL-кеш (не чаще 1 раза в 30 с на процесс) **и** весь
блокирующий участок вынесен с tokio-worker'а (п.3). Если родительский агент готов
править `lib.rs`/`qr.rs`, вариант «строго без детекта в load_or_init» — заменить там
`connect_qr()`/`do_start()` на явный `config::tailscale_ip()`; тогда в `load_or_init()`
можно оставлять `tailscale_ip_cached()`-Only путь.

Побочный плюс: `cargo test` в config.rs больше не спавнит `tailscale.exe` на каждый
`AppConfig::generate()` (их там ~10 на тестовый процесс) — только один раз.

### 2. push.rs: ограничитель конкурентности dispatch

```rust
const MAX_INFLIGHT_DISPATCH: usize = 4;

fn dispatch_permits() -> &'static Arc<tokio::sync::Semaphore> {
    static PERMITS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    PERMITS.get_or_init(|| Arc::new(Semaphore::new(MAX_INFLIGHT_DISPATCH)))
}
```

`dispatch()` спавнит задачу как раньше (сигнатура `pub fn dispatch(&self, notice: &Notice)`
не изменилась — её зовут `lib.rs:552` и `gateway.rs:272`), но внутри первым делом берёт
`acquire_owned().await`, и permit живёт до конца доставки. Всплеск событий теперь
выстраивается в очередь максимум из 4 одновременных доставок вместо неограниченного
числа задач с собственными reqwest-клиентами и собственными перечитываниями конфига.

Замечание: задачи при всплеске всё равно создаются (и ждут permit), а не отбрасываются —
уведомление не теряется. Если нужна именно «отбрасывающая» семантика, это
`try_acquire` — не делал, чтобы не терять `appr-*` (high urgency).

### 3. push.rs: CONFIG_LOCK и диск вынесены с tokio-worker'а

- Выделено `type PushState = (Vec<PushSubscription>, (bool, String, String, Option<String>), Option<VapidKeys>)`
  и `fn read_push_state() -> PushState` — чтение конфига под замком одним заходом.
  В `dispatch()` оно вызывается через `tokio::task::spawn_blocking(read_push_state).await`;
  ошибка join'а логируется, доставка прерывается (как и раньше при недоступном конфиге).
- `remove_subscription` / `add_subscription` / `clear_subscriptions` обёрнуты в новый
  хелпер `run_blocking(f)`:

```rust
fn run_blocking<R>(f: impl FnOnce() -> R) -> R {
    let multi_thread = match tokio::runtime::Handle::try_current() {
        Ok(h) => h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread,
        Err(_) => false,
    };
    if multi_thread { tokio::task::block_in_place(f) } else { f() }
}
```

  Почему `block_in_place`, а не `spawn_blocking`: эти методы **синхронные по сигнатуре**,
  и их нельзя сделать `async` — вызовы живут в файлах, которые мне править запрещено
  (`server.rs:611/622` из async-хендлеров `push_subscribe`/`push_unsubscribe`,
  `lib.rs` для `clear_subscriptions`). Fire-and-forget `spawn_blocking` без ожидания
  создавал бы гонку «телефон получил 200 OK, а подписка ещё не на диске» (и следующий
  `dispatch` мог бы её не увидеть). `block_in_place` освобождает worker (остальные задачи
  уезжают на другой worker), сохраняя синхронную семантику и порядок записи.
  Проверка flavor'а нужна потому, что `block_in_place` паникует на current-thread runtime,
  а вне tokio (`tauri`-команды, юнит-тесты) работа выполняется напрямую.
- `.unwrap()` на мьютексе заменён на `unwrap_or_else(|e| e.into_inner())` во всех четырёх
  местах: паника внутри блокирующей задачи/хендлера больше не отравляет `CONFIG_LOCK`
  насмерть для всего процесса.

**Инвариант «CONFIG_LOCK не удерживается через `.await`» сохранён и усилен**: в `dispatch()`
замок теперь берётся внутри `read_push_state()`, который целиком выполняется в
`spawn_blocking` (там нет и не может быть `.await`), а permit семафора берётся **до**
чтения конфига и не пересекается с замком. В `add/remove/clear_subscription` замок —
внутри синхронного замыкания. Комментарий с этим правилом добавлен к `static CONFIG_LOCK`.

### Что осталось как было (осознанно)

`AppConfig::load_or_init()` при успешном парсинге делает `let _ = c.save()`, то есть
**перезаписывает config.json на каждое чтение** (в т.ч. на каждый `dispatch` и каждый
`push_info`/`push_subscribe`). Это отдельная находка (лишняя запись на диск +
переписывание всего файла), но её фикс меняет семантику `load_or_init` для всех
потребителей в `lib.rs`/`server.rs`, которые я трогать не имею права. Сейчас ущерб
ограничен: запись идёт на blocking-пуле, а не на worker'е. Рекомендую отдельной задачей:
`save()` только когда конфиг реально изменился (dirty-флаг).

---

## L9 — tls.rs: `cert_sha256()` без кеша на каждый поллинг дашборда

`status_of()` в `lib.rs` (поллинг раз в 2 с) и `server.rs:108` (`/info`) и `server.rs:790`
зовут `cert_sha256()`, которая каждый раз делала `fs::read` цепочки + разбор PEM +
SHA-256. Добавлен кеш по `(mtime, len)` файла сертификата (tls.rs ~154–190):

```rust
static SHA_CACHE: Mutex<Option<((SystemTime, u64), Option<String>)>> = Mutex::new(None);

pub fn cert_sha256() -> Option<String> {
    let cp = cert_path();
    let meta = std::fs::metadata(&cp).ok()?;          // нет файла -> None, кеш не трогаем
    let stamp = (meta.modified().ok()?, meta.len());
    { let g = SHA_CACHE.lock()...; if let Some((cached, sha)) = g.as_ref() {
        if *cached == stamp { return sha.clone(); } } }
    let sha = compute_cert_sha256(&cp);               // прежнее тело функции
    *SHA_CACHE.lock()... = Some((stamp, sha.clone()));
    sha
}
```

- Сигнатура `pub fn cert_sha256() -> Option<String>` не изменилась (её зовут три места
  вне tls.rs).
- Ключ кеша — `mtime` (по заданию) плюс `len` как дешёвая страховка от совпавшего
  тика mtime при перевыпуске. `ensure_chain()` перезаписывает `tls_cert.pem` →
  stamp меняется → кеш сам инвалидируется, явной инвалидации не нужно.
- Закешированный `None` (битый/непарсящийся PEM) тоже хранится по stamp — иначе
  повреждённый файл давал бы полный парсинг на каждый поллинг.
- `std::sync::Mutex`, под замком нет `.await` и нет ввода-вывода (только сравнение и clone).

### Бонус в том же файле (в пределах разрешённого скоупа)

`rustls_config()` — `async`, но вызывал `ensure_chain()` напрямую на worker'е, а внутри
`ensure_chain`: `fs::create_dir_all`/`fs::write`, генерация двух ключевых пар rcgen и
`crate::tailscale::magicdns_name()`, который блокирующе спавнит `tailscale status --json`.
Это тот же класс проблемы, что и M4. Обёрнуто в `spawn_blocking`:

```rust
let owned = cfg.clone();
tokio::task::spawn_blocking(move || ensure_chain(&owned, ip))
    .await
    .map_err(|e| e.to_string())??;
```

(`AppConfig: Clone`, `IpAddr: Copy + Send`; двойной `?` — JoinError и внутренний
`Result<(), String>`.) Если родительский агент хочет минимальный дифф — этот блок
можно откатить, на M4/L9 он не влияет.

---

## Проверка компилируемости (статически, без cargo)

Проверено по типам и зависимостям:

- `Cargo.toml`: `tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "time", "sync", "io-util"] }` —
  есть всё нужное: `tokio::sync::Semaphore` + `acquire_owned` (`sync`),
  `tokio::task::spawn_blocking`/`block_in_place` (`rt-multi-thread`),
  `tokio::runtime::Handle::try_current`/`runtime_flavor`/`RuntimeFlavor` (`rt`, входит в `rt-multi-thread`).
- `std::sync::OnceLock` / `Mutex::new` в `static` — MSRV 1.90 в Cargo.toml, нормально.
- `std::sync::Arc::clone(dispatch_permits()).acquire_owned()` написано явно
  (а не `.clone()` на `&Arc<_>`), чтобы не зависеть от тонкостей method resolution.
- Возврат `PushState` из `spawn_blocking`: все поля `Send + 'static`.
- `run_blocking` без `Send`-ограничения на замыкании — `block_in_place` его и не требует.
- В `add_subscription` тело переехало в `move`-замыкание: `sub` захватывается по значению,
  `retain(|s| ... sub.endpoint ...)` заимствует `sub` неизменяемо и заканчивается до
  `push(sub)` — как и в исходной версии.
- `sha.clone()` в tls.rs даёт `Option<String>` (приёмник `&Option<String>`),
  `*cached == stamp` — `PartialEq` для `(SystemTime, u64)` есть.
- Публичные сигнатуры не менялись нигде: `dispatch`, `add_subscription`,
  `remove_subscription`, `clear_subscriptions`, `cert_sha256`, `rustls_config`,
  `tailscale_ip`, `load_or_init`, `generate`, `save`. Новое публичное имя —
  `config::cached_tailscale_ip()` (используется внутри config.rs, `dead_code` не будет).

### Где я не уверен на 100 %

1. **`tls.rs`: `tokio::task::spawn_blocking(...).await.map_err(|e| e.to_string())??`** —
   единственный «неочевидный» дифф: двойной `?` в функции, возвращающей
   `Result<RustlsConfig, String>`. По типам сходится (`JoinError → String`, затем
   `Result<(), String>`), но это бонусная правка — при любом сомнении её можно откатить
   одной заменой на `ensure_chain(cfg, ip)?;`.
2. **Предупреждения (не ошибки) возможны** за unused import/переменные — я их не вижу,
   но `cargo build` с `-D warnings` в CI мог бы на них ругнуться. Единственный кандидат:
   ничего нового не импортировалось на верхнем уровне (всё через полные пути), так что
   риск минимальный.
3. **Поведение `block_in_place` внутри axum-хендлера**: работает только на
   multi-thread runtime. Tauri 2 по умолчанию поднимает multi-thread tokio
   (`tauri::async_runtime`), и `serve()` spawned через него же, так что ветка
   `block_in_place` будет выбрана; если бы runtime оказался current-thread, код
   деградирует в обычное синхронное исполнение (как сейчас), без паники.
4. **TTL 30 с для tailscale IP**: подобрано на глаз. Если смена адреса tailnet должна
   подхватываться QR мгновенно, можно уменьшить до 5–10 с — цена детекта теперь
   ограничена одним spawn'ом на окно, а не одним на запрос.

## Итог по находкам

- **M4**: закрыт. Нет неограниченного спавна (семафор на 4), нет блокирующего запуска
  внешнего процесса и дискового ввода-вывода на tokio-worker'е (spawn_blocking в
  dispatch, block_in_place в add/remove/clear), детект IP не чаще раза в 30 с,
  CONFIG_LOCK не пересекается с `.await`, отравление мьютекса больше не фатально.
- **L9**: закрыт. `cert_sha256()` при неизменном файле — это `fs::metadata` + сравнение
  кортежа + `String::clone`, без чтения PEM и без SHA-256.
