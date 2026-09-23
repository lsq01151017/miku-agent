@echo off
rem Double-click launcher for the local ASR service (faster-whisper, port 9881).
rem ASCII only: cmd reads this in the console codepage. The service is spawned
rem detached (WMI), so it keeps running after this window closes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\spawn-asr.ps1"
echo Waiting for the service on port 9881 (first start loads the model, ~30s)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok = $false; foreach ($i in 1..60) { try { $c = New-Object System.Net.Sockets.TcpClient; $t = $c.ConnectAsync('127.0.0.1', 9881); if ($t.Wait(1000) -and $c.Connected) { $ok = $true; break } } catch {} }; if ($ok) { Write-Host 'ASR service is UP on http://127.0.0.1:9881' } else { Write-Host 'service did not come up within 60s - check voice\asr-server.log' }"
if "%~1"=="" timeout /t 3 >nul
exit /b 0
