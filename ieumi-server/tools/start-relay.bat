@echo off
REM ============================================================================
REM  start-relay.bat -- 한국 기기에서 중계 서버를 띄웁니다.
REM
REM  Run the fetch relay on the Korea box, with auto-restart.
REM
REM  이 서버가 하는 일은 하나뿐입니다: 페이지를 열어서 받은 그대로 돌려주기.
REM  한국 공공기관 사이트가 해외 IP 를 막기 때문에, 이 일만 한국에서 하면
REM  나머지는 어디에 있든 상관없습니다.
REM
REM  토큰은 <꼭> 정하십시오. 터널 주소는 짐작하기 어렵지만, 짐작하기 어려운 것과
REM  잠겨 있는 것은 다릅니다. 아래 KOREA_RELAY_TOKEN 을 아무 긴 문자열로 바꾸고,
REM  같은 값을 앱 쪽 .env 에도 넣으십시오.
REM  Set the token. A hard-to-guess address is not the same as a locked door.
REM
REM  그다음 별도 창에서 tools\start-tunnel.bat 을 실행하면 바깥에서 닿습니다.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

REM ---- 여기를 바꾸세요 / CHANGE THIS ----------------------------------------
if "%KOREA_RELAY_TOKEN%"=="" set KOREA_RELAY_TOKEN=change-me-to-a-long-random-string
REM --------------------------------------------------------------------------

if "%KOREA_RELAY_TOKEN%"=="change-me-to-a-long-random-string" (
  echo.
  echo   [!] KOREA_RELAY_TOKEN 이 기본값 그대로입니다.
  echo       이 파일을 열어 긴 임의의 문자열로 바꿔 주세요.
  echo       The token is still the placeholder - edit this file before exposing it.
  echo.
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   node 를 찾지 못했습니다 / node not found on PATH.
  echo   https://nodejs.org  에서 설치해 주세요.
  echo.
  pause
  exit /b 1
)

:loop
echo.
echo [%date% %time%] 중계 서버를 시작합니다 - starting Korea fetch relay
echo.
node korea-relay.js
echo [%date% %time%] 중계가 멈췄습니다 - relay exited, restarting in 5s (Ctrl+C to stop)
timeout /t 5 /nobreak >nul
goto loop
