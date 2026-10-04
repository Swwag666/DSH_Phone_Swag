# DSH Phone: правки `server.rs` и `lib.rs` (H7, M5, L1, L2, L6, L7)

Изменены **только** два файла:
- `dsh-phone-desktop/src-tauri/src/server.rs`
- `dsh-phone-desktop/src-tauri/src/lib.rs`

`cargo` не запускался (по заданию). Свежие правки (`ShutdownOnDrop`, `staging_cleanup_loop(gw, stop)`,
`spawn_loopback_http(gw, port, stop)`) сохранены и не сломаны.

---

## H7 — мёртвый листенер выглядел как работающий узел

**Было.** При ошибке бинда `serve_http` просто возвращался, `serve` завершался, но `RunningServer`
оставался в `ServerState`: `is_running()` → `true` (проверяла только `is_some()`), `status_of()`
печатал `running: true` с растущим `uptime_seconds`, а `do_start()` навсегда уходил в ранний return.
Плюс асимметрия: «TLS-конфиг не собрался» → fallback на HTTP, «TLS-листенер не забиндился» → тишина.

**Стало.**

`lib.rs`:
- в `RunningServer` добавлено поле `alive: Arc<AtomicBool>`;
- хелпер `slot_alive(s) = s.alive.load(SeqCst) && !s.handle.is_finished()`;
- `status_of()`: `running: slot_alive(s)`, `uptime_seconds: 0` у мёртвого слота,
  `tls_serving: None` у мёртвого слота (иначе `Some("https"/"http")`, как раньше);
- `is_running()` → `map(slot_alive).unwrap_or(false)`;
- `take_and_signal()` (общая часть `stop_inner`/`stop_and_wait`) дополнительно гасит `alive`;
- `restart_if_running()` теперь смотрит на **наличие слота**, а не на `is_running`: если узел умер
  на бинде, рестарт по смене конфига/TLS его поднимет (иначе H7-фикс заблокировал бы восстановление).

`server.rs`:
- `serve(gw, stop, alive: Arc<AtomicBool>)`;
- `serve_http(app, addr, stop, alive)` ставит `alive = false` перед `return` на ошибке бинда
  и после возврата из `axum::serve` (shutdown/ошибка — листенер больше не обслуживает порт);
- роутер вынесен в `fn build_router(gw: &Arc<Gateway>) -> Router`, потому что при ошибке TLS-бинда
  нужен второй такой же роутер (первый уже уехал внутрь `axum_server` и повторно не используется);
- TLS-ветка: при `Err(e)` от `bind_rustls(...).serve(...)` теперь пишется `tls_runtime_error`
  **и** делается тот же fallback `serve_http(build_router(&gw), addr, stop, alive)`, что и при
  ошибке конфигурации. Внешний `stop` — `watch::Receiver`, он дёшево клонируется, поэтому
  копия уходит в задачу `h2.graceful_shutdown(...)`, а оригинал остаётся для fallback'а.

Осталось осознанно: в момент fallback'а loopback-листенер на `port+1` уже заспавнен и продолжает
жить (он loopback-only, те же хендлеры, останавливается drop-guard'ом при выходе из `serve`).
Это избыточно, но не вредно; убирать его «задним числом» не стал, чтобы не трогать рабочую
логику плагина-композера.

## M5 — память: attachment и upload

**attachment** (`server.rs ~151`): перед чтением делается `tokio::fs::metadata(&path)`, размер
сверяется с `gw.cfg.max_attachment_bytes`, при превышении — `413 PAYLOAD_TOO_LARGE`; отсутствующий
файл по-прежнему `404`. Раньше объект читался в память целиком **без всякого ограничения**:
гигантский/битый файл в сторе означал гигантский буфер в tokio-worker'е на каждый запрос картинки.

**upload**:
- `DefaultBodyLimit` больше не захардкожен в `80 * 1024 * 1024`, а считается в `build_router`:
  `encoded_budget(max_attachment_bytes) + 64 KiB`, где `encoded_budget(n) = n*4/3 + 1024`
  (все арифметические операции `saturating_*`). При дефолте 50 MiB лимит тела ≈ 66.8 MiB вместо 80 MiB;
- проверка `b.data.len() > encoded_budget(...)` выполняется **до** `base64::decode` → `413`;
  прежняя проверка декодированного размера оставлена как вторая линия;
- `sha256_hex` + `write_staging` унесены в один `tokio::task::spawn_blocking` (см. L7),
  ошибка `JoinError` → `500`.

**Что НЕ сделано и почему (важно для родителя).** Настоящего стриминга отдачи файла
(`tokio_util::io::ReaderStream` + `Body::from_stream`) нет: `tokio-util` **не объявлен** в
`src-tauri/Cargo.toml`, а других типов, реализующих `futures_core::Stream`, в прямых зависимостях
нет (`axum`/`tokio`/`reqwest` его не ре-экспортируют), и руками реализовать `Stream` нельзя —
трейт неоткуда импортировать. Задание запрещало трогать другие файлы, поэтому `Cargo.toml` не правил.
Чтобы добить M5 полностью, нужно добавить в `[dependencies]`
`tokio-util = { version = "0.7", features = ["io"] }` и переписать хвост `attachment` на
`ReaderStream::new(tokio::fs::File)` + `Body::from_stream` + явный `Content-Length` из `meta.len()`.
Сейчас копия в памяти ровно одна (`Body::from(Vec<u8>)` в axum 0.7 забирает аллокацию без копирования)
и её размер ограничен `max_attachment_bytes`.

## L1 — теряющийся сигнал остановки

`shutdown: tokio::sync::mpsc::Sender<()>` + канал ёмкости 1 + `let _ = try_send(())` заменены на
`tokio::sync::watch::Sender<bool>` / `watch::channel(false)` и `send(true)`.

Согласованные изменения типов (это единственное место, где сигнатура `serve` поменялась):
- `server::serve(gw: Arc<Gateway>, stop: tokio::sync::watch::Receiver<bool>, alive: Arc<AtomicBool>)`;
- `serve_http(app: Router, addr: SocketAddr, stop: watch::Receiver<bool>, alive: Arc<AtomicBool>)`;
- вместо `rx.recv().await` везде `let _ = stop.wait_for(|v| *v).await;` — `Err` (отправитель сброшен,
  т.е. `RunningServer` заменён/удалён) трактуется как команда остановиться;
- вызов в `do_start`: `let (tx, rx) = tokio::sync::watch::channel(false);` →
  `spawn(server::serve(gw.clone(), rx, alive.clone()))`, `shutdown: tx`.
- Внутренний канал `ShutdownOnDrop`/`stop_rx` (staging-loop, loopback) **не менялся** — он и был watch.

Побочный эффект, который стоит знать: при перезаписи мёртвого слота в `do_start` старый
`watch::Sender` дропается, и старый `serve` (если вдруг ещё жив) получает `Err` из `wait_for`
и корректно завершается — сирот не остаётся.

## L2 — `thread::sleep(400ms)` в синхронной команде

Добавлена `stop_and_wait(state, graceful)`:
1. `take_and_signal` шлёт `true` в watch;
2. опрос `handle.is_finished()` с шагом 10 мс до истечения `graceful` (300 мс, как было) —
   idle-узел освобождает порт за десятки миллисекунд, а не за фиксированные 400;
3. `handle.abort()` + abort фоновых задач;
4. второй опрос `is_finished()` с бюджетом 500 мс — ждём фактического снятия задачи с воркера,
   чтобы `do_start` не биндился в занятый порт.

`block_on` не использовался намеренно: синхронные команды tauri исполняются на blocking-потоке того
же рантайма, и `Handle::block_on` там паникует. `stop_inner` (asyn­c-вариант через `spawn`) сохранён
для `stop_server` и `update_install`, где ждать не нужно.

Реалистичная оценка выигрыша: если в момент остановки висит long-poll `/api/events` (до 20 с),
graceful drain за 300 мс не завершится и мы по-прежнему пройдём весь бюджет + abort; на пустом
узле рестарт вместо 400 мс занимает ~10–30 мс. Магическая пауза заменена реальным ожиданием
состояния задачи — это и было требованием.

## L6 — `events()`: порядок borrow/collect

`let _ = rx.borrow();` (не помечает поколение прочитанным, фактически no-op) заменено на
`let _ = rx.borrow_and_update();` **до** `collect_events(since)`. Теперь событие, прилетевшее между
подпиской и чтением буфера, guaranteed разбудит `rx.changed()` и буфер будет перечитан: вместо дыры
в доставке получаем лишний цикл. Дублей в ответе это не создаёт — `collect_events(since)` фильтрует
буфер по курсору клиента, а `evs` перезаписывается, а не дополняется.

Отключение клиента во время 20-секундного ожидания отдельной веткой `select!` не закрыто: в axum 0.7
хендлер не получает сигнала о закрытии соединения, его просто отменяет hyper (connection task
дропает future сервиса, когда читает EOF/RST), что и прерывает `tokio::select!` целиком. Добавлять
«ветку на закрытие» было бы нечем — доступного канала/токена в этой версии axum нет.

## L7 — блокирующий `std::fs` на tokio-worker'е

- `upload`: `sha256_hex` + `write_staging` → `tokio::task::spawn_blocking` (буфер `raw` мувается
  в замыкание, лишних копий нет);
- `staging_cleanup_loop`: `cleanup_staging` → `spawn_blocking` (клон `stage` на каждой итерации,
  `JoinError`/паника → `unwrap_or(0)`). Сама `cleanup_staging` осталась синхронной — её вызывают
  существующие тесты `staging_cleanup_respects_retention` и `staging_cleanup_keeps_directories_untouched`,
  которые я не менял.

---

## Места, где я не уверен на 100 % (нужна проверка сборкой)

1. **`DefaultBodyLimit::max(body_limit as usize)`** — каст `u64 → usize`. На 64-битной цели корректно;
   clippy может ругнуться на `cast_possible_truncation` (не ошибка компиляции).
2. **`axum_server::bind_rustls(...).serve(...)` с роутером, построенным на лету** —
   `build_router(&gw)` возвращает `Router` (т.е. `Router<()>` после `.with_state`), как и прежний
   `let app = ...`; `into_make_service_with_connect_info::<SocketAddr>()` тот же. Ожидаю, что типы
   совпадают, но именно здесь стоит смотреть на первую ошибку компилятора, если она будет.
3. **`Option::inspect`** в `take_and_signal` — стабилен с 1.76, MSRV в `Cargo.toml` = 1.90, так что
   должно быть хорошо.
4. **`tokio::task::spawn_blocking`** требует фичу `rt` — она входит в `rt-multi-thread`, которая
   объявлена. Аналогично `tokio::fs::metadata` живёт в той же фиче `fs`, что уже использовавшийся
   `tokio::fs::read` (включена транзитивно через tauri) — нового риска не добавляет.
5. **`tauri::async_runtime::JoinHandle::is_finished()`** — это алиас на `tokio::task::JoinHandle`,
   метод есть с tokio 1.21. Если tauri когда-нибудь подменит тип, `slot_alive` и `stop_and_wait`
   не соберутся — это единственные два места, которые его используют.
6. **Смена типа shutdown-канала** — самый рискованный пункт по влиянию: если где-то ещё (вне этих двух
   файлов) кто-то держит `RunningServer.shutdown` как `mpsc::Sender<()>`, сборка упадёт. Я grep'ом
   по всему `src-tauri` проверил: `shutdown` упоминается только в `lib.rs`/`server.rs`
   (и несвязанный `w.shutdown()` в `bridge.rs`), `main.rs` состояние не трогает.
7. **Фронтенд и `tls_serving: null` при мёртвом слоте** — ветка `None` (узел остановлен) и раньше
   отдавала `null`, так что PWA/дашборд такой случай уже обрабатывают; файлы фронта не менял.
