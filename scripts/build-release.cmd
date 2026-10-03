@echo off
REM Обёртка над build-release.ps1.
REM
REM Зачем: в Windows по умолчанию стоит ExecutionPolicy Restricted, и .ps1
REM просто не запускается. Обёртка передаёт -ExecutionPolicy Bypass только на
REM этот процесс, ничего в системе не меняя.
REM
REM Примеры:
REM   scripts\build-release.cmd                     собрать бандл
REM   scripts\build-release.cmd -Sign               собрать и подписать апдейтер
REM   scripts\build-release.cmd -Sign -Latest       то же + latest.json
REM
REM Все аргументы пробрасываются в ps1 как есть.

setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%build-release.ps1" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
