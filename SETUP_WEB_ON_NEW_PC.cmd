@echo off
setlocal
cd /d "%~dp0source"

where py >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install 64-bit Python 3.12 or newer first.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
  if errorlevel 1 goto :failed
)

".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo.
echo Website dependencies installed successfully.
echo Read the Website POS README.md before enabling tablet or remote access.
pause
exit /b 0

:failed
echo.
echo Setup failed. Review the message above and try again.
pause
exit /b 1
