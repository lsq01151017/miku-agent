@echo off
rem Double-click launcher for the GPT-SoVITS inference webui (gradio, port 9872).
rem ASCII only: cmd reads this in the console codepage. The browser opens by itself;
rem closing this window stops the webui.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\run-webui.ps1"
if "%~1"=="" pause
