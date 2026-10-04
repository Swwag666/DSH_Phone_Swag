# DSH Phone — нативные оболочки (Capacitor)

Обёртка PWA из `../web` в нативные приложения Android и iOS через Capacitor 6.
Веб-часть не меняется: service worker, manifest и Web Push работают внутри
webview (androidScheme https, чтобы SW зарегистрировался).

## Структура

- `capacitor.config.json` — appId `com.rustvy.dshphone`, webDir `../web`.
- `android/` — Gradle-проект; web-ассеты лежат в `app/src/main/assets/public/`.
- `ios/` — Xcode-проект; web-ассеты лежат в `App/App/public/`.

## Команды

```bash
pnpm install          # зависимости Capacitor
npx cap sync          # скопировать ../web в android/ и ios/ (после правок web)
npx cap open android  # открыть в Android Studio
npx cap open ios      # открыть в Xcode (только macOS)
npx cap run android   # собрать и запустить на устройстве/эмуляторе
```

На Windows `npx` может упираться в ExecutionPolicy — зови через `cmd /c "npx ..."`.

## Требования для сборки

- **Android (APK/AAB):** JDK 17+, Android SDK (`ANDROID_HOME`), Android Studio.
  Debug: `cd android && gradlew assembleDebug`. Release: `gradlew bundleRelease`
  + подпись keystore.
- **iOS (IPA):** macOS + Xcode 15+. На Windows собрать iOS физически нельзя.

## Публикация в сторы

- **Google Play:** аккаунт разработчика ($25 разово), подписанный AAB, загрузка
  в Play Console, прохождение ревью.
- **App Store:** Apple Developer Program ($99/год), сертификаты и provisioning
  profiles, загрузка через Xcode/Transporter, ревью Apple.

Сборка и публикация требуют среды и аккаунтов, которых нет в CI этой машины,
поэтому в репозитории лежит готовый к сборке проект, а не бинарники сторов.

## Пуши в нативной оболочке

Сейчас пуши идут через Web Push прямо в webview (sw.js + push-подписка на узел).
Если захочется нативные пуши (работают при убитом webview), подключается
`@capacitor/push-notifications` и пробрасывается в тот же sw.js-флоу.
