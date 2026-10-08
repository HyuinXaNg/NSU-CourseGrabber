@echo off
rem Open the userscript in Notepad so you can copy it into the browser.
rem NEVER double-click a .js file directly - Windows would run it with
rem Windows Script Host instead of opening or running it properly.
start "" notepad "%~dp0grab_course.ui.js"
