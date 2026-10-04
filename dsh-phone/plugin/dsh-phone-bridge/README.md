# dsh-phone-bridge

Нативный мост DSH: плагин для DSH Desktop (Cordis, browser-half), который отдаёт
узлу dsh-phone сессии, события и статус моста напрямую по HTTP, убирая
зависимость от моста Agents Anywhere (endpoint.json + TCP JSON-RPC).

## Как работает

- Browser-half (`lib/client.js`) грузится Cordis-лоадером DSH Desktop.
- Бутстрап: берёт токен узла через `GET /api/draft-config` (loopback + origin).
- Heartbeat: каждые 15 с шлёт `POST /api/bridge/ingest {type:"status", connected:true}`.
- Sniff: перехватывает fetch/XHR DSH Desktop и пересылает узлу снапшоты сессий и
  события синк-фида (`{type:"sessions"|"event", ...}`), схлопывая всплески.
- Узел (`server.rs /api/bridge/ingest`, токен как у `/api/rpc`) кладёт данные в
  тот же event-feed, что и bridge-уведомления; `plugin_connected` поднимает
  статус моста, поэтому узел считается подключённым без Agents Anywhere.

## Установка

Плагин кладётся в плагины DSH Desktop так же, как dsh-draft-sync:
`cordis.patch.yml` вставляет его в web-roster, объявление `dsh.client` в
package.json отдаёт `lib/client.js` через dsh-client-modules в `__DSH_BOOT__`.

## Ограничения

Полная parity с мостом AA (проксирование `session.startTurn`/`getState` обратно
в DSH Desktop и точный формат sync-feed operations) требует доступа к
бэкенд-API сессий DSH Desktop из плагина; текущая версия покрывает статус,
сессии и перехваченные события. Исходящие RPC телефона по-прежнему идут через
основной мост, если он поднят.
