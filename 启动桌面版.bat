@echo off
rem ===========================================================================
rem  Grab-course desktop app launcher
rem  Double-click this file to open the desktop window.
rem  (Do NOT double-click the .js files - Windows would run them with
rem   Windows Script Host and show a syntax error.)
rem ===========================================================================
cd /d "%~dp0"

where pythonw >nul 2>nul
if errorlevel 1 goto useconsole

start "" pythonw "抢课助手.pyw"
exit /b 0

:useconsole
where python >nul 2>nul
if errorlevel 1 goto nopython
echo pythonw not found, falling back to python (a console window will stay open)
echo.
python "抢课助手.pyw"
exit /b 0

:nopython
echo.
echo [ERROR] Python was not found in PATH.
echo         Install it from https://www.python.org/ and retry.
echo.
pause
exit /b 1
