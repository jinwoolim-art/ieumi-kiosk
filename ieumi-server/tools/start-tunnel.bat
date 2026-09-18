@echo off
REM ============================================================================
REM  start-tunnel.bat -- expose the Korea relay through a Cloudflare quick
REM  tunnel, with auto-restart.
REM
REM  The URL is EPHEMERAL: it changes every time this starts. It is printed
REM  here and saved to tunnel_url.txt next to this file.
REM
REM  Start the relay FIRST, in its own window: tools\start-relay.bat
REM
REM  Needs cloudflared.exe on PATH or next to this file:
REM  https://github.com/cloudflare/cloudflared/releases
REM
REM  Pure ASCII on purpose -- see the note in start-relay.bat.
REM ============================================================================
setlocal
cd /d "%~dp0"

set PORT=8799
if not "%KOREA_RELAY_PORT%"=="" set PORT=%KOREA_RELAY_PORT%

REM ---- find cloudflared ------------------------------------------------------
REM  The release page hands you a file called cloudflared-windows-amd64.exe, not
REM  cloudflared.exe. Accept it under the downloaded name too -- renaming it is
REM  one more step to forget, and the failure looks identical to not having it.
set CFD=
where cloudflared >nul 2>nul && set CFD=cloudflared
if "%CFD%"=="" if exist "%~dp0cloudflared.exe"                    set CFD=%~dp0cloudflared.exe
if "%CFD%"=="" if exist "%~dp0cloudflared-windows-amd64.exe"      set CFD=%~dp0cloudflared-windows-amd64.exe
if "%CFD%"=="" if exist "%~dp0cloudflared-windows-386.exe"        set CFD=%~dp0cloudflared-windows-386.exe
if "%CFD%"=="" if exist "%USERPROFILE%\Downloads\cloudflared-windows-amd64.exe" set CFD=%USERPROFILE%\Downloads\cloudflared-windows-amd64.exe
if "%CFD%"=="" if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set CFD=%ProgramFiles%\cloudflared\cloudflared.exe
if "%CFD%"=="" if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set CFD=%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe

if "%CFD%"=="" (
  echo.
  echo   cloudflared was not found.
  echo.
  echo   On the releases page, click "Show all 28 assets" at the bottom --
  echo   the Windows builds are hidden until you do. Download:
  echo.
  echo       cloudflared-windows-amd64.exe
  echo.
  echo   Then drop it in this folder:
  echo       %~dp0
  echo   No renaming and no installing needed. Run this file again.
  echo.
  echo   https://github.com/cloudflare/cloudflared/releases
  echo.
  pause
  exit /b 1
)

echo   using cloudflared: %CFD%

REM ---- is the relay actually up? ---------------------------------------------
REM  A tunnel to a port with nothing behind it looks like it worked, and then
REM  every request 502s, which is a confusing way to find out.
curl -s -o nul -m 3 "http://localhost:%PORT%/health" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Nothing is answering on http://localhost:%PORT%
  echo       Start tools\start-relay.bat first, in its own window.
  echo       Continuing anyway in 5s...
  echo.
  timeout /t 5 /nobreak >nul
)

:loop
echo.
echo [%date% %time%] opening tunnel to http://localhost:%PORT%
echo.
"%CFD%" tunnel --url http://localhost:%PORT% 2>&1 | powershell -NoProfile -Command "$input | ForEach-Object { $_; if ($_ -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $u = $Matches[0]; $u | Out-File -Encoding ascii tunnel_url.txt; Write-Host ''; Write-Host ('  TUNNEL URL (saved to tunnel_url.txt): ' + $u) -ForegroundColor Green; Write-Host ''; Write-Host '  Put these two lines in ieumi-server\.env ON YOUR OWN MACHINE:' -ForegroundColor Yellow; Write-Host ('    KOREA_RELAY_URL=' + $u) -ForegroundColor Cyan; Write-Host '    KOREA_RELAY_TOKEN=(same value as .env on this Korea box)' -ForegroundColor Cyan; Write-Host '' } }"
echo.
echo [%date% %time%] tunnel exited -- restarting in 5s [Ctrl+C to stop]
timeout /t 5 /nobreak >nul
goto loop
