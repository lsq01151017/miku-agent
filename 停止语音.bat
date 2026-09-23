@echo off
rem Double-click stopper for the miku TTS service (port 9880).
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\二面\voice\stop-tts.ps1"
if "%~1"=="" timeout /t 3 >nul
exit /b 0
