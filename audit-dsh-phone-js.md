# Статический аудит клиентского JS DSH Phone (утечки памяти / баги)

Дата: 2026-08-03. Метод: только чтение кода, ничего не запускалось.
Файлы: `dsh-phone/web/app.js` (1758 строк), `dsh-phone/web/sw.js` (134), `dsh-phone/gui/draftsync-desktop.js` (295), `dsh-phone/plugin/dsh-draft-sync/lib/client.js` (453).
Дополнительно просмотрены (контекст): `dsh-phone/web/draftsync.js`, `dsh-phone/web/index.html`, `dsh-phone/plugin/dsh-draft-sync/lib/index.js`.

Сводка по серьёзности: critical — 2 (P1, P2/D2 в gui-версии), high — 8, medium — 12, low — 8, informational — 5.

---

## 1. `dsh-phone/web/app.js`

### A1 — high — Двойной (и более) цикл поллинга событий: guard не работает
Строки: `1658-1678` (pollLoop; `pollTimer = setTimeout(pollLoop, delay)` на **1675**), guard `startPolling() { if (!pollTimer) pollLoop(); }` на **1678**, вызов `startPolling()` из `tryAuth` на **187**, обработчик `$("auth-go").onclick` **205-208**, `boot()` **1747-1749**.

Суть: `pollLoop` — `async`, а `pollTimer` присваивается только **после** завершения первого `fetch`. Пока первый `/api/events` в полёте, `pollTimer === null`, поэтому второй вызов `startPolling()` запускает **вторую независимую цепочку**. Обе цепочки самовоспроизводятся (1675) и перезаписывают одну переменную `pollTimer` — обнаружить и остановить дубль afterwards невозможно. Реальные триггеры: двойной тап «подключить» на телефоне (кнопка не блокируется), либо `boot()` + ручной тап.

Последствия: удвоенная/утроенная частота запросов к узлу; дубли обработки событий (повторные `notifyNow` на **1650**, повторные `refreshActiveChat` на **1653**); гонка за общий курсор `since` (**11**, **1664**) — две цепочки поочерёдно сдвигают курсор, из-за чего часть событий обрабатывается вперемешку или теряется; `status()` дёргается из двух циклов.

Фикс: отдельный флаг жизни цикла + хранение id таймера:
```js
let pollOn = false;
function startPolling() { if (pollOn) return; pollOn = true; pollLoop(); }
function stopPolling() { pollOn = false; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
// в pollLoop: первая строка — if (!pollOn) return; последняя — if (pollOn) pollTimer = setTimeout(pollLoop, delay);
```
Дополнительно: `$("auth-go").disabled = true` на время `tryAuth` (с разблокировкой в `finally`) и guard `if (authInFlight) return;`.

### A2 — high — Ни одного `AbortController`/таймаута: long-poll и refresh не отменяются
Строки: `api()` **163-169**, `watch()` **171-177**, fetch событий **1661-1663**, `refreshActiveChat` **1697-1705**, `scheduleRefresh` **1680-1695**, `loadFullHistory` **319-338**, `/api/upload` **1104-1108**, `session.getNotices` **913**.

Суть: `signal` не передаётся ни в один fetch. `refreshActiveChat` вызывается по таймеру каждые 2.5-7 с (**1684-1691**) и **дополнительно** из `openChat` (**309**), `submitNotice` (**789**, **792**) и `turnEnded` (**1653**) — без in-flight guard. На медленной мобильной сети запросы (каждый — до 200 айтемов) накапливаются лавинообразно; `loadFullHistory` делает до 300 последовательных запросов без возможности отмены. При уходе со страницы long-poll остаётся висеть.

Фикс: общий контроллер на «поколение чата» (`chatAbort`) — `abort()` в `openChat`/`back`/`pagehide`; `signal` во все fetch; in-flight флаг для `refreshActiveChat`; таймаут (`AbortSignal.timeout(15000)` или ручной `setTimeout`+`abort`).

### A3 — high — Гонки смены сессии: данные чужого чата пишутся в текущий и в кэш
Строки: `openChat` **279-316** (особенно **303-310**), `loadFullHistory` **319-338** (`params.sessionId = activeSession` читается **на каждой итерации** — 324), `refreshActiveChat` **1699-1704**, `applyState` **673-697**, `mergeInto` **531-550**, `processEvent` **1629-1634**.

Суть: нигде не фиксируется, для какой сессии пришёл ответ. Если открыть чат A и быстро переключиться на B:
1. `loadFullHistory` продолжает читать **глобальный** `activeSession` → часть страниц запрашивается уже для B, массив `out` смешивает айтемы двух сессий.
2. В `.then` (**304-305**) `items.set(...)` вливает айтемы A в карту B, а `saveHistory(activeSession, list)` записывает историю A под ключ `dsh-phone-hist-B` — **стойкая порча localStorage-кэша**.
3. `refreshActiveChat`/`applyState` применяют state чата A к UI B (chat-meta, кнопка interrupt, approval-карточки, typewriter).
4. `processEvent` фильтрует по `ev.data.sessionId === activeSession` (1629, 1631), но события, пришедшие «вдогонку» за уже закрытую сессию, попадают в новый чат, если id совпал случайно; для `getNotices` (**913-932**) проверка только `if (!activeSession)` — без сверки sid.

Фикс: эпоха + sid:
```js
let chatEpoch = 0;
function openChat(s) { const sid = s.sessionId; const ep = ++chatEpoch; ... 
  loadFullHistory(sid).then(list => { if (ep !== chatEpoch || sid !== activeSession) return; ... });
}
```
Пропускать `sid` явным параметром во все запросы и сверять `ep/sid` в каждом `.then` (включая `refreshActiveChat`, `checkApproval`, `loadRemoteDraft`).

### A4 — high — Необработанные reject; при сетевом сбое теряется введённое сообщение и вложения
Строки: `api()` **168** (нет проверки `r.ok`; `r.json()` падает на HTML-ответе 502/странице ошибки), `$("composer").onsubmit` **716-747** (`.then` без `.catch`; поле очищено на **721**, `pendingAttachments` обнулён на **727**, восстановление есть только в ветке `!r.ok` — **739-744**), `retryLast` **390-396**, `$("interrupt").onclick` **749-753** (promise вообще брошен, `.then/.catch` отсутствуют), `pickModel` **981-984**, `pickPermission` **989-992**, вызовы `watch()` без catch **280**, **296**, **344**, `loadCatalog` **947-952** (при `ok:true`, но без `result` — TypeError), `submitNotice` **784-794** (catch есть — ок).

Суть: любой не-JSON ответ или обрыв сети → `unhandledrejection` (в PWA на iOS это ещё и молчаливый отказ), а в submit-пути текст и прикреплённые файлы теряются безвозвратно.

Фикс: в `api()` — `if (!r.ok) throw new Error("http " + r.status)` перед `.json()`; единый `.catch` на каждый вызов с показом статуса; в submit обернуть отправку в `try/catch` и в catch выполнить то же восстановление, что в ветке `!r.ok`.

### A5 — medium — История и DOM растут неограниченно, нет виртуализации
Строки: **7-9** (`items`/`rendered`/`nodeFor`), **318-338** («full history, no limit», до 300 страниц), `fullRender` **461-489**, `mergeInto` **531-550**, `computeLastUserText` **367-374**, `orderedItems` **1371-1373**, `refreshStats` **1375-1409** (`harvestUsage` обходит всё).

Суть: `items` и `nodeFor` (ссылки на живые DOM-узлы) растут линейно с длиной чата и никогда не подрезаются. Каждое live-событие вызывает `computeLastUserText()` — полный обход карты (**540**), а `fullRender`/`orderedItems` — копию + сортировку всего массива. На длинной сессии (тысячи tool-карточек) это и память, и деградация CPU на каждом тике поллинга.

Фикс: подрезать `items` до последних N (например 1500) с синхронным удалением из `rendered`/`nodeFor` и из DOM; кэшировать отсортированный массив с инвалидацией; считать `lastUserText` инкрементально; для очень длинных чатов — оконный рендер.

### A6 — medium — `pendingAttachments` и тяжёлые data-URL превью не освобождаются
Строки: **19**, `renderChips` **1075-1088** (`<img src="${a.preview}">` — **1081**), `handleFiles` **1090-1122** (`fullUrl` — **1101**, fallback `preview = fullUrl` — **1103**), **726-728**, `openChat` **279-316** (сброса нет), `$("back").onclick` **340-349** (сброса нет).

Суть: `preview` — data-URL; если `makeThumb` бросил, в `preview` попадает **полный base64 файла** (фото с телефона — единицы МБ) и держится в памяти + в DOM. Массив не очищается при смене/закрытии чата → вложения перетекают в другую сессию (риск отправить файл не в тот чат) и продолжают занимать память; `$("file-input")` сбрасывается только в конце `handleFiles`.

Фикс: очищать `pendingAttachments = []; renderChips();` в `openChat` и в `back`; никогда не класть `fullUrl` в `preview` (только thumb, иначе иконка); хранить `Blob` + `URL.createObjectURL` с `revokeObjectURL` при удалении чипа.

### A7 — high — Микрофон/интервал не освобождаются при ошибке записи; `recActive` застревает
Строки: `startVoiceMemo` **1215-1252** (getUserMedia **1218**, конструкторы **1224-1225**, `mediaRec.start()` **1248**, `mediaTimer = setInterval(...)` **1249-1251**, очистка **только** в `onstop` — **1235**), `stopVoiceMemo` **1211-1213**, `startVoice` **1269-1303** (`recActive = true` — **1270**, класс `rec` — **1272**, `catch` — **1302** без сброса).

Суть: если оба конструктора `MediaRecorder` бросят (неподдерживаемый mimeType, лимит дорожек) или `mediaRec.start()` бросит `InvalidStateError`, исключение покидает async-функцию (unhandled rejection), а дорожки потока из `getUserMedia` **не останавливаются** → микрофон остаётся включённым (системный индикатор, расход батареи), `mediaTimer` тикает вечно, `recActive === true` → кнопка навсегда в режиме «стоп». В SR-ветке `catch` на **1302** не сбрасывает `recActive` и класс `rec` — тот же залипон.

Фикс:
```js
try { mediaRec = ...; mediaRec.start(); }
catch (e) { stream.getTracks().forEach(t => t.stop()); recActive = false; $("mic").classList.remove("rec"); status("запись не началась: " + e.message); return; }
```
В `stopVoiceMemo` — дополнительно `clearInterval(mediaTimer); mediaTimer = null;`; в `catch` **1302** — сброс `recActive`/класса; авто-стоп записи по предельной длительности.

### A8 — medium — `checkApproval`: RPC на каждое state-событие, дубль уведомлений
Строки: `applyState` **694** → `checkApproval` **909-933** (`noticeSig` сравнивается и пишется **после** async-запроса — **923-925**, `notifyNow` — **928**).

Суть: нет in-flight guard, поэтому параллельные `getNotices` проходят проверку sig одновременно и выдают несколько системных уведомлений на один notice; плюс амплификация запросов (каждый poll с state = +1 RPC, а state приходит часто).

Фикс: флаг `approvalInFlight`, сохранять и сравнивать sig атомарно до/после запроса, дедуплицировать `notifyNow` по `nid` (Set показанных за сессию), вызывать `checkApproval` не чаще раза в N мс.

### A9 — medium-low — Полный rebuild списка сессий на каждое событие
Строки: `renderSessions` **211-257** (`el.innerHTML = ""` — **219**, `d.onclick` — **252**), вызовы: **1628** (processEvent `sessions`) и **1707-1712** (`limit: 1000`).

Суть: до 1000 узлов и 1000 замыканий пересоздаются каждый раз, когда узел присылает `sessions`, и каждые 7 с по `refreshTimer`. Это не утечка (старые узлы дропаются вместе со своими `onclick`), но заметный main-thread churn, сброс скролла/фокуса и лишний GC-мусор.

Фикс: сигнатура списка (hash по id+orderingTime+title) и пропуск перерисовки при совпадении; либо diff-рендер; ограничить `limit`.

### A10 — low/medium — localStorage растёт по числу сессий, квота глотается молча
Строки: `readUpTo` **22** + `markRead` **82-88** (объект на все сессии, перезаписывается целиком), `statsKey`/`loadStats`/`saveStats`/`bumpStat` **1306-1320**, `histKey`/`saveHistory` **96-102** (до 300 айтемов на сессию, старые никогда не удаляются), `sessCacheKey` **113-115** (500 сессий).

Суть: за месяцы набираются сотни ключей `dsh-phone-hist-*` и `dsh-phone-stats-*`. При исчерпании квоты **все** записи молча проглатываются `catch (_)` → кэш истории/статистика незаметно перестают работать.

Фикс: LRU-prune (держать данные последних N сессий, остальные `removeItem`), отдельно ловить `QuotaExceededError` и показывать статус/чистить самое старое.

### A11 — medium — Курсор `since` и состояние не сбрасываются при смене токена
Строки: **11**, **1664**, `tryAuth` **180-203**, `boot` **1735-1736**.

Суть: при перевязке на другой токен/узел (повторный QR) `since`, `sessions`, `items`, `bridgeOn` остаются от старой timeline → `?since=<старый ts>` может отсечь все новые события, а в списке показываются чужие сессии до первого `refreshSessions`.

Фикс: в `tryAuth` при успехе, если токен отличается от прежнего, — `since = 0; sessions = []; items.clear(); rendered.clear(); nodeFor.clear(); activeSession = null;`.

### A12 — low — `takeTokenFromHash`: очистка корректна, но regex узкий; при неудаче токен остаётся в поле
Строки: **1719-1730** (`history.replaceState` — **1727**), **1735-1736**, **1753**.

Суть: механизм очистки **есть и он правильный** (hash не уходит на сервер, `replaceState` стирает его сразу, без перезагрузки). Но шаблон `t=([A-Za-z0-9]+)` (**1722**) обрежет токен, содержащий `-`, `_`, `.` или `=` → ложное «токен не подошёл». При неудачном входе секрет записывается в видимое `token-input` (**1753**) и остаётся в DOM/автозаполнении.

Фикс: `[A-Za-z0-9_.\-]+` (или брать всё до `&`/конца hash и `decodeURIComponent`); при неудаче не оставлять токен в поле дольше одной попытки (или `type="password"`).

### A13 — informational — Токен в URL
Строки: `updateAttBase` **274-277** (токен в `src` каждой картинки-вложения → в DOM и в снимки экрана), `/api/push/info?token=` **1567**, `sw.js:114`, `client.js:225`, `draftsync-desktop.js:166`.

Рекомендация: передавать токен заголовком (`X-Dsh-Token`), для картинок — короткие одноразовые attachment-id; это же убирает риск попадания секрета в access-логи узла.

### A14 — informational — Нет teardown / visibility-политики
Строки: **12-13**, **1674-1675**, **1684-1692**, `watch()` **171-177**, **344**.

Поллинг продолжается в скрытой вкладке с интервалом 60-900 мс (**1674**); `pollTimer`/`refreshTimer` не очищаются нигде; при закрытии страницы `unwatch` не отправляется → подписка на сессию остаётся на узле до таймаута. Для клиента-синглтона на время жизни страницы это допустимо, но для PWA стоит добавить: `visibilitychange` → пауза/редкий режим, `pagehide` → `abort()` всех fetch + `watch(activeSession, true)` через `navigator.sendBeacon`-подобный путь.

### Что в app.js **не** является утечкой (механизмы очистки присутствуют)
- `draftTimer` (**35**, **39-45**) и `draftPillTimer` (**36**, **62-63**): `clearTimeout` перед каждым новым `setTimeout`, плюс сброс в `openChat` (**291**) и в submit (**731**). Корректно.
- Typewriter: `tw.timer` (**569**) создаётся в `engageTw` (**652**) только после `stopTw()` (**645**); `stopTw` (**571-574**) делает `clearInterval`; `fullRender` (**465-466**) останавливает и обнуляет `tw`; `twTick` (**611**) сам останавливается, когда узел отсоединён от DOM. Корректно.
- `mediaTimer` очищается в `onstop` (**1235**) — но см. A7: только там.
- Object URL: `prepareImage` (**1138**/**1156**) — `revokeObjectURL` в `finally`; `downloadBlob` (**1452**/**1457**) — revoke через 4 с. Корректно.
- Все `addEventListener` в app.js (**355**, **357**, **567**, **710-714**, **998**, **1197**) вешаются **один раз** на уровне модуля (скрипт подключён одним тегом — `index.html:150`), на элементах, а не на `window/document`; остальные обработчики назначены через `onclick=` (перезапись, а не накопление). `boot()` вызывается один раз (**1758**). Глобальные `window.copyCode`/`toggleTool`/`dshMenuOpen` — идемпотентные присваивания. Накопления слушателей при повторном init **нет**.
- `scheduleRefresh` (**1680-1693**) защищён правильно: `refreshTimer` присваивается синхронно до `await`, поэтому повторные вызовы не плодят цепочки (в отличие от A1).

---

## 2. `dsh-phone/web/sw.js`

### S1 — informational (положительный вывод) — Утечки версионируемого кэша НЕТ
Строки: **1** (`const CACHE = "dsh-phone-v21"`), activate-хендлер **8-12**.

Механизм очистки присутствует и корректен: `caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))` (**10**) удаляет **все** кэши, кроме текущего, затем `clients.claim()`. При переходе v20 → v21 старый кэш вычищается. Классической утечки «dsh-phone-vNN копится навсегда» здесь нет.

### S2 — medium — fetch-хендлер кэширует любой GET без ограничений
Строки: **15-28** (фильтры только `url.pathname.startsWith("/api/")` — **17** — и `method !== "GET"` — **18**; `c.put(e.request, copy)` — **23**).

Суть: в `CACHE` кладётся **каждый** успешный (и неуспешный тоже — `res.ok` не проверяется) ответ на любой GET, а не только `ASSETS`:
- **кросс-оригинные** запросы попадают в кэш как opaque-ответы (считаются против квоты с большим запасом, не читаются);
- ответы 404/500 кэшируются и потом отдаются офлайн как «валидные»;
- любой URL с уникальным query накапливается навсегда — внутри одной версии кэша pruning отсутствует, рост ограничен только сменой `CACHE`;
- `res.clone()` на каждый запрос — лишний буфер в памяти SW.

Фикс: `if (url.origin !== self.location.origin) return;` + белый список путей (`ASSETS`, `/`, статика); `if (!res.ok || res.type !== "basic") return res;`; периодическая подрезка (`cache.keys()` → удалять всё вне ASSETS, либо LRU-лимит N записей).

### S3 — medium — Рассинхрон версий: `?v=19` в HTML против `v21` в SW и unversioned `ASSETS`
Строки: `sw.js:1-2`, `index.html:11-12`, `index.html:147-150`.

Суть: HTML запрашивает `/app.js?v=19`, `/style.css?v=19`, а `ASSETS` (**2**) прекэширует `/app.js`, `/style.css` **без** query. Это две разные записи в кэше: прекэшированные копии никогда не используются (мертвый вес на диске, двойное хранение каждого ассета), а офлайн-загрузка после bump'а версии в HTML (`?v=20`) промахивается мимо кэша → белый экран офлайн. Плюс три счётчика версий (`v=19`, `CACHE v21`, `manifest?v=19`) нужно держать синхронно вручную.

Фикс: генерировать `ASSETS` из тех же версионированных URL, что и HTML (или убрать query-версионирование и полагаться только на `CACHE`), и вынести версию в одно место.

### S4 — low-medium — `install` по принципу «всё или ничего»
Строки: **4-6** (`caches.open(CACHE).then(c => c.addAll(ASSETS))`).

Суть: `addAll` отклоняется, если хотя бы один ассет вернул не-2xx (например, отсутствует `/icon.svg` или `/draftsync.js`) → SW не активируется вовсе: нет ни офлайн-фолбэка, ни Web Push.

Фикс: `Promise.allSettled(ASSETS.map(u => c.add(u)))` + лог, либо обязательный минимум (`/`, `/app.js`, `/style.css`).

### S5 — low — `notificationclick`: мёртвая ветка, sessionId никуда не передаётся
Строки: **86-102**, ветка **92-94**.

Суть: обе ветки делают одно и то же (`c.focus(); return;`) — `e.notification.data.sessionId` не используется, `postMessage` клиенту нет. Тап по уведомлению «нужен твой ответ» не открывает соответствующий чат.

Фикс: `c.postMessage({ type: "dsh-open-session", sessionId })` + слушатель `navigator.serviceWorker.addEventListener("message", ...)` в app.js, открывающий чат; при отсутствии окна — `openWindow("/#s=" + sessionId)`.

### S6 — medium — `pushsubscriptionchange`: старая подписка не отзывается, узел копит эндпоинты
Строки: **108-133**; `enablePush` в app.js **1561-1597** (отписка старой подписки на клиенте есть — **1570-1571**, но узлу `/api/push/unsubscribe` не отправляется); `disablePush` **1599-1619** (вызывается только вручную, **1621-1623**).

Суть: при ротации подписки браузером старая не отзывается и узел не уведомляется → список эндпоинтов на узле растёт, пуши шлются на мёртвые адреса. `e.newSubscription` игнорируется (рекомендуемая практика — использовать его, если оно есть, вместо нового `subscribe`). `pushManager.subscribe` (**116-119**) не обёрнут в `catch` → возможное отклонение внутри `waitUntil`. Токен передаётся в query (**114**).

Фикс: использовать `e.newSubscription` при наличии; при отсутствии — `subscribe`, затем `POST /api/push/unsubscribe` для старого endpoint; `.catch` на всю цепочку; токен в заголовке.

### S7 — low — Фолбэк `caches.match("/")` для любого провалившегося запроса
Строка: **26**. Для провалившегося запроса картинки/скрипта возвращается HTML → «сломанная» картинка и путаница при отладке. Фикс: фолбэк на `/` только для navigation-запросов (`e.request.mode === "navigate"`).

### S8 — low — IndexedDB открывается заново на каждую операцию и закрывается только на `oncomplete`
Строки: **31-58** (`idbSet`/`idbGet`), app.js `idbSetToken` **1538-1549**. При ошибке транзакции `db.close()` не вызывается (нет `onerror`/`onabort` у `tx` в `idbSet` — **39-40**), соединение остаётся открытым; плюс `onupgradeneeded` объявлен в каждом хелпере. Фикс: один ленивый синглтон-открытия с `onerror`/`onabort` и закрытием в `finally`.

### S9 — informational — push без дедупликации/троттлинга
Строки: **68-84**. `renotify: true` с тегом — корректно, но при шквале событий (каждый `turnEnded`, каждый notice) пользователь получает много уведомлений; нет rate-limit и нет сворачивания в одно «N событий».

---

## 3. `dsh-phone/gui/draftsync-desktop.js` (патч для десктоп-GUI)

### D1 — high — Нет никакого teardown: `alive` никогда не становится `false`
Строки: **33** (`alive = false`), **283** (`alive = true` в `start()`); отсутствие stop/dispose во всём файле; MutationObserver **256-267** (не `disconnect`); `el.addEventListener("input", schedulePush, true)` **248** (не снимается); патч `window.fetch` **222-240** (`__dshFetchHooked` **223-224** никогда не сбрасывается, оригинал не сохраняется).

Суть: у gui-версии нет `stopEngine` — в отличие от плагина (`client.js:431-441`), где он есть. Наблюдатель на весь документ, перехват `fetch` и poll-цепочка живут до уничтожения окна. Если скрипт-патч исполняется повторно в новом глобальном контексте (пересозданное окно/вью, SPA-перезагрузка части GUI, повторная инъекция без общего `window`), каждая копия добавляет свой MutationObserver + свой fetch-патч + свою poll-цепочку.

Фикс: портировать `stopEngine` из `client.js` (см. P2) и вызывать его при размонтировании вью; сохранять `originalFetch` и восстанавливать; `mo.disconnect()`; снимать слушатель с `el`.

### D2 — critical — Незавершаемые poll-цепочки: `setTimeout(pollLoop, 60)` не сохраняется, а `bootstrap()` перезапускается из трёх мест
Строки: `pollLoop` **162-182** (`setTimeout(pollLoop, 60)` — **173**, id не сохраняется), `bootstrap` **269-280** (`if (cfg) { pollLoop(); return; }` — **271**), вызовы `bootstrap`: **286** (`start`), **127** (при отклонённом push), **180** (в catch поллинга).

Суть: каждый вызов `bootstrap` при живом `cfg` запускает **новую** цепочку `pollLoop`, а старые продолжают самостоятельно перезапускаться каждые 60 мс — отменить их невозможно (id таймера нигде не хранится, `pollAbort.abort()` на **164** отменяет запрос, но не цепочку). Триггеры: любая отклонённая отправка черновика (**121-128**, `cfg = null; bootstrap();`) при том, что in-flight poll ещё жив; любой сбой поллинга (**175-181**) плюс параллельный bootstrap. Цепочки размножаются геометрически: N цепочек → N запросов каждые 60 мс.

Дополнительно: `POLL_IDLE_MS` (**20**) объявлена и **никогда не используется** — нет idle-backoff, постоянный темп ~16 запросов/с.

Фикс: хранить id таймера (`pollHandle = setTimeout(...)`) и флаг `pollRunning`; единственная точка входа `startPoll()` с guard; `stopPoll()` в teardown; использовать `POLL_IDLE_MS` когда `document.hidden`/нет активности; `AbortController` отменять именно в `stopPoll`.

### D3 — high — Нет single-flight guard у `bootstrap`/`fetchConfig`
Строки: **269-280**, `fetchConfig` **89-106** (рекурсивный перебор 4 баз **12-17**).

Суть: два параллельных `bootstrap` (например, из **127** и из **180**) оба вызывают `fetchConfig`, оба ставят `cfg` и оба зовут `pollLoop()` → дубли (см. D2). Плюс каждый `fetchConfig` при недоступном узле делает 4 запроса подряд без backoff, а `nodeBase` перезаписывается.

Фикс: `if (bootstrapping) return;` + `bootstrapping = true/false` вокруг промиса; один общий промис конфигурации.

### D4 — medium — `trackFromUrlAndBody`: мёртвая ветка исключения → сессия «угоняется» служебными запросами
Строки: **200-220**, цикл **208-210**, `SIDE_CHANNELS` **201**.

Суть: сравнение `base === "/api/" + SIDE_CHANNELS[i].slice(5)` даёт `"/api//api/session/list"` (двойной слэш) — никогда не совпадает, поэтому intended-исключение не работает: тела `session/list`, `session/title`, `session/rename`, `session/fork`, `session/create`, содержащие id сессии, считаются сигналом «пользователь открыл этот чат» → `sessionId` переключается (**211-219**), `lastPushedText` сбрасывается, и черновик привязывается не к тому чату (с последующим push в чужую сессию).

Фикс: нормализовать список (`["session/list", ...]`) и сравнивать `base === "/api/" + name`, либо `base.replace(/^\/api\//,"")`.

### D5 — high — `watchComposer`: незавершаемый фан-аут retry-таймеров + наблюдатель на весь документ
Строки: `watchComposer` **242-254** (`setTimeout(watchComposer, 800)` — **253**, id не сохраняется), `observeDom` **256-267** (колбэк наблюдателя зовёт `watchComposer()` — **262**; `mo.observe(document.documentElement, {childList:true, subtree:true})` — **265**).

Суть: пока composer не найден, **каждая** мутация DOM запускает новую цепочку 800-мс ретраев, а каждая цепочка, не найдя узел, порождает следующую. На Lexical/React-странице с постоянными мутациями это неограниченный рост числа параллельных таймеров (каждый держит замыкание на `document` и `el`). Плюс наблюдатель на всём `documentElement` без throttling — постоянная нагрузка на main thread.

Фикс: один хранимый `watchHandle` + guard `if (watchHandle) return;`; в наблюдателе — debounce (`requestAnimationFrame`/флаг «mutation pending»); наблюдать за конкретным контейнером, а не за всем документом; `clearTimeout(watchHandle)` в teardown.

### D6 — medium-low — Снятый `el` не освобождается от слушателя
Строки: **243**, **248**, **260-262** (`el = null` без `removeEventListener`).

Суть: при пересоздании composer'а в GUI старый узел теряет ссылку из `el`, но на нём остаётся capture-слушатель с замыканием на модуль; если узел ещё где-то удерживается (React-фибером, undo-историей), слушатель продолжает срабатывать и толкать `pushDraft` (защищён `if (!el)` — **117**, так что эффект ограничен). При следующем `stopEngine`-подобном teardown снимается только последний `el`.

Фикс: в ветке **260-262** сначала `el.removeEventListener("input", schedulePush, true)`, потом `el = null`.

### D7 — low — Токен в query-строке
Строки: **166** (`&token=`), **111-112** (и в заголовке, и в теле). Попадает в access-логи узла и в историю прокси. Фикс: только заголовок `x-dsh-token`.

### D8 — low — `applyComposerText`: `document.execCommand` + перехват фокуса
Строки: **59-87** (`el.focus()` — **63**, `sel.removeAllRanges()` — **67**, `execCommand("insertText")` — **71**).

Суть: `execCommand` deprecated; при применении удалённого черновика фокус насильно переводится в composer и сбрасывается выделение пользователя (guard только на «печатает прямо сейчас» — **156**). Не утечка, но ломает UX и может конфликтовать с Lexical.

Фикс: не фокусировать, если `document.activeElement` не composer; применять текст через API редактора/`InputEvent` без `execCommand`; добавить `visibilitychange`-паузу применения.

### D9 — informational — `handleEvents` не учитывает смену сессии между запросом и ответом
Строки: **148-160**, `sameTarget` **142-146**. Проверка `sameTarget` есть — это хорошо, но черновик применяется к уже перепривязанному composer'у без сверки «когда именно» пришёл ответ (нет эпохи, как в A3). При быстрой смене сессий в GUI возможен apply устаревшего текста. Фикс: эпоха/seq на ответ.

---

## 4. `dsh-phone/plugin/dsh-draft-sync/lib/client.js`

### P1 — critical — Мутируемые переменные модуля переживают `stopEngine()` → дубли движков при повторном apply
Строки: объявления **26-37**, `355`, `275-277`, `314-316`; `startEngine` **420-442**; `stopEngine` **431-441**; `exports.apply` **445-449** (`ctx.effect(() => startEngine(), "dsh-draft-sync: engine")`).

Суть: фабрика модуля выполняется один раз, но `startEngine`/`stopEngine` вызываются эффектом, который в harness-плагинах может создаваться/уничтожаться многократно (переподключение узла, reload плагина, смена соединения). `stopEngine` сбрасывает `alive`, таймеры, `mo`, хуки — но **не сбрасывает** `cfg`, `sessionId`, `heartbeatTimer`(сброшен) / `since` / `lastActivityAt` (**170**) / `lastSniffAt` (**169**) / `listProbedAt` (**172**) / `adoptedBy` (**171**) / `lastPushedText`. При повторном `startEngine` движок стартует с унаследованными `cfg` и `sessionId` → `bootstrap` (**406-408**) идёт по ветке `if (cfg) { pollLoop(); startHeartbeat(); return; }` и **пропускает перечитывание конфигурации**: если узел за это время сменил токен/порт, новый движок молча работает со stale-конфигом и бесконечно уходит в цикл `cfg = null; setTimeout(bootstrap, RETRY_MS)` (**238-239**). Хуже: если `stopEngine` не был вызван (effect размонтировали без dispose, или исключение внутри dispose), второй `startEngine` добавляет **второй** набор poll-цепочек, heartbeat-интервалов и наблюдателей поверх первого — те же симптомы, что D1/D2.

Фикс: полный сброс состояния в `stopEngine`:
```js
cfg = null; nodeBase = null; sessionId = null; since = 0; el = null;
lastPushedText = null; lastLocalInput = 0; adoptedBy = "";
lastSniffAt = 0; lastActivityAt = 0; listProbedAt = 0;
```
плюс guard в `startEngine`: `if (alive) return stopEngineRef;` (не стартовать дважды), и идемпотентный `stopEngine` (флаг `stopped`, чтобы повторный вызов не портил состояние нового движка).

### P2 — high — Незавершаемые poll-цепочки и дублирующий `bootstrap` (та же болезнь, что D2/D3)
Строки: `pollLoop` **221-241** (`setTimeout(pollLoop, 60)` — **232**, id не сохраняется), `bootstrap` **406-418** (`if (cfg) { pollLoop(); startHeartbeat(); return; }` — **408**), вызовы: `startEngine` **428**, `pushDraft` reject **126**, pollLoop catch **239**.

Суть: `stopEngine` обрывает только `pollAbort` (**434**) — запрос, но не цепочку: если цепочек несколько (или `stopEngine` вызван между `setTimeout` и следующим `pollLoop`), следующая итерация стартует снова; guard `if (!alive || !cfg) return;` (**222**) спасает только при корректно сброшенном `alive`. Каждая отклонённая отправка черновика (**125-126**) и каждый сбой поллинга (**238-239**) запускают ещё один `bootstrap` → ещё одну цепочку. `POLL_IDLE_MS` (**21**) объявлена и не используется — нет idle-backoff, темп 60 мс.

Фикс: хранить `pollHandle`/`pollRunning`; `stopPoll()` = `pollRunning = false; clearTimeout(pollHandle); pollAbort.abort();`; single-flight guard для `bootstrap`; использовать `POLL_IDLE_MS` при `document.hidden`.

### P3 — high — `watchComposer`: тот же фан-аут ретраев, и `stopEngine` их не отменяет
Строки: **380-392** (`setTimeout(watchComposer, 800)` — **391**, id не сохраняется), `observeDom` **394-404** (колбэк зовёт `watchComposer()` — **399**), `stopEngine` **431-441** (нет `clearTimeout` для watch-таймера).

Суть: после `stopEngine` наблюдатель отключён, но уже запланированный `setTimeout(watchComposer, 800)` **выполнится** и, не найдя `el`, запланирует следующий — бесконечная цепочка ретраев в «остановленном» движке, каждая итерация держит замыкание на `document`. Пока composer отсутствует, каждая мутация DOM порождает новую цепочку (неограниченный рост).

Фикс: `watchHandle` + `clearTimeout(watchHandle)` в `stopEngine`; guard `if (!alive) return;` первой строкой `watchComposer`; debounce в наблюдателе.

### P4 — high — `heartbeat`: интервал переживает `stopEngine` в «мёртвом» режиме, а при отсутствии catch — unhandled rejection
Строки: **355-378** (`startHeartbeat` **370-374**, `stopHeartbeat` **376-378**), `heartbeat` **357-368**, вызовы `startHeartbeat` из `bootstrap` **408** и **416**.

Суть: `stopHeartbeat` вызывается в `stopEngine` (**437**) — это хорошо. Но `startHeartbeat` вызывается из `bootstrap` **дважды возможными путями** (408 и 416) и guard `if (heartbeatTimer) return;` (**371**) защищает только пока интервал жив: после `stopEngine` (`heartbeatTimer = 0`) любой «выживший» bootstrap (**409-417**, промис уже в полёте, проверка `if (!alive) return;` на **410** сработает — ок) либо P1-сценарий повторного `startEngine` поднимает **второй** интервал рядом с первым, если `stopEngine` не отработал. Отдельно: `nodeRequest(...)` (**360-367**) завершается `.catch(function(){})` — корректно, но `probeSessionList()` (**359**) вызывается синхронно и при `nodeBase === null` даёт запрос на `"null/api/rpc"` (см. P5).

Фикс: guard «один интервал на движок» через флаг эпохи (`engineId`), сбрасываемый в `stopEngine`; хранить `heartbeatTimer` и проверять `alive` внутри `heartbeat` (сейчас проверка есть — **358** — это ок).

### P5 — medium — `nodeRequest` не проверяет `nodeBase`/`cfg` → запросы на `"null/api/rpc"` и TypeError
Строки: **107-113**; вызовы: `pushDraft` **120**, `loadExistingDraft` **245**, `probeSessionList` **191**, `heartbeat` **360**.

Суть: `fetch(nodeBase + "/api/rpc")` при `nodeBase === null` уходит на относительный URL страницы GUI (`"null/api/rpc"` → 404 на чужом домене), а при `cfg === null` — `cfg.token` бросает TypeError синхронно (в `pushDraft` это происходит **до** `.catch`, т.е. исключение улетает в вызывающий код, например в `adoptSession` **217** или в `bootstrap` **414**). Guard'ы есть в `pushDraft` (**116**) и `loadExistingDraft` (**244**), но не в `probeSessionList` (**187-191**: `if (!cfg || sessionId) return;` — есть `!cfg`, но нет `!nodeBase`) и не в `heartbeat` (**358**: есть `!nodeBase` — ок).

Фикс: в `nodeRequest` первая строка — `if (!cfg || !nodeBase) return Promise.resolve(null);`.

### P6 — medium — `unhookXhr` может оставить чужую обёртку или восстановить `undefined`
Строки: **318-351**, особенно **342-347** (пустой `if` **343-345** с комментарием, затем безусловное присваивание **346-347**).

Суть: если кто-то обернул `XMLHttpRequest.prototype.open` **после** плагина, код это обнаруживает (343) и... ничего не делает, а следующей строкой всё равно перезаписывает `open`/`send` сохранёнными — то есть **сносит чужую обёртку** (например, перехват DSH connection layer), вопреки комментарию. Обратно: если `hookXhr` не сработал (`xhrOpen === null`), `unhookXhr` присваивает `XMLHttpRequest.prototype.open = XMLHttpRequest.prototype.open` (безвредно), но при частичном успехе `hookXhr` (исключение внутри try — **321-337**) возможна ситуация, где `open` восстановлен, а `send` — нет.

Фикс:
```js
if (xhrOpen && XMLHttpRequest.prototype.open !== xhrOpen) { /* кто-то сверху — не трогаем */ }
else { XMLHttpRequest.prototype.open = xhrOpen; XMLHttpRequest.prototype.send = xhrSend; }
```
и сохранять/восстанавливать обе функции парой, с флагом «успешно захукано».

### P7 — medium — `trackActivity`/`probeSessionList`: кулдауны «навсегда» и гонка на присвоение сессии
Строки: **169-207**, `trackActivity` **174-183** (`lastActivityAt` **180-181**, кулдаун 120 с), `probeSessionList` **187-207** (`listProbedAt` **189-190**), `handleEvents` **147-162**.

Суть: `lastActivityAt`/`listProbedAt`/`lastSniffAt` не сбрасываются в `stopEngine` (P1), поэтому после перезапуска движка «свежая» привязка к сессии блокируется на 2-5 минут унаследованными таймстампами. `probeSessionList` не имеет in-flight guard: два heartbeat'а подряд (или P1-дубли) могут отправить два `session.list` и оба вызвать `adoptSession` с разными «лучшими» сессиями → переключение привязки черновика туда-сюда. `adoptSession` (**209-219**) не сверяет, что ответ всё ещё актуален (нет эпохи).

Фикс: сбрасывать таймстампы в `stopEngine`; флаг `listProbeInFlight`; эпоха/seq для `adoptSession`.

### P8 — low — Двойной перехват транспорта и конфликт с gui-патчем
Строки: `hookFetch` **279-299** (`FETCH_KEY` **275**, **280**, **284**), `hookXhr` **318-338**, `draftsync-desktop.js:222-240` (`__dshFetchHooked`).

Суть: если в один документ попадают и gui-патч, и плагин (index.html PWA их не подключает — проверено, `dsh-phone/web/index.html` не ссылается на `draftsync-desktop.js`), работают **два независимых движка** с разными guard-ключами: два поллинга `/api/events` каждые 60 мс, два heartbeat'а каждые 15 с, два MutationObserver на весь документ, две цепочки fetch-обёрток; оба привязываются к одной сессии и толкают черновик, что даёт эхо-цикл (каждый применяет чужой текст и отправляет его обратно — ограниченно `applyingRemote`/`lastPushedText`, но не полностью).

Фикс: один общий guard-ключ на документ (`window.__dshDraftSyncArmed`) с проверкой в обоих файлах; либо убрать gui-патч в пользу плагина.

### P9 — informational — `stopEngine` не снимает слушатель с предыдущих composer-узлов
Строки: **436** (`el.removeEventListener(...)` — только текущий `el`), **396-400** (`el = null` без снятия слушателя). Как в D6.

### P10 — informational — `ctx.effect` без явной проверки повторного вызова
Строки: **445-449**. Если harness-эффект может быть перезапущен без вызова возвращённого dispose (например, при hot-reload плагина), движок удваивается. Стоит держать ссылку на предыдущий `stopEngine` в замыкании модуля и вызывать её в начале `startEngine`.

---

## 5. `dsh-phone/web/index.html` (инлайн-скрипт — часть клиентской поверхности)

### I1 — low — `setInterval(tick, 1000)` без очистки
Строки: **180-186**. Единственный интервал (скрипт выполняется один раз), но работает вечно, включая скрытую вкладку и закрытое меню: 1 пробуждение в секунду + запись в DOM. Фикс: запускать только когда меню открыто (`open`/`close` — **155-156**), либо `requestAnimationFrame` с проверкой видимости.

### I2 — medium/high — «Стереть данные» не стирает почти ничего
Строки: **201-204** (`localStorage.removeItem("dsh-phone-token"); location.reload();`).

Суть: остаются `dsh-phone-hist-*`, `dsh-phone-stats-*`, `dsh-phone-read`, `dsh-phone-sessions`, `dsh-phone-devid`, кэши Service Worker, а главное — **подписка Web Push и токен, зеркально записанный в IndexedDB** (`app.js:1538-1549`, читается в `sw.js:112`). Узел продолжит слать пуши на устройство, а `pushsubscriptionchange` (`sw.js:108-133`) — переподписываться со старым токеном. Для деструктивного действия «wipe» это существенный пробой приватности.

Фикс: в обработчике — `disablePush()` (app.js **1599-1619**), `indexedDB.deleteDatabase("dsh-phone")`, `navigator.serviceWorker.getRegistration().then(r => r && r.unregister())`, `caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))`, удаление всех ключей `dsh-phone-*`, затем reload.

### I3 — medium — См. S3 (рассинхрон `?v=19` / `CACHE v21` / unversioned `ASSETS`).

---

## 6. Приоритетный план исправлений

1. **critical**: `client.js` P1 (сброс состояния движка в `stopEngine` + guard от повторного `startEngine`); `draftsync-desktop.js` D2 и `client.js` P2 (хранимый `pollHandle`, single-flight `bootstrap`, отмена цепочки в teardown).
2. **high**: `app.js` A1 (флаг `pollOn` вместо проверки `pollTimer` + блокировка кнопки), A2 (AbortController/таймауты + in-flight guard), A3 (эпоха чата и сверка sid во всех `.then`), A4 (`.catch` везде, сохранение текста при reject), A7 (остановка дорожек микрофона и сброс `recActive` в catch); `draftsync-desktop.js` D1 (портировать `stopEngine`), D5 и `client.js` P3 (хранимый watch-таймер + debounce), `client.js` P4.
3. **medium**: A5, A6, A8, A11; S2, S3, S6; D4, P5, P6, P7, I2.
4. **low / informational**: A9, A10, A12, A13, A14; S4, S5, S7, S8, S9; D6, D7, D8, D9; P8, P9, P10; I1.

## 7. Где утечек нет — подтверждающие механизмы
- `sw.js` activate (**8-12**) удаляет все кэши, кроме текущего → версионируемый кэш не копится.
- `app.js`: `draftTimer`/`draftPillTimer` (**39-45**, **62-63**, **291**, **731**), typewriter `tw.timer` (**571-574**, **645**, **652**, **465-466**, **611**), `mediaTimer` (**1235**), `URL.revokeObjectURL` (**1156**, **1457**), `scheduleRefresh` guard (**1681**), слушатели вешаются один раз на уровне модуля (**355**, **357**, **567**, **710-714**, **998**, **1197**) и на элементах, а не на `window/document`; `boot()` — один вызов (**1758**).
- `draftsync-desktop.js`: guard повторного выполнения патча через `window.__dshDesktopDraftSync` (**4-5**), `clearTimeout(pushTimer)` (**135**), `pollAbort.abort()` перед новым запросом (**164**), остановка дорожек в `onstop` (**1236** — в app.js).
- `client.js`: полноценный `stopEngine` (**431-441**) очищает push-таймер, abort, MutationObserver, слушатель composer, heartbeat и снимает хуки fetch/XHR; guard'ы `if (window[FETCH_KEY]) return;` (**280**) и `if (window[XHR_KEY]) return;` (**319**); `unhookFetch` восстанавливает оригинал только если наша обёртка на верху цепочки (**305-307**); `ctx.effect(...)` (**446-448**) — правильный канал для dispose. Проблема не в отсутствии механизма, а в неполноте сброса (P1) и в незавершаемых таймерах (P2/P3).
