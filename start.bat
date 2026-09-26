@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  echo Meanwhile you can open public\index.html directly in a browser.
  pause
  exit /b 1
)
start "" http://localhost:8787
node server.js --warm
pause
