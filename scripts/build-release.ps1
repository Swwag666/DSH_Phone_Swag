<#
  Локальная сборка релиза DSH Phone с подписью автообновления.

  Зачем скрипт: tauri.conf.json теперь содержит createUpdaterArtifacts: true,
  а значит bundler обязан подписать артефакты и упадёт без TAURI_SIGNING_*.
  Скрипт берёт приватный ключ и пароль из профиля пользователя (вне репозитория,
  чтобы их нельзя было закоммитить), собирает бандл и раскладывает артефакты
  в releases\.

  Использование:
      pwsh -File scripts\build-release.ps1            # собрать
      pwsh -File scripts\build-release.ps1 -Sign      # собрать и подписать апдейтер
      pwsh -File scripts\build-release.ps1 -Latest    # ещё и собрать latest.json

  Ключ генерится один раз (он уже лежит в ~/.dsh-phone-updater):
      npx tauri signer generate -w <путь>\dsh-phone-updater.key
#>
[CmdletBinding()]
param(
    # Подписать артефакты апдейтера. Без этого бандл соберётся, но .sig не будет,
    # то есть автообновление этой сборкой не проверить.
    [switch]$Sign,
    # Собрать latest.json - манифест, который читает updater в приложении.
    [switch]$Latest,
    [string]$KeyDir = (Join-Path $env:USERPROFILE '.dsh-phone-updater')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'dsh-phone-desktop'
$tauriProj = Join-Path $desktop 'src-tauri'

Write-Host "== DSH Phone: сборка релиза ==" -ForegroundColor Cyan
Write-Host "репозиторий: $root"

# --- 0. узел не должен держать exe -----------------------------------------
$running = Get-Process dsh-phone -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "останавливаю запущенный dsh-phone (иначе линкер получит os error 5)"
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# --- 1. ключ подписи ---------------------------------------------------------
$keyPath = Join-Path $KeyDir 'dsh-phone-updater.key'
$pwPath = Join-Path $KeyDir 'password.txt'

if ($Sign) {
    if (-not (Test-Path $keyPath)) {
        throw "нет приватного ключа: $keyPath`nсгенерируй: npx tauri signer generate -w `"$keyPath`""
    }
    if (-not (Test-Path $pwPath)) {
        throw "нет файла пароля: $pwPath"
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $pwPath -Raw).Trim()
    Write-Host "подпись: ключ загружен" -ForegroundColor Green
} else {
    Write-Host "подпись выключена (-Sign не передан): bundler не подпишет апдейтер" -ForegroundColor Yellow
    # пустые значения - иначе tauri возьмёт их из окружения и соберёт .sig молча
    $env:TAURI_SIGNING_PRIVATE_KEY = ''
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

# --- 2. фронтенд -------------------------------------------------------------
# generate_context! встраивает ../dist, поэтому фронт обязан собраться раньше cargo
Write-Host "== собираю фронтенд ==" -ForegroundColor Cyan
Push-Location $desktop
try {
    & pnpm run build
    if ($LASTEXITCODE -ne 0) { throw "pnpm run build упал ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

# --- 3. бандл ----------------------------------------------------------------
Write-Host "== собираю бандл (это медленно) ==" -ForegroundColor Cyan
Push-Location $desktop
try {
    & ".\node_modules\.bin\tauri.cmd" build
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) { throw "tauri build упал ($code)" }

# --- 4. раскладка артефактов -------------------------------------------------
$rel = Join-Path $root 'releases'
New-Item -ItemType Directory -Force -Path $rel | Out-Null

$ver = (Get-Content (Join-Path $tauriProj 'tauri.conf.json') -Raw | ConvertFrom-Json).version
$nsis = Join-Path $tauriProj 'target\release\bundle\nsis'
$exe = Get-ChildItem (Join-Path $tauriProj 'target\release\dsh-phone.exe') -ErrorAction SilentlyContinue

# В папке nsis лежат установщики всех прошлых версий, и сортировка по имени
# даёт 0.1.0 раньше 0.3.0 - так в releases однажды уехал древний сетап.
# Берём строго файл текущей версии, а если его нет - самый свежий по времени.
function Pick-Artifact {
    param([string]$Dir, [string]$Pattern, [string]$MustContain)
    $all = @(Get-ChildItem $Dir -Filter $Pattern -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) { return $null }
    $exact = $all | Where-Object { $_.Name -like "*$MustContain*" }
    if ($exact) { return ($exact | Sort-Object LastWriteTime -Descending | Select-Object -First 1) }
    return ($all | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

$setup = Pick-Artifact $nsis '*-setup.exe' $ver
# .sig обязан относиться к тому же сетапу, иначе подпись не сойдётся с файлом
$sig = if ($setup) {
    $want = $setup.Name + '.sig'
    $s = Get-ChildItem (Join-Path $nsis $want) -ErrorAction SilentlyContinue
    if (-not $s) { Pick-Artifact $nsis '*.sig' $ver } else { $s }
} else { $null }

if ($setup -and $setup.Name -notlike "*$ver*") {
    Write-Warning "найден сетап $($setup.Name), а версия в конфиге $ver - проверь, что сборка свежая"
}

if ($exe) { Copy-Item $exe.FullName (Join-Path $rel 'dsh-phone.exe') -Force }
if ($setup) {
    Copy-Item $setup.FullName (Join-Path $rel 'dsh-phone-setup.exe') -Force
    Write-Host "в releases уехал: $($setup.Name)" -ForegroundColor Green
}

# --- 5. latest.example.json --------------------------------------------------
# Шаблон манифеста для updater. Боевой latest.json в релиз кладёт tauri-action;
# этот файл нужен, чтобы проверить автообновление локально, положив его на свой
# https и подставив реальный url.
if ($Latest) {
    if (-not $setup) { throw "нет setup.exe - манифест собирать не из чего" }
    if (-not $sig) { throw "нет .sig - подпиши сборку флагом -Sign" }
    $sigText = (Get-Content $sig.FullName -Raw).Trim()
    # url специально условный: для локальной проверки подставь свой https-адрес
    $manifest = [ordered]@{
        version  = $ver
        notes    = "локальная сборка $ver"
        pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = [ordered]@{
            'windows-x86_64' = [ordered]@{
                signature = $sigText
                url       = "https://example.invalid/DSH-Phone_$($ver)_x64-setup.exe"
            }
        }
    }
    # UTF8 без BOM: Set-Content -Encoding UTF8 в Windows PowerShell 5.1 пишет
    # BOM, а updater ожидает чистый JSON - с BOM манифест не распарсится
    $json = $manifest | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText(
        (Join-Path $rel 'latest.example.json'),
        $json,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host "latest.example.json собран (поправь url на свой https-адрес)" -ForegroundColor Green
}

# --- 6. отчёт ----------------------------------------------------------------
Write-Host ""
Write-Host "== готово ==" -ForegroundColor Green
Get-ChildItem $rel | Sort-Object LastWriteTime -Descending |
    Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) }}, LastWriteTime |
    Format-Table -AutoSize
if ($sig) { Write-Host "подпись апдейтера: $($sig.Name)" -ForegroundColor Green }
