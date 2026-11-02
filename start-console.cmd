@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not defined CW_PORT set "CW_PORT=17323"
node tools/mitm-ca.mjs status
if errorlevel 1 goto failed
echo Local console: http://127.0.0.1:%CW_PORT%/
node src/app.mjs console
if errorlevel 1 goto failed
popd
exit /b 0
:failed
echo See the diagnostic above.
pause
popd
exit /b 1
