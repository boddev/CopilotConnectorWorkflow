@echo off
setlocal
cd /d "%~dp0\.."
if not exist node_modules ( call npm install --no-audit --no-fund )
if not exist dist ( call npm run build )
node dist\cli.js %*
