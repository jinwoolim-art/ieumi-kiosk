@echo off
REM ============================================================================
REM  start-tunnel.bat -- 한국 중계를 바깥에서 닿게 열어 줍니다 (Cloudflare 임시 터널).
REM
REM  expose the Korea relay through a Cloudflare quick tunnel, with auto-restart.
REM
REM  주소는 <실행할 때마다 바뀝니다>. 콘솔에 찍어 주고, 옆의 tunnel_url.txt 에도
REM  저장합니다. 그 주소를 ieumi-server\.env 의 KOREA_RELAY_URL 에 넣으십시오.
REM  The URL is EPHEMERAL -- it changes every start. It is printed here and saved
REM  to tunnel_url.txt next to this file; paste it into .env as KOREA_RELAY_URL.
REM
REM  먼저 start-relay.bat 으로 중계를 띄워 두십시오 (이 창과 별도로).
REM  Start the relay first, in its own window: tools\start-relay.bat
REM
REM  cloudflared.exe 가 PATH 에 있거나 이 파일 옆에 있어야 합니다:
REM  https://github.com/cloudflare/cloudflared/releases
REM ============================================================================
setlocal
cd /d "%~dp0"

set PORT=8799
if not "%KOREA_RELAY_PORT%"=="" set PORT=%KOREA_RELAY_PORT%

where cloudflared >nul 2>nul
if errorlevel 1 (
  if not exist "cloudflared.exe" (
    echo.
    echo   cloudflared 를 찾지 못했습니다 / cloudflared not found.
    echo   내려받아 PATH 에 두거나 이 폴더에 넣어 주세요:
    echo   https://github.com/cloudflare/cloudflared/releases
    echo.
    pause
    exit /b 1
  )
)

:loop
echo.
echo [%date% %time%] 터널을 엽니다 - opening tunnel to http://localhost:%PORT%
echo.
cloudflared tunnel --url http://localhost:%PORT% 2>&1 | powershell -NoProfile -Command "$input | ForEach-Object { $_; if ($_ -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $u = $Matches[0]; $u | Out-File -Encoding ascii tunnel_url.txt; Write-Host ''; Write-Host ('  TUNNEL URL (tunnel_url.txt 에 저장됨): ' + $u) -ForegroundColor Green; Write-Host ''; Write-Host '  이 두 줄을 ieumi-server\.env 에 넣으세요 / put these two lines in .env:' -ForegroundColor Yellow; Write-Host ('    KOREA_RELAY_URL=' + $u) -ForegroundColor Cyan; Write-Host '    KOREA_RELAY_TOKEN=<start-relay.bat 에서 쓴 것과 같은 값>' -ForegroundColor Cyan; Write-Host '' } }"
echo [%date% %time%] 터널이 끊겼습니다 - tunnel exited, restarting in 5s (Ctrl+C to stop)
timeout /t 5 /nobreak >nul
goto loop
