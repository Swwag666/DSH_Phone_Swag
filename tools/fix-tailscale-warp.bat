@echo off
chcp 65001 >nul
title DSH Phone - Tailscale + WARP fix

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting admin rights - accept the UAC prompt.
  powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0fix-tw.ps1'"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-tw.ps1"
pause
