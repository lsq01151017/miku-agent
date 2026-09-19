@echo off
rem Double-click stopper for the miku deployment. Stops whatever holds the console or the
rem avatar port, waits until both ports and the instance lock are really free, then closes.
cd /d "%~dp0cortico"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cortico\scratch\start-miku.ps1" -Stop
echo.
echo (this window closes by itself)
if "%~1"=="" timeout /t 4 >nul
