# DSH Phone

Своя замена облаку Agents Anywhere: телефон (iPhone/Android) видит и управляет
сессиями DeepSeek Harness на ПК напрямую, через Tailscale. Никакого чужого
облака, никаких китайских воркеров и TLS-сбросов.

## Устройство

- `gateway.py` — гейтвей на ПК (только stdlib Python): подключается к локальному
  мосту DSH (`~/.dsh/agents-anywhere/bridge/endpoint.json`, raw TCP JSON-RPC) и
  отдаёт на телефон HTTP-API + long-poll события под токеном.
- `web/` — PWA-клиент (index.html, app.js, style.css, manifest, sw).
- `config.json` — настройки и токен (создаётся при первом запуске).
- `probe.py` — отладочный зонд моста (не нужен в работе).

Мост DSH даёт всё необходимое: `workspace.list`, `session.list`,
`session.getSnapshot`, `session.getState`, `session.startTurn`,
`session.interrupt`, `session.respondInteraction`, `session.updateSelections`,
`catalog.*`, `runtime.getCapabilities`.

## Запуск на ПК

```bat
run.bat
```

или `python gateway.py`. В консоли и в `config.json` будет `gatewayToken` —
его вводишь один раз на телефоне.

## Подключение телефона

1. Поставь Tailscale на телефон, войди тем же аккаунтом, что на ПК
   (узнай IP ПК: `tailscale ip -4`).
2. В браузере телефона открой `http://<IP-ПК>:8460/`.
3. Вставь токен — появится список проектов и сессий.
4. «Поделиться → На экран "Домой"» — получится приложение-иконка.

## Что умеет сейчас (MVP)

- список проектов (`workspace.list`) и сессий, группировка по cwd;
- история сообщений сессии (poll + long-poll дельты);
- отправка сообщения (`session.startTurn`), остановка (`session.interrupt`);
- ответы на вопросы/апрувы агента (`session.getNotices` + `respondInteraction`);
- статус сессии (idle / working / waiting_approval).

## Ограничения и следующие шаги

- Обновления приходят поллингом ~1-2 c (не WebSocket) — для чата достаточно.
- Токен и один клиент; мультиаккаунт/несколько телефонов не сделаны.
- Мост пока берём у плагина AA (он нужен только локально). Дальше: свой плагин
  DSH (полная независимость от AA), пуши, нативные оболочки (Capacitor), сторы.