@echo off
REM ============================================================================
REM  share-kiosk.bat -- put the kiosk on a public HTTPS address you can send.
REM
REM  Start tools\start-kiosk.bat FIRST, in its own window.
REM
REM  THE ADDRESS IS TEMPORARY. It changes every time this restarts, and it dies
REM  when this window closes or the machine sleeps. Good for a testing session
REM  with someone on a call; not something to put in a document.
REM
REM  ANYONE WITH THE LINK CAN USE IT. There is no password on the kiosk -- by
REM  design, since a senior standing in front of a screen cannot sign in. Every
REM  conversation spends Anthropic and CLOVA credit, so hand the address to the
REM  people testing and close this window when they are done.
REM
REM  Needs cloudflared.exe on PATH or next to this file:
REM  https://github.com/cloudflare/cloudflared/releases
REM
REM  Pure ASCII on purpose -- see the note in start-relay.bat.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

set PORT=8791
if not "%PORT_OVERRIDE%"=="" set PORT=%PORT_OVERRIDE%

REM ---- find node (only to read the centre token) ------------------------------
set NODE=
where node >nul 2>nul && set NODE=node
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe"          set NODE=%ProgramFiles%\nodejs\node.exe
if "%NODE%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe"     set NODE=%ProgramFiles(x86)%\nodejs\node.exe
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe
if "%NODE%"=="" if exist "%APPDATA%\nvm\current\node.exe"          set NODE=%APPDATA%\nvm\current\node.exe

REM ---- find cloudflared ------------------------------------------------------
REM  The release page hands you cloudflared-windows-amd64.exe, not
REM  cloudflared.exe. Accept it under the downloaded name too.
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
  echo       cloudflared-windows-amd64.exe
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

REM ---- is the server actually up? --------------------------------------------
REM  A tunnel to a port with nothing behind it looks like it worked, and then
REM  every request 502s, which is a confusing way to find out.
curl -s -o nul -m 3 "http://localhost:%PORT%/health" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Nothing is answering on http://localhost:%PORT%
  echo       Start tools\start-kiosk.bat first, in its own window.
  echo       Continuing anyway in 5s...
  echo.
  timeout /t 5 /nobreak >nul
)

REM ---- the ?c= token, read once before the tunnel opens ----------------------
set KPATH=/kiosk
if not "%NODE%"=="" for /f "usebackq delims=" %%U in (`"%NODE%" tools\kiosk-url.js 2^>nul`) do set KPATH=%%U

:loop
echo.
echo [%date% %time%] opening tunnel to http://localhost:%PORT%
echo.
"%CFD%" tunnel --url http://localhost:%PORT% 2>&1 | powershell -NoProfile -Command "$input | ForEach-Object { $_; if ($_ -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $u = $Matches[0]; $link = $u + '%KPATH%'; $link | Out-File -Encoding ascii kiosk_url.txt; Write-Host ''; Write-Host '  ================================================================'; Write-Host '  SEND THIS LINK (also saved to ieumi-server\kiosk_url.txt):' -ForegroundColor Yellow; Write-Host ('  ' + $link) -ForegroundColor Green; Write-Host '  ================================================================'; Write-Host '  Microphone needs this HTTPS address -- not the localhost one.'; Write-Host '  Temporary: it dies when this window closes.' -ForegroundColor DarkYellow; Write-Host '' } }"
echo.
echo [%date% %time%] tunnel exited -- restarting in 5s [Ctrl+C to stop]
echo     NOTE: the address CHANGES on restart. Send the new one.
timeout /t 5 /nobreak >nul
goto loop
