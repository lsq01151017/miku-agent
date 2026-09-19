@echo off
rem ============================================================
rem  Hatsune Miku Agent - Launcher
rem  NOTE: keep this file ASCII-only. cmd.exe parses .bat using the
rem  OEM codepage (GBK on zh-CN Windows); UTF-8 Chinese text here
rem  corrupts the commands. Chinese output comes from Python, which
rem  handles its own UTF-8 encoding.
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY=%~dp0venv\Scripts\python.exe"

echo ============================================================
echo   Hatsune Miku Agent  (Lv1 + Lv2)
echo ============================================================
echo.

rem ---------- 1) locate the venv interpreter ----------
if not exist "%PY%" (
    echo [ERROR] Virtualenv not found:
    echo         %PY%
    echo.
    echo         Create it first:
    echo             python -m venv venv
    echo             venv\Scripts\python.exe -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

rem ---------- 2) make sure Ollama is up ----------
"%PY%" -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:11434/api/tags',timeout=3)" 1>nul 2>nul
if not errorlevel 1 (
    echo [1/2] Ollama is already running.
    goto :check_model
)

echo [1/2] Ollama is not running. Starting it ...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    start "Ollama" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
) else (
    start "Ollama" /min ollama serve
)

echo       Waiting for Ollama to become ready ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 40;$i++){try{Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; exit 0}catch{Start-Sleep -Seconds 1}}; exit 1"
if errorlevel 1 (
    echo       [WARN] Ollama is slow to start. Continuing anyway.
) else (
    echo       Ollama is ready.
)

:check_model
rem ---------- 3) show which local models are available ----------
"%PY%" -c "import json,urllib.request;d=json.load(urllib.request.urlopen('http://127.0.0.1:11434/api/tags',timeout=5));print('      Local models: '+', '.join(m['name'] for m in d.get('models',[])))" 2>nul

echo [2/2] Starting the agent ...
echo.
"%PY%" main.py %*

echo.
echo Agent exited. Memory and state were saved (memory.db / state.json).
echo.
pause
endlocal
