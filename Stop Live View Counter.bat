@echo off
title Stop Live View Counter
cd /d "%~dp0"
node server.js --stop
timeout /t 3 >nul
