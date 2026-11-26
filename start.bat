@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title PetClaw - Surprise Capsule Server
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js 22.13 or newer.
  pause
  exit /b 1
)
node launch.cjs
echo.
echo Server stopped. Close this window or press any key.
pause >nul
endlocal
