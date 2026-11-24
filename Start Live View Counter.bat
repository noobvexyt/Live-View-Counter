@echo off
title Live View Counter
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed. Get it from https://nodejs.org and then run this again.
  echo.
  pause
  exit /b 1
)
rem Starts the counter hidden in the background (or opens it if it's already running).
rem This window closes by itself. The counter keeps running until you stop it or shut down.
node server.js --background --open
if errorlevel 1 (
  echo.
  echo   Press any key to close this window.
  pause >nul
)
