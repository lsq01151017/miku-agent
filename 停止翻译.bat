@echo off
rem Double-click stopper for the local translate service (port 9882).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\stop-translate.ps1"
if "%~1"=="" timeout /t 3 >nul
exit /b 0
