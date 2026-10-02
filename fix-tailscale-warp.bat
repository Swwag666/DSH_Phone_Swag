@echo off
chcp 65001 >nul
title DSH Phone - Tailscale + WARP

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Нужны права админа - сейчас спросит UAC, нажми Да.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo === фикс: tailscale не должен лезть по IPv6, который блокирует WARP ===
echo.

powershell -NoProfile -Command ^
  "$h = 'C:\Windows\System32\drivers\etc\hosts';" ^
  "$want = @('192.200.0.108 controlplane.tailscale.com','192.200.0.113 login.tailscale.com','::2 controlplane.tailscale.com','::2 login.tailscale.com');" ^
  "$lines = @(Get-Content $h);" ^
  "$add = @($want | Where-Object { $lines -notcontains $_ });" ^
  "if ($add.Count -gt 0) { Add-Content -Path $h -Value ($add -join [char]10); Write-Host ('hosts: добавлено строк - ' + $add.Count) } else { Write-Host 'hosts: уже на месте' }"

echo.
echo === перезапуск службы Tailscale ===
net stop Tailscale 2>nul
net start Tailscale
timeout /t 4 /nobreak >nul

echo.
echo === логин: сейчас появится ссылка - открой её в браузере и разреши устройство ===
"C:\Program Files\Tailscale\tailscale.exe" login
echo.
echo === статус: ===
"C:\Program Files\Tailscale\tailscale.exe" status
echo.
echo Если выше появился IP вида 100.x.x.x - всё живое. Закрывай окно
echo и в DSH Phone заглуши и подними узел - он подхватит адрес сам.
pause
