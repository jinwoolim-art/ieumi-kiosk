@echo off
REM ============================================================================
REM  update-data.bat -- read the linked pages and refresh the job listings.
REM
REM  THIS is the job that makes Ieumi able to name a course, quote a fee or read
REM  a timetable. It follows each catalogue link, follows one hop further into
REM  the course / timetable / apply pages, transcribes posters that exist only
REM  as images, and stores the pieces the kiosk searches at question time.
REM
REM  Run it ONCE after updating the code, then on a daily schedule.
REM  It is safe to run any time: the kiosk keeps answering while it runs.
REM
REM  It does NOT need start-kiosk.bat to be running.
REM  It does NOT need the relay, if this machine is in Korea.
REM
REM    tools\update-data.bat              normal daily run
REM    tools\update-data.bat --force      re-read everything, ignore "unchanged"
REM
REM  Pure ASCII on purpose -- see the note in start-relay.bat.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

REM ---- find node -------------------------------------------------------------
set NODE=
where node >nul 2>nul && set NODE=node
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe"          set NODE=%ProgramFiles%\nodejs\node.exe
if "%NODE%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe"     set NODE=%ProgramFiles(x86)%\nodejs\node.exe
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe
if "%NODE%"=="" if exist "%APPDATA%\nvm\current\node.exe"          set NODE=%APPDATA%\nvm\current\node.exe

if "%NODE%"=="" (
  echo.
  echo   Node.js was not found. Install from https://nodejs.org [LTS],
  echo   then CLOSE this window and open a new one.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo.
  echo   [!] Dependencies are not installed. Run this once, here:
  echo         npm install --omit=dev
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo   [!] ieumi-server\.env does not exist.
  echo.
  pause
  exit /b 1
)

REM ---- keys this job actually needs ------------------------------------------
REM  ANTHROPIC_API_KEY is not optional here: the facts and the poster reading
REM  are both model work. Without it the run fails on the first service.
set MISSING=
findstr /b /c:"DATABASE_URL=" .env      >nul 2>nul || set MISSING=1
findstr /b /c:"ANTHROPIC_API_KEY=" .env >nul 2>nul || set MISSING=1
if not "%MISSING%"=="" (
  echo.
  echo   [!] DATABASE_URL and ANTHROPIC_API_KEY must both be in .env.
  echo       This job reads pages AND summarises them, so it needs both.
  echo.
  pause
  exit /b 1
)

REM ---- Chrome ----------------------------------------------------------------
REM  Many of these sites build their page with JavaScript and serve an empty
REM  shell to a plain fetch. Without a browser those pages are read as blank --
REM  no error, no warning, the service simply has nothing to say afterwards.
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe"      set CHROME=1
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=1
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"     set CHROME=1
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set CHROME=1
if not "%CHROME_PATH%"=="" set CHROME=1

if "%CHROME%"=="" (
  echo.
  echo   [!] No Chrome or Edge found on this machine.
  echo       Pages built by JavaScript will be read as EMPTY -- silently.
  echo       Install Chrome, or set CHROME_PATH in .env, then run this again.
  echo.
  echo   Continuing in 8s  [Ctrl+C to stop]
  timeout /t 8 /nobreak >nul
)

REM ---- relay note ------------------------------------------------------------
findstr /b /c:"KOREA_RELAY_URL=http" .env >nul 2>nul && (
  echo.
  echo   [i] Fetching through the Korea relay [KOREA_RELAY_URL is set].
  echo       If THIS machine is in Korea, delete KOREA_RELAY_URL and
  echo       KOREA_RELAY_TOKEN from .env -- this run will be much faster.
  echo.
)

echo.
echo ============================================================
echo  1/3  database migrations
echo ============================================================
"%NODE%" db\migrate.js
if errorlevel 1 goto failed

echo.
echo ============================================================
echo  2/3  job listings  [data.go.kr]
echo ============================================================
"%NODE%" db\sync-jobs.js
if errorlevel 1 echo   [!] job sync failed -- continuing; the page sync is separate.

echo.
echo ============================================================
echo  3/3  reading the linked pages, sub-pages and posters
echo       This is the slow one. Expect 30-90 minutes for the
echo       full catalogue; most of it is waiting on slow sites.
echo ============================================================
"%NODE%" db\sync-sources.js %*
if errorlevel 1 goto failed

echo.
echo   Done. Check the counts above:
echo     "+2p"   sub-pages followed        "+3img" posters read
echo     "chunks" searchable pieces stored
echo   A service showing 0 extra pages probably has a link pointing at a
echo   front door rather than at the page with the information on it.
echo.
pause
exit /b 0

:failed
echo.
echo   [!] A step failed. Nothing above was left half-written -- each service
echo       is saved as it completes, so running this again resumes safely.
echo.
pause
exit /b 1
