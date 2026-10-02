@echo off
chcp 65001 >nul
rem Запуск гейтвея dsh-phone. Python берём из venv AA (там он точно есть),
rem но гейтвей сам по себе использует только стандартную библиотеку.
set PY="%USERPROFILE%\.agentsanywhere\dsh-bridge-next\connector-venv\Scripts\python.exe"
if not exist %PY% set PY=python
cd /d "%~dp0"
%PY% gateway.py
pause