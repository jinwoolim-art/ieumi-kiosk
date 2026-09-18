@echo off
REM ============================================================================
REM  start-relay.bat -- run the Korea fetch relay, with auto-restart.
REM
REM  All it does is open a page and hand back what it got. Korean government
REM  sites refuse foreign IPs, so doing only this from Korea lets the rest of
REM  the system live anywhere.
REM
REM  THE TOKEN GOES IN ieumi-server\.env -- NOT IN THIS FILE.
REM      KOREA_RELAY_TOKEN=<a long random string>
REM  .env is gitignored; this .bat is not, so a token written here would be
REM  committed to the repository.
REM
REM  Then run tools\start-tunnel.bat in a second window to expose it.
REM
REM  This file is deliberately pure ASCII. A Korean console is usually code
REM  page 949, which renders UTF-8 text as garbage; and calling "chcp" to fix
REM  that corrupts how cmd.exe parses the rest of the file, because it tracks
REM  its position by byte offset. Both were observed. English only avoids both.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

REM ---- do you actually need this? --------------------------------------------
REM  The relay exists so the app can live OUTSIDE Korea and still read Korean
REM  government sites. If the app runs on this same Korea box, it can open those
REM  sites itself, and routing through relay + tunnel only adds a network hop to
REM  every single page fetch -- which the nightly sync pays hundreds of times.
echo.
echo   ----------------------------------------------------------------
echo    DO YOU NEED THIS?  Only if the Ieumi server runs OUTSIDE Korea.
echo.
echo    If start-kiosk.bat runs on THIS machine, you do NOT need the
echo    relay. The server opens Korean sites directly, and going through
echo    the relay only makes the page sync slower.
echo.
echo    In that case: close this window, and delete these two lines
echo    from ieumi-server\.env:
echo        KOREA_RELAY_URL=...
echo        KOREA_RELAY_TOKEN=...
echo   ----------------------------------------------------------------
echo.
echo   Continuing in 8s  [Ctrl+C to stop]
timeout /t 8 /nobreak >nul

REM ---- find node -------------------------------------------------------------
REM  Double-clicking a .bat inherits Explorer's environment, which can still be
REM  the one from BEFORE node was installed. So if PATH does not have it, look
REM  where the installer actually puts it.
REM  NODE holds a BARE path with no quotes. Storing the quotes in the variable
REM  and then writing "%NODE%" yields ""C:\Program Files\...\node.exe"", which
REM  cmd splits at the space and cannot parse. Quote at the point of use only.
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
  echo      If double-clicking still fails, sign out and back in.
  echo.
  echo   Already installed somewhere unusual? Run it by hand instead:
  echo      "C:\path\to\node.exe" korea-relay.js
  echo.
  pause
  exit /b 1
)

REM ---- check the token -------------------------------------------------------
REM  The token may come from the environment; the .env file is one way, not the
REM  only way. env.js already prefers process.env, so refusing to start without
REM  the file would block a setup that works perfectly well.
set TOKSRC=
if not "%KOREA_RELAY_TOKEN%"=="" set TOKSRC=the environment
if "%TOKSRC%"=="" if exist ".env" findstr /b /c:"KOREA_RELAY_TOKEN=" .env >nul 2>nul && set TOKSRC=.env

if "%TOKSRC%"=="" (
  echo.
  echo   [!] KOREA_RELAY_TOKEN is not set -- not in the environment, and not
  echo       in ieumi-server\.env. The relay will still start, but anyone who
  echo       finds the address can use it. Fine locally, not for a tunnel.
  echo.
  echo   Either set it for this window:
  echo       set KOREA_RELAY_TOKEN=[a long random string]
  echo.
  echo   Or create the file:
  echo       echo KOREA_RELAY_TOKEN=[a long random string]^> .env
  echo.
  echo   To generate one:
  echo       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  echo.
  timeout /t 5 /nobreak >nul
) else (
  echo   token: from %TOKSRC%
)

:loop
echo.
echo [%date% %time%] starting Korea fetch relay
echo.
"%NODE%" korea-relay.js
echo.
echo [%date% %time%] relay exited -- restarting in 5s [Ctrl+C to stop]
timeout /t 5 /nobreak >nul
goto loop
