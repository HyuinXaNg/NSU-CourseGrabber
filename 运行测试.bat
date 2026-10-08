@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================================
echo   Grab-course test suite  ^(runs with Node.js^)
echo   Double-click this file - do NOT double-click the .js
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install it from https://nodejs.org/ and retry.
  echo.
  pause
  exit /b 1
)

echo Node version:
node --version
echo.

for %%f in (
  test_parse.js
  test_gui.js
  test_gui_consistency.js
  test_ui_panel.js
  test_multi_target_all.js
  test_max_minutes.js
  test_false_success.js
  test_stray_confirm.js
  test_wait_no_click.js
  test_userscript_wait.js
  _verify_destroy_test.js
  timing_check.js
) do (
  echo ----------------------------------------------------------
  echo   %%f
  echo ----------------------------------------------------------
  node "%%f"
  echo.
)

echo ==========================================================
echo   Desktop app tests (Python + Playwright)
echo ==========================================================
echo.
rem Force Python stdio to UTF-8, otherwise a GBK console raises
rem UnicodeEncodeError on the checkmark characters in the test output.
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
for %%f in (test_desktop_ui.py test_desktop_e2e.py) do (
  echo ----------------------------------------------------------
  echo   %%f
  echo ----------------------------------------------------------
  python "%%f"
  echo.
)

echo ==========================================================
echo   All tests finished.
echo ==========================================================
echo.
pause
