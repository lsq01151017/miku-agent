@echo off
rem Double-click launcher for the miku TTS service (GPT-SoVITS api_v2, port 9880).
rem ASCII only: cmd reads this in the console codepage. The service is spawned
rem detached (WMI), so it keeps running after this window closes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\spawn-tts.ps1"
echo Waiting for the service on port 9880 (first start loads models, ~1 min)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = New-Object System.Net.Sockets.TcpClient; $ok = $false; foreach ($i in 1..90) { try { $t = $c.ConnectAsync('127.0.0.1', 9880); if ($t.Wait(1000) -and $c.Connected) { $ok = $true; break } } catch {} }; if ($ok) { Write-Host 'TTS service is UP on http://127.0.0.1:9880' } else { Write-Host 'service did not come up within 90s - check voice\tts-server.log' }"
if "%~1"=="" timeout /t 3 >nul
exit /b 0
