@echo off
rem Double-click launcher for the miku deployment. ASCII only: cmd reads this in the console
rem codepage. The real work is scratch\start-miku.ps1; this only sets the window up.
rem
rem Success closes the window by itself after a few seconds (the browser is opening anyway);
rem failure keeps it open so the message can be read.
cd /d "%~dp0cortico"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cortico\scratch\start-miku.ps1"
if errorlevel 1 goto failed
echo.
echo (this window closes by itself; her page is opening in your browser)
if "%~1"=="" timeout /t 6 >nul
exit /b 0

:failed
echo.
echo Something went wrong - the message above matters, so this window stays open.
if "%~1"=="" pause
exit /b 1
