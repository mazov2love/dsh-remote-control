@echo off
setlocal
set "DSH_SOURCE=%USERPROFILE%\dsh-lab\deepseek-harness"
set "DSH_HOME=%USERPROFILE%\.dsh-lab"
set "DSH_LAB_PORT=8081"
set "DSH_AGENTS_HOME=%USERPROFILE%\.agents-dsh-lab"

if not exist "%DSH_SOURCE%\package.json" (
  echo Source directory not found. Edit DSH_SOURCE in this script.
  pause
  exit /b 1
)
cd /d "%DSH_SOURCE%"
call pnpm dsh web --host 127.0.0.1 --port %DSH_LAB_PORT%
set "DSH_LAB_EXIT=%ERRORLEVEL%"
if not "%DSH_LAB_EXIT%"=="0" pause
endlocal & exit /b %DSH_LAB_EXIT%
