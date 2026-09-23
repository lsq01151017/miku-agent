@echo off
rem Double-click stopper for the local ASR service (port 9881).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\stop-asr.ps1"
if "%~1"=="" timeout /t 3 >nul
exit /b 0
