@echo off
REM ============================================================================
REM  boot-relay.bat -- run the Korea fetch relay unattended, from boot.
REM
REM  This belongs on the KOREA box, not on the machine that serves the kiosk.
REM  The relay exists because Korean government sites refuse foreign IPs: it
REM  opens a page from inside Korea and hands back what it got, which lets the
REM  rest of the system live anywhere.
REM
REM  This is start-relay.bat with every interactive part taken out -- see the
REM  header of boot-kiosk.bat for why that matters at boot.
REM
REM  NOTE: unlike the kiosk, the relay needs NOTHING but Node -- no npm
REM  install, no database, no API keys. A Korea box that has never run
REM  "npm install" runs this perfectly well, so this file must not check for
REM  node_modules. It only needs KOREA_RELAY_TOKEN in ieumi-server\.env.
REM
REM  Installed by tools\install-autostart.ps1 -Relay as the scheduled task
REM  "Ieumi Korea Relay", trigger "at system startup", running as SYSTEM.
REM
REM  Pure ASCII on purpose -- see the note in start-relay.bat.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

if not exist "logs" mkdir "logs"
set LOG=%CD%\logs\boot-relay.log

REM ---- keep the log bounded --------------------------------------------------
REM  The "if exist" is load-bearing: %%~zF on a file that is not there expands
REM  to nothing, so on the very first boot the line would read "if  GTR ..."
REM  and cmd.exe would abort the script before the relay ever started.
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 10485760 move /y "%LOG%" "%LOG%.old" >nul 2>nul

echo. >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo [%date% %time%] boot-relay starting >> "%LOG%"

REM ---- find node -------------------------------------------------------------
REM  SYSTEM has its own PATH. A per-user Node install -- nvm, or anything under
REM  %LOCALAPPDATA% -- is invisible to it even though it works perfectly in
REM  your own shell.
set NODE=
if exist "%ProgramFiles%\nodejs\node.exe"                     set NODE=%ProgramFiles%\nodejs\node.exe
if "%NODE%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set NODE=%ProgramFiles(x86)%\nodejs\node.exe
if "%NODE%"=="" where node >nul 2>nul && set NODE=node

if "%NODE%"=="" (
  echo [%date% %time%] FATAL: node.exe not found. >> "%LOG%"
  echo    Install Node.js LTS from https://nodejs.org using the default >> "%LOG%"
  echo    machine-wide location ^(C:\Program Files\nodejs^). A per-user or >> "%LOG%"
  echo    nvm install cannot be seen by the SYSTEM account at boot. >> "%LOG%"
  exit /b 1
)
echo [%date% %time%] node: %NODE% >> "%LOG%"

REM ---- the one thing it does need --------------------------------------------
REM  Without a shared token the relay refuses every request, which from the
REM  other side looks exactly like every Korean page having gone blank.
if not exist ".env" (
  echo [%date% %time%] FATAL: ieumi-server\.env does not exist. >> "%LOG%"
  echo    It needs one line:  KOREA_RELAY_TOKEN=^<the same long random string >> "%LOG%"
  echo    that is in .env on the machine running the kiosk^> >> "%LOG%"
  exit /b 1
)
findstr /b /c:"KOREA_RELAY_TOKEN=" .env >nul 2>nul || echo [%date% %time%] FATAL: KOREA_RELAY_TOKEN is not in .env >> "%LOG%"

REM ---- running the kiosk here too? then this box does not need the relay -----
REM  Routing a Korea box's own fetches through its own relay only adds a hop
REM  to every page, and the nightly sync pays it hundreds of times.
findstr /b /c:"KOREA_RELAY_URL=http" .env >nul 2>nul && echo [%date% %time%] NOTE: KOREA_RELAY_URL is set in this .env -- that belongs on the kiosk machine, not here. >> "%LOG%"

:loop
echo. >> "%LOG%"
echo [%date% %time%] starting the Korea relay on port 8799 >> "%LOG%"
"%NODE%" korea-relay.js >> "%LOG%" 2>&1
echo [%date% %time%] relay exited with code %errorlevel% -- restarting in 10s >> "%LOG%"
REM  ping, not timeout: with no console, timeout fails outright.
ping -n 11 127.0.0.1 >nul 2>nul
goto loop
