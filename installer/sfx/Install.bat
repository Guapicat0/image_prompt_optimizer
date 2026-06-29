@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "code=%ERRORLEVEL%"
echo.
if "%code%"=="0" (
  echo Install completed. You can launch the app from the desktop shortcut.
) else (
  echo Install failed. Error code: %code%
)
echo.
pause
exit /b %code%
