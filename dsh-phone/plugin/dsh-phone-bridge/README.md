# dsh-phone-bridge

Свой мост между DSH Desktop и узлом `dsh-phone`. Заменяет Agents Anywhere:
без облака, без учётки AA, без Python-коннектора. Плагин состоит из двух
половин, и узел умеет работать через любую из них.

Плагин один на всё: синхронизация черновика раньше жила отдельным
`dsh-draft-sync`, теперь она влита сюда (см. «Переезд с dsh-draft-sync»). Один
бандл в профиле, одно рукопожатие с узлом, один перехват сетевого трафика
десктопа и один писатель в композитор - вместо двух независимых движков, которые
дублировали друг друга и могли применять чужой текст по кругу.

## Две половины

**host** (`lib/index.js` + `lib/host/*`) - Cordis-сервис `dshPhoneBridge` в
главном процессе Node/Electron. Поднимает TCP-мост на `127.0.0.1` со случайным
портом и говорит newline-delimited JSON-RPC 2.0. Протокол намеренно совместим с
мостом Agents Anywhere (handshake, коды ошибок, формы ответов, проекция timeline
версии 2, синк-фид с `snapshot.begin/items/commit` и обязательными ack), поэтому
Rust-узел подключается к нему как есть, без единой строчки Python.

**web** (`lib/client.js`) - браузерная половина, один самодостаточный файл без
сборщика. Шлёт рукопожатие и heartbeat, перехватывает fetch/XHR десктопа
(снапшоты сессий и события синк-фида) и обслуживает HTTP-канал команд узла:
`POST /api/bridge/poll` (long-poll) → выполнить → `POST /api/bridge/ingest
{type:"result"}`. Работает даже если host-половина не загрузилась.

В том же файле живёт движок черновиков: наблюдение за `[data-composer-input]` с
дебаунсом 600 мс и пуш в `/api/draft`, long-poll `/api/events` для обратного
направления, применение чужого текста через `execCommand("insertText")` (иначе
Lexical его не увидит), грайс 2,5 с на «пользователь печатает прямо сейчас» и
подавление собственного эха по origin. Оба движка делят один бутстрап конфига,
один перехват сети, один heartbeat, один доступ к композитору и один teardown,
поэтому запись из `domSend()` (отправка хода с телефона) никогда не уезжает на
узел черновиком.

## Что видит узел

- endpoint-файл: `<DSH_HOME>/dsh-phone/bridge/endpoint.json`, содержимое
  `{version:1, host:"127.0.0.1", port, token, pid}`. `DSH_HOME` резолвится как
  `config.dshHome ?? process.env.DSH_HOME ?? ~/.dsh` - ровно тот же порядок, что
  в Rust (`config.rs::dsh_home`).
- Узел пробует наш endpoint **первым** (`plugin_bridge_endpoint_path`), мост AA
  держит запасным (`bridge_endpoint_path`). Какой файл сработал, видно в
  `GET /api/health`: `bridgeChannel` (`tcp` / `plugin` / `none`) и
  `bridgeEndpoint`.
- Если TCP-мост не поднят, узел уходит в HTTP-канал web-половины; его метрики лежат
  в `pluginBridge` того же health: `connected`, `alive`, `queue`, `inFlight`,
  `dropped`, `rttMs`, `lastPushAgeSec`.

## Протокол host-моста

Транспорт и лимиты повторяют AA, чтобы один и тот же клиент работал с обоими:
кадры LF-разделённые, жёсткий предел 8 МиБ в обе стороны (`FRAME_TOO_LARGE`
-32013), сокет уничтожается при `writableLength` > 16 МиБ, максимум 16 сокетов и
16 запросов в полёте, 10 с на аутентификацию, 60 с на запрос, отмена через
уведомление `$/cancelRequest`. Токен - `randomBytes(32).toString("base64url")`,
новый при каждом старте, первый запрос обязан быть `initialize` с `authToken`,
`protocolVersion` вида `1.x` и `runtime:"dsh"`.

Методы: `initialize`, `ping`, `runtime.getConfig`, `runtime.getCapabilities`,
`workspace.list`, `session.list`, `session.getState`, `session.getSnapshot`,
`session.getCapabilities`, `session.getNotices`, `session.respondInteraction`,
`session.startTurn`, `session.createAndStart`, `session.interrupt`,
`session.updateSelections`, `catalog.listModels`, `catalog.listPermissions`,
`catalog.listAgentPresets`, `runtime.sync.subscribe|ack|unsubscribe|refresh`.
Всё прочее - `METHOD_NOT_FOUND`.

Покрытие полное: в `WHITELIST` узла (`server.rs`) 19 методов, 16 из них
пересылаются в рантайм - и все 16 реализованы здесь. Оставшиеся три
(`session.pluginPing`, `session.updateDraft`, `session.getDraft`) узел
обслуживает сам, до моста они не доходят. `session.getCapabilities` сделан сверх
списка: он нужен самой логике возможностей.

Данные берутся из сервисов DSH (`sessionQuery`, `sessions`, `workspaceRegistry`,
опционально `sessionController`, `permissionPresets`, `commands`, `agentPresets`,
`llm`), а живые обновления - из событий Cordis (`session/created`,
`session/event`, `session/disposed`, `agent/status`, `agent/assistant-stream`,
`domain/changed`, `llm/adapters-updated`). Никакого поллинга файловой системы и
никакого чтения файлов сессий в обход `sessionQuery`.

Лента (`runtime.sync.batch`) держит снапшоты ленивыми: `snapshot.begin` →
состояния живых сессий → `inventory.complete`, а история добирается при первом
событии, при `refresh` или при обнаруженном пропуске seq. После любой пересборки
снапшота вызвавшее её событие применяется поверх (`catchUp` в `sync.js`): Cordis
отдаёт `session/event` раньше, чем лог сессии успевает его содержать, и без
доводки событие терялось, а следующее выглядело пропуском - лента уходила в
бесконечные пересборки и глохла. Теперь `turn/end` историю не пересобирает.
Статус `waiting_approval` считается по незакрытому `approval/asked` (минус
`approval/decided`) - без него узел не отправил бы пуш «Нужен твой ответ».
`session.list` и лента используют одну и ту же полную проверку видимости,
поэтому список сессий и содержимое ленты не расходятся.

## Состав host-половины

`lib/index.js` - тонкий вход: экспорт `name`/`version`/`apply`, Cordis-сервис
`dshPhoneBridge` (`static inject = ["sessions","sessionQuery","workspaceRegistry"]`,
старт в `[Service.init]`, остановка через `ctx.effect`). Падение старта не роняет
загрузку плагина: ошибка уходит в лог, попытка повторяется до трёх раз с шагом 5 с.

`lib/host/errors.js` - таблица кодов (`PARSE_ERROR` -32700 ... `SESSION_ARCHIVED`
-32014), `BridgeError` с флагом `retryable` и `publicError()`, который превращает
любое исключение (включая `isDSHRemoteError` и `AbortError`) в публичный код.
Внутренние детали DSH наружу не уходят.

`lib/host/identity.js` - всё, что должно быть стабильным и воспроизводимым:
`sessionId`/`itemId`/`contentHash` через sha256, канонический JSON,
детерминированный `userMessageId` из `clientMessageId` (префикс `dshp.`) и
кодирование/декодирование `selectionId` модели и прав.

`lib/host/framing.js` - LF-кадры: декодер с защитой от гигантского кадра и
ресинхронизацией до следующего LF, `validateRequest`, `validateHandshake`,
`isCancelNotification`. Чистая логика, без сокетов.

`lib/host/project.js` - проекция истории DSH в timeline v2: сопоставление
`tool/call` + `tool/result` в один элемент, виды `command` / `file_change` /
`web_search` / `mcp` / `agent_call` / `input_request` / `permission` / `compact`,
черновики стрима (тот же `id`, что у финального сообщения), `foldTitle`,
`paginateItems`. Diff'ы берутся только из меты DSH или из аргументов `write` -
файлы с диска не дочитываются, коды возврата не выдумываются.

`lib/host/native.js` - доступ к DSH: `SessionSource` (инвентарь, видимость по
правилам сайдбара, кэш логов и ревизий), `RuntimeCatalogs` (модели, права,
пресеты), `RuntimeConfiguration` (чтение состояния через официальные
`sessionProjections`, запись через `sessionController` / `permissionPresets` /
`commands`), `UserQuestions` (ask_user_question) и `NativeRuntime` (подписка на
события Cordis, отправка, прерывание, capabilities).

`lib/host/router.js` - JSON-RPC диспетчер: `resolve` идентификаторов сессии
(платформенный и внешний, с проверкой namespace), все методы из белого списка,
пагинация снапшота и списка, `startTurn`/`createAndStart` с возвращением
`{ok:false, code}` вместо исключения (узел не должен терять соединение из-за
отказа записи).

`lib/host/sync.js` - синк-фид: `streamId`, `batchSeq` с 1, темп 34 мс, каждый
батч ждёт `runtime.sync.ack` (60 с), снапшоты страницами по 250 элементов,
буфер не больше 10 000 событий и 6 МиБ, при переполнении - `runtime.error` со
`scope:"sync"` и закрытие потока.

`lib/host/server.js` - TCP-сервер: `listen(0,"127.0.0.1")`, handshake с
`timingSafeEqual`, лимиты 16 сокетов / 16 запросов в полёте / 10 с на handshake /
60 с на запрос, `$/cancelRequest`, уничтожение сокета при переполнении буфера
записи, публикация и снятие `endpoint.json`.

`lib/host/endpoint.js` - файл endpoint: резолв `DSH_HOME` (только абсолютный),
точный компактный JSON, запись через временный файл и атомарный `rename`, отказ
перехватывать endpoint живого процесса (проверка `process.kill(pid, 0)`),
удаление только если токен и pid на диске всё ещё наши.

## Установка

Руками, без pnpm - зависимостей у плагина нет:

1. Закрой DSH Desktop.
2. Скопируй эту папку в
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-phone-bridge\`.
3. Добавь `"dsh-phone-bridge"` в массив `dsh.profile.bundles` в
   `%USERPROFILE%\.dsh\profiles\desktop\package.json`.
4. Запусти DSH Desktop.

Проверка: появился файл `%USERPROFILE%\.dsh\dsh-phone\bridge\endpoint.json`, а
`/api/health` узла показывает `bridgeChannel: "tcp"` и этот путь в
`bridgeEndpoint`.

> Записи нет в lockfile профиля, поэтому `dsh plugin --profile desktop add ...`
> или любой pnpm install в профиле может снести папку - скопируй её заново.

### Переезд с dsh-draft-sync

Если в профиле ещё стоит отдельный `dsh-draft-sync`, удали его: убери строку
`"dsh-draft-sync"` из `dsh.profile.bundles` и снеси папку
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-draft-sync\`. Иначе
черновик ведут два движка одновременно: два long-poll `/api/events`, два
MutationObserver на документ и риск применять чужой текст по кругу.

На случай, если старый плагин всё же остался, есть защита. Документ делится по
общему ключу `window.__dshDraftSyncArmed`: увидев значение
`dsh-draft-sync-plugin`, наш клиент не поднимает свой движок черновиков
(уступает старому), пишет предупреждение в консоль десктопа и продолжает
работать мостом. Раньше существовал третий путь установки: asar-патч
`dsh-phone/gui/draftsync-desktop.js` вместе с `tools/dsh-gui-patch.ps1`. Он
отправлен на пенсию: движок черновиков теперь один и живёт в этом плагине, а
третья копия движка только разводила дрейф. На машинах, где патч уже вшит в
asar, его скрипт уступает плагину по маркеру `window.__dshDraftSyncPlugin`, а
снять сам патч можно `tools/revert_dsh_asar.py` (восстанавливает
`app.asar.orig`).

## Проверка без DSH Desktop

- `npm test` (то же самое: `node --test "test/*.test.js"`) - юнит-тесты чистых
  модулей: framing, identity, errors, project, endpoint, плюс web-половина.
  98 проверок; из них 10 в `wire-protocol.test.js` поднимают настоящий
  TCP-сервер и проговаривают рукопожатие ровно так, как это делает `bridge.rs`
  (плюс содержимое `endpoint.json`, `NOT_INITIALIZED`,
  `PROTOCOL_VERSION_MISMATCH`, проверка конверта, одновременные дубли id и
  `$/cancelRequest`), а 18 в `web-client.test.js` грузят настоящий `lib/client.js`
  через `node:vm` под подставным браузером с общими виртуальными часами: один
  перехват fetch/XHR, один heartbeat с двумя пейлоадами, инвариант эха
  `programmaticWrite`, легаси-защита и полный teardown. Форма `node --test test/`
  в Node 24 не работает: positional аргумент трактуется как glob/файл, а не как
  каталог, поэтому в `package.json` записан явный glob.
- `node scripts/smoke-host-bridge.mjs` - интеграционный прогон протокола на
  подставном ctx и настоящем TCP-сервере: handshake и токен, битый JSON и битый
  конверт, кадр больше 8 МиБ и ресинхронизация, `METHOD_NOT_FOUND`,
  `session.list` (субагенты, архив и пустые сессии исключены), `getState`,
  `getSnapshot` с пагинацией и watermark, отказ записи в read-only сборке,
  синк-фид с ack и живыми событиями, снятие `endpoint.json` при остановке.
- `node scripts/smoke-host-write.mjs` - то же для пути записи: `createAndStart`
  (проверяется порядок вызовов сервисов DSH), `startTurn`, идемпотентность
  `clientMessageId`, сбои записи как `ok:false`, `updateSelections`,
  `interrupt`, каталоги моделей/прав/пресетов, capabilities.
- `node scripts/smoke-cordis-lifecycle.mjs` - жизненный цикл Cordis-сервиса на
  настоящем cordis: регистрация через `ctx.plugin`/`apply`, `static inject`,
  `[Service.init]`, публикация endpoint, снятие публикации при dispose и
  поведение при занятом endpoint. Нужен разрешимый `@deepseek-ai/cordis`, то есть
  запуск из установленного профиля DSH; в отдельной копии скрипт печатает SKIP.
- `scripts\smoke-plugin-channel.ps1` (в корне репозитория) - поднимает узел на
  временном конфиге с отключёнными TCP-мостами и прогоняет весь HTTP-канал
  web-половины: hello → health → long-poll команд → ответ через
  `ingest(type=result)` → данные в event-feed → RPC телефона через тот же канал →
  проброс ошибок → метрики. Боевой конфиг не трогает (`DSH_PHONE_CONFIG_DIR`).
- `dsh-phone\probe.py` - диагностика моста: подключается к первому найденному
  endpoint (наш, затем AA) и дёргает `ping`, `workspace.list`,
  `runtime.getCapabilities`, `session.list`, `session.getSnapshot`.

## Осознанные отличия от моста AA

Это решения, а не дефекты; они намеренно отличаются от реализации Agents
Anywhere:

- Нет TCP manager-lock (AA координирует несколько процессов файлом-локом).
  Вместо него `endpoint.json` не перезаписывается, если в нём живой `pid`:
  второй процесс не отберёт мост у первого и не оставит телефон без связи.
- Базовые снапшоты ленивые: `inventory.begin` → состояния живых сессий →
  `inventory.complete`, а история добирается по первому событию, `refresh` или
  пропуску seq. AA отдаёт историю сразу - это дольше на старте при большом
  списке сессий.
- `metadata.readOnly` в `session.list` считается от наличия `sessionController`
  (у AA - от `agents`); телефон это поле не читает.
- `session.getState` не сканирует лог на `approval/asked` - паритет с AA:
  статус апрува приходит лентой.
- Свой `foldTitle` вместо `@deepseek-ai/dsh-session-title`: внешние зависимости
  плагину запрещены.
- Префикс детерминированного `userMessageId` - `dshp.`, а не `aa.`, чтобы
  отправка через наш мост и через AA не сливалась в один дедуп-ключ.

## Честные ограничения

- host-половина не прогонялась вживую внутри DSH Desktop: перезапустить хост, в
  котором живёт рабочая сессия, нельзя. Протокол сверен с реализацией AA по коду,
  покрыт юнит-тестами и тремя смоками выше (включая cordis 4.0.2), Rust-сторона
  проверена смоуком на реальном процессе узла, но первый живой запуск внутри DSH -
  на твоей стороне. Формы ответов сервисов DSH, не упомянутые в коде AA,
  перечислены в разделе «Риски» ниже.
- Всё, что не подтверждено сервисами DSH, возвращается как
  `UNSUPPORTED_OPERATION` (или пустым списком), а не выдуманными данными:
  `session.steer`, `session.commands` и `runtime.attachment` не включаются
  никогда, каталоги и апрувы - только если соответствующий сервис реально
  доступен в хосте. Вложения не поддерживаются вовсе: `features.attachments`
  всегда `false`, а `startTurn` с непустым `attachments` возвращает `ok:false` с
  кодом `UNSUPPORTED_OPERATION`.
- Базовые снапшоты в синк-фиде ленивые: при подписке отдаются
  `session.inventory.begin`, состояния живых сессий и `session.inventory.complete`,
  а полная история сессии уходит `snapshot.begin/items/commit` по первому живому
  событию, по `runtime.sync.refresh`, при пропуске seq или при исчезновении
  элементов. AA делает то же самое, но узел обязан запросить снапшот сам -
  телефон это и делает при открытии чата.
- Менеджер-блокировки TCP-порта (как `acquireManagerLock` у AA) не реализуется:
  вместо неё проверка живого pid при записи `endpoint.json` и отказ
  перехватывать чужой файл.
- `metadata.readOnly` в `session.list` считается от наличия `sessionController`
  (у AA - от наличия `agents`); телефон это поле не читает.
- Заголовки сессий берутся из официального `readTitleSnapshots`, а при его
  отсутствии - из последнего события `session/title` в логе. Свой фолбэк на
  «первое сообщение как заголовок» не добавлен: это было бы выдуманное данное.
- web-половина отправляет ход через композитор Lexical и только в ту сессию,
  которая открыта в десктопе. Если id не совпал или открытая сессия неизвестна,
  она возвращает `session_mismatch` / `active_session_unknown` вместо отправки
  не в тот чат. Полноценная отправка - у host-половины (`sessionController`).
- Python-узел (`dsh-phone/gateway.py`) знает про оба TCP-endpoint'а и пробует их
  в том же порядке, но HTTP-канал плагина реализован только в Rust-узле.

## Риски: формы API DSH, которые нечем подтвердить

Перечисленное ниже взято из скомпилированного кода AA (`native.ts` / `source.ts` /
`configuration.ts` / `catalogs.ts` в составе `@agents-anywhere/dsh-bridge-next`) и
обёрнуто в защиту: если форма окажется другой, плагин отдаст меньше данных или
`UNSUPPORTED_OPERATION`, но не упадёт.

- `sessionPersistence.stat(id)` → `{revision}`: используется только как ключ кэша
  видимости. Без него видимость пересчитывается чтением лога.
- `sessionProjections.snapshot(live, [...])` и `.restore({}, events, 0, header,
  inherited)`: источник модели/прав/пресета. `restore` вызывается в try/catch,
  потому что `SessionLogOffset(0)` из внутреннего пакета DSH нам недоступен.
- Наблюдение `observeSession(id, {projectionMode:"none"})`: поля `retain()` и
  `[Symbol.dispose]()`; если их нет, handle закрывается прежним способом.
- `readTitleSnapshots(ids, signal)` → `[{sessionId, status, value:{title:{title}}}]`.
- Событие `domain/changed` → `{domain:"workspace", value:{archivedSessionIds}}`.
- `agent/assistant-stream` → `{agent, frame}` с `frame.type` и `attemptId`.
- `resolveAgent(id)` → `{agent}` либо `{error}`.
- `commands.execute(agent, "/permission x", [], signal)` → `{result:{kind:"success"}}`.
- Поток вопросов: кадры `ready` / `waterfall` / `cancel`, событие
  `user-questions/request`, конверт `$events/result`.
- Старт web-половины происходит только из `exports.apply(ctx)` - контракт
  dsh-client-modules, тот же, на котором жил `dsh-draft-sync`. Если загрузчик
  когда-нибудь перестанет звать `apply` для этого ряда бандлов, умрёт только
  web-канал: host-половина с TCP-мостом стартует независимо от веб-клиента.
- Реакцию Lexical на `execCommand("insertText")` и на программный Enter, настоящие
  фазы capture/bubble и видимость вкладки проверить без браузера нечем: в
  `web-client.test.js` на этих местах честные заглушки, и ассертов на поведение
  редактора там нет намеренно.
