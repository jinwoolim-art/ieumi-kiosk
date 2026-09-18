@echo off
REM ============================================================================
REM  start-kiosk.bat -- run the Ieumi app server itself, with auto-restart.
REM
REM  This is NOT the relay. The relay (start-relay.bat) only fetches pages for
REM  the nightly link sync. This runs the kiosk the client actually talks to.
REM
REM  Run this on the Korea box, then tools\share-kiosk.bat in a SECOND window
REM  to get a link you can send to the client.
REM
REM  Keys go in ieumi-server\.env -- NOT IN THIS FILE. .env is gitignored;
REM  this .bat is not, so anything written here would be committed.
REM
REM  Pure ASCII on purpose -- see the note in start-relay.bat.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

REM ---- find node -------------------------------------------------------------
REM  NODE holds a BARE path with no quotes; quote at the point of use only.
set NODE=
where node >nul 2>nul && set NODE=node
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe"          set NODE=%ProgramFiles%\nodejs\node.exe
if "%NODE%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe"     set NODE=%ProgramFiles(x86)%\nodejs\node.exe
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe
if "%NODE%"=="" if exist "%APPDATA%\nvm\current\node.exe"          set NODE=%APPDATA%\nvm\current\node.exe

if "%NODE%"=="" (
  echo.
  echo   Node.js was not found.
  echo.
  echo   1. Install it from https://nodejs.org   [LTS is fine]
  echo   2. IMPORTANT: after installing, CLOSE this window and open a new one.
  echo      Windows only gives the new PATH to programs started afterwards.
  echo.
  pause
  exit /b 1
)

REM ---- are the dependencies installed? -------------------------------------
REM  The relay needs nothing but Node, so a machine that runs start-relay.bat
REM  perfectly well can still have no node_modules. The failure then arrives as
REM  a stack trace ending in "Cannot find module pg", which never says the one
REM  thing you need to do about it.
if not exist "node_modules\pg" (
  echo.
  echo   [!] Dependencies are not installed in this folder.
  echo       The relay needs only Node, so this is easy to miss.
  echo.
  echo   Run this once, here, then start this file again:
  echo       npm install --omit=dev
  echo.
  pause
  exit /b 1
)

REM ---- check the keys --------------------------------------------------------
REM  Each of these fails in its own quiet way, and all three look the same from
REM  the front: Ieumi appears, then says it cannot answer. Better to see it here.
REM    DATABASE_URL      no catalogue at all
REM    ANTHROPIC_API_KEY every question answers "I cannot answer right now"
REM    CLOVA_API_KEY_ID  no voice, and no speech recognition
if not exist ".env" (
  echo.
  echo   [!] ieumi-server\.env does not exist. The server needs at least:
  echo         DATABASE_URL=postgres://...
  echo         ANTHROPIC_API_KEY=sk-ant-...
  echo         CLOVA_API_KEY_ID=...
  echo         CLOVA_API_KEY=...
  echo.
  pause
  exit /b 1
)
for %%K in (DATABASE_URL ANTHROPIC_API_KEY CLOVA_API_KEY_ID CLOVA_API_KEY) do (
  findstr /b /c:"%%K=" .env >nul 2>nul || echo   [!] %%K is not in .env
)

REM ---- running in Korea? then the relay is dead weight ------------------------
REM  KOREA_RELAY_URL routes every page fetch through the relay and a Cloudflare
REM  tunnel. That exists for running the app abroad. On a Korea box it is a
REM  needless extra hop on every fetch, and the page sync pays it hundreds of
REM  times -- measured in hours, not minutes.
findstr /b /c:"KOREA_RELAY_URL=http" .env >nul 2>nul && (
  echo.
  echo   [!] KOREA_RELAY_URL is set in .env.
  echo       If THIS machine is in Korea you do not need it. Delete the
  echo       KOREA_RELAY_URL and KOREA_RELAY_TOKEN lines from .env and the
  echo       page sync gets much faster. Then you can also stop
  echo       start-relay.bat and start-tunnel.bat for good.
  echo.
)

REM ---- the address to hand out ----------------------------------------------
REM  The ?c= token identifies the centre. Mistyping it does not fail -- the page
REM  loads and quietly serves another centre's catalogue -- so it is printed.
set KPATH=
for /f "usebackq delims=" %%U in (`"%NODE%" tools\kiosk-url.js 2^>nul`) do set KPATH=%%U
if not "%KPATH%"=="" (
  echo.
  echo   kiosk on this machine:  http://localhost:8791%KPATH%
)

:loop
echo.
echo [%date% %time%] starting the Ieumi server on port 8791
echo.
"%NODE%" server.js
echo.
echo [%date% %time%] server exited -- restarting in 5s [Ctrl+C to stop]
timeout /t 5 /nobreak >nul
goto loop
