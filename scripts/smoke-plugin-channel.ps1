<#
.SYNOPSIS
  Смоук HTTP-канала нативного плагина dsh-phone-bridge (web-половина).

.DESCRIPTION
  Поднимает узел dsh-phone на временном конфиге и прогоняет
  tests\smoke_plugin_channel.cjs: hello -> health(bridgeChannel=plugin) ->
  long-poll команд -> ответ через ingest(type=result) -> event-feed -> RPC
  телефона через тот же канал.

  Важно: TCP-кандидаты в конфиге намеренно указывают на несуществующие файлы.
  Иначе живой мост (Agents Anywhere или наш host-плагин) перехватит все вызовы,
  и HTTP-канал плагина не будет проверен вовсе: runtime_call предпочитает TCP.

  Боевой конфиг (~/.dsh-phone) не читается и не меняется: используется
  DSH_PHONE_CONFIG_DIR во временной папке.

.PARAMETER Exe
  Путь к бинарю узла. По умолчанию debug-сборка из target\debug.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\smoke-plugin-channel.ps1
#>
param(
    [string]$Exe = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) {
    $Exe = Join-Path $root "dsh-phone-desktop\src-tauri\target\debug\dsh-phone.exe"
}
$script = Join-Path $root "dsh-phone-desktop\src-tauri\tests\smoke_plugin_channel.cjs"
if (-not (Test-Path $Exe)) { throw "бинарь узла не найден: $Exe (сначала cargo build)" }
if (-not (Test-Path $script)) { throw "смоук-скрипт не найден: $script" }

$tmp = Join-Path $env:TEMP ("dshsmoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$env:DSH_PHONE_CONFIG_DIR = $tmp
$cfgPath = Join-Path $tmp "config.json"
$exit = 1

function Wait-Health([int]$tries = 60) {
    for ($i = 0; $i -lt $tries; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:8460/api/health" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
    }
    return $false
}

# Узел не должен остаться висеть после смоука, даже если скрипт упадёт.
$proc = $null
try {
    Get-Process dsh-phone -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 1

    # Фаза 1: даём узлу создать конфиг (токен, staging, ключи push).
    $proc = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden
    if (-not (Wait-Health)) { throw "узел не поднял /api/health за 30 с" }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc = $null
    Start-Sleep 1
    if (-not (Test-Path $cfgPath)) { throw "конфиг не создан: $cfgPath" }

    # Фаза 2: выключаем обоих TCP-кандидатов, чтобы канал плагина был единственным.
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    $cfg.bridge_endpoint_path = Join-Path $tmp "disabled-agents-anywhere-endpoint.json"
    $cfg.plugin_bridge_endpoint_path = Join-Path $tmp "disabled-plugin-endpoint.json"
    # Пишем без BOM: Set-Content -Encoding UTF8 в Windows PowerShell 5.1 добавляет
    # BOM, а serde_json на ней падает - узел не смог бы прочитать свой конфиг.
    $json = $cfg | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    $token = $cfg.token
    if (-not $token) { throw "в конфиге нет токена" }
    Write-Host "узел: $Exe"
    Write-Host "конфиг: $cfgPath (порт $($cfg.listen_port), TCP-мосты отключены)"

    $proc = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden
    if (-not (Wait-Health)) { throw "узел не поднял /api/health после правки конфига" }

    $env:SMOKE_BASE = "http://127.0.0.1:8460"
    $env:SMOKE_TOKEN = $token
    node $script
    $exit = $LASTEXITCODE
    Write-Host "smoke exit=$exit"
} finally {
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process dsh-phone -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 1
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\DSH_PHONE_CONFIG_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\SMOKE_BASE -ErrorAction SilentlyContinue
    Remove-Item Env:\SMOKE_TOKEN -ErrorAction SilentlyContinue
}
exit $exit
