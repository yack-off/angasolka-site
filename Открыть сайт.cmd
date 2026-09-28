@echo off
cd /d "%~dp0"
rem Local site preview does not start the Telegram worker.
set "TELEGRAM_ENABLED=false"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"
pause

