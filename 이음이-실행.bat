@echo off
REM ============================================================================
REM  Ieumi launcher - double-click to run the server on this machine.
REM
REM  Deliberately ASCII-only. A .bat is parsed with the console code page, which
REM  on a Korean Windows is 949, not UTF-8 - Korean written here would arrive as
REM  mojibake on exactly the machines it was written for. The Korean instructions
REM  live in 실행방법.txt, which this opens in Notepad when something is missing.
REM ============================================================================
setlocal
cd /d "%~dp0"
title Ieumi (server)

echo.
echo   ==========================================
echo     Ieumi - starting up
echo   ==========================================
echo.

REM ---------------------------------------------------------------- 1. Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo.
  echo       Install the LTS version, then run this file again:
  echo       https://nodejs.org
  echo.
  start "" https://nodejs.org
  goto :fail
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 (
  echo   [X] Node.js 18 or newer is required. Found:
  node -v
  echo.
  echo       Install the LTS version from https://nodejs.org and try again.
  start "" https://nodejs.org
  goto :fail
)
echo   [OK] Node.js
node -v

REM ------------------------------------------------------------------- 2. .env
if not exist "ieumi-server\.env" (
  echo.
  echo   [!] Settings file is missing - this is the first run.
  echo.
  echo       A blank one has been created at:  ieumi-server\.env
  echo       Alireza will send you the values to paste into it.
  echo.
  copy /y "ieumi-server\.env.example" "ieumi-server\.env" >nul
  if exist "실행방법.txt" start "" notepad.exe "실행방법.txt"
  start "" notepad.exe "ieumi-server\.env"
  echo       Paste the values, SAVE the file, close Notepad,
  echo       then run this launcher again.
  goto :fail
)

REM The two that stop everything if blank. A missing key otherwise fails later
REM as a wall of red text, which is a bad way to learn you missed a line.
set "HASDB="
set "HASAI="
for /f "usebackq tokens=1,* delims==" %%a in ("ieumi-server\.env") do (
  if /i "%%a"=="DATABASE_URL"      if not "%%b"=="" set "HASDB=1"
  if /i "%%a"=="ANTHROPIC_API_KEY" if not "%%b"=="" set "HASAI=1"
)
if not defined HASDB (
  echo.
  echo   [X] DATABASE_URL is empty in ieumi-server\.env
  echo       Without it the dashboards and login cannot work.
  start "" notepad.exe "ieumi-server\.env"
  goto :fail
)
if not defined HASAI (
  echo.
  echo   [X] ANTHROPIC_API_KEY is empty in ieumi-server\.env
  echo       Without it Ieumi cannot answer.
  start "" notepad.exe "ieumi-server\.env"
  goto :fail
)
echo   [OK] Settings

REM ----------------------------------------------------------- 3. Dependencies
if not exist "ieumi-server\node_modules" (
  echo.
  echo   [..] First run - installing. This takes a minute, once only.
  pushd ieumi-server
  call npm ci --omit=dev
  if errorlevel 1 (
    popd
    echo.
    echo   [X] Install failed. Check your internet connection and try again.
    goto :fail
  )
  popd
)
echo   [OK] Dependencies

REM -------------------------------------------------------------- 4. Port free
netstat -ano | findstr /r /c:":8791 .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   [!] Port 8791 is already in use - Ieumi may already be running.
  echo       Look for another window titled "Ieumi (server)", or close it
  echo       and run this again.
  echo.
  echo       Opening the browser at the address that is already running.
  start "" http://localhost:8791/login
  goto :fail
)

REM --------------------------------------------------------------- 5. Database
echo   [..] Checking the database
pushd ieumi-server
call npm run migrate >nul 2>nul
if errorlevel 1 (
  popd
  echo.
  echo   [X] Could not reach the database.
  echo       Check DATABASE_URL in ieumi-server\.env, and that you are online.
  goto :fail
)
popd
echo   [OK] Database

REM ------------------------------------------------------------------ 6. Serve
echo.
echo   ==========================================
echo     Ready. Opening your browser.
echo   ==========================================
echo.
echo     Sign in      http://localhost:8791/login
echo     Admin        http://localhost:8791/admin
echo     Staff        http://localhost:8791/staff
echo.
echo     The kiosk address is per-centre: sign in, open
echo     "이음이 설정", and copy the address shown there.
echo.
echo     KEEP THIS WINDOW OPEN while you are testing.
echo     Closing it stops Ieumi.
echo.

start "" /b cmd /c "timeout /t 3 >nul & start "" http://localhost:8791/login"
node ieumi-server\server.js

echo.
echo   Ieumi has stopped.
goto :end

:fail
echo.
pause
exit /b 1

:end
pause
endlocal
