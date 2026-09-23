@echo off
REM ============================================================================
REM  boot-kiosk.bat -- run the Ieumi server unattended, from boot.
REM
REM  This is start-kiosk.bat with every interactive part taken out. Nothing in
REM  here may ever call "pause", "timeout" or wait for a key: at boot there is
REM  no console and nobody to press anything, so the task would hang forever --
REM  and a hung task looks to Task Scheduler exactly like a healthy one.
REM  ("timeout" is worse than useless there: with no console it fails outright
REM  with "input redirection is not supported". ping is the boot-safe sleep.)
REM
REM  Do not run this by hand. Use start-kiosk.bat, which explains its errors to
REM  your face. This one only writes them to logs\boot-kiosk.log.
REM
REM  Installed by tools\install-autostart.ps1 as the scheduled task
REM  "Ieumi Kiosk", trigger "at system startup", running as SYSTEM.
REM
REM  Pure ASCII on purpose -- see the note in start-relay.bat.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

if not exist "logs" mkdir "logs"
set LOG=%CD%\logs\boot-kiosk.log

REM ---- keep the log bounded --------------------------------------------------
REM  This runs from boot to shutdown, every day, forever. Unbounded is a full
REM  disk in a few months, and a full disk stops Postgres writes too. The
REM  "if exist" is load-bearing: %%~zF on a file that is not there expands to
REM  nothing, so on the very first boot the line would read "if  GTR ..." and
REM  cmd.exe would abort the script before the server ever started.
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 10485760 move /y "%LOG%" "%LOG%.old" >nul 2>nul

echo. >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo [%date% %time%] boot-kiosk starting >> "%LOG%"

REM ---- find node -------------------------------------------------------------
REM  SYSTEM has its own PATH. A per-user Node install -- nvm, or anything under
REM  %LOCALAPPDATA% -- is invisible to it even though it works perfectly in
REM  your own shell. Machine-wide paths are tried first for that reason, and
REM  if only a per-user one exists this fails loudly rather than at 3am.
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

REM ---- the things that make it exit one second after it starts ---------------
if not exist "node_modules\pg" (
  echo [%date% %time%] FATAL: dependencies missing. Run: npm install --omit=dev >> "%LOG%"
  exit /b 1
)
if not exist ".env" (
  echo [%date% %time%] FATAL: ieumi-server\.env does not exist. >> "%LOG%"
  exit /b 1
)
for %%K in (DATABASE_URL ANTHROPIC_API_KEY CLOVA_API_KEY_ID CLOVA_API_KEY) do (
  findstr /b /c:"%%K=" .env >nul 2>nul || echo [%date% %time%] WARNING: %%K is not in .env >> "%LOG%"
)

:loop
echo. >> "%LOG%"
echo [%date% %time%] starting the Ieumi server on port 8791 >> "%LOG%"
"%NODE%" server.js >> "%LOG%" 2>&1
echo [%date% %time%] server exited with code %errorlevel% -- restarting in 10s >> "%LOG%"
REM  ping, not timeout: see the header. -n 11 is ten seconds.
ping -n 11 127.0.0.1 >nul 2>nul
goto loop
