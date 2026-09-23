@echo off
rem Double-click launcher for the local translate service (zh->ja for TTS, port 9882).
rem ASCII only: cmd reads this in the console codepage. The service is spawned
rem detached (WMI), so it keeps running after this window closes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\spawn-translate.ps1"
echo Waiting for the service on port 9882 (first request calls the LLM, seconds)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok = $false; foreach ($i in 1..30) { try { $c = New-Object System.Net.Sockets.TcpClient; $t = $c.ConnectAsync('127.0.0.1', 9882); if ($t.Wait(1000) -and $c.Connected) { $ok = $true; break } } catch {} }; if ($ok) { Write-Host 'translate service is UP on http://127.0.0.1:9882' } else { Write-Host 'service did not come up within 30s - check voice\translate-server.log' }"
if "%~1"=="" timeout /t 3 >nul
exit /b 0
