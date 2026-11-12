@echo off
REM Build the in-process Tolk addon (bma_tts.node) against this game's NW.js ABI.
REM
REM Requirements (one-time dev setup):
REM   - Node.js + npm on PATH
REM   - Visual Studio Build Tools (Desktop C++)
REM   - nw-gyp:  npm install -g nw-gyp
REM
REM nw-gyp pins NW.js 0.49.2's exact Node/N-API ABI, so the resulting .node is correct
REM for Game.exe regardless of the host Node version used to run nw-gyp. N-API keeps it
REM ABI-stable across future NW.js updates.

setlocal
set NWJS_TARGET=0.49.2
set NWJS_ARCH=x64

cd /d "%~dp0bma_tts"

echo === Configuring (nw-gyp, target NW.js %NWJS_TARGET% %NWJS_ARCH%) ===
call nw-gyp configure --target=%NWJS_TARGET% --arch=%NWJS_ARCH%
if errorlevel 1 goto :fail

echo === Building ===
call nw-gyp build
if errorlevel 1 goto :fail

set OUT=build\Release\bma_tts.node
if not exist "%OUT%" goto :fail

echo.
echo Build OK: %~dp0bma_tts\%OUT%
echo Copy this to dist\bma-payload\ via build.ps1.
exit /b 0

:fail
echo.
echo BUILD FAILED. Ensure nw-gyp, Node, and VS C++ Build Tools are installed.
exit /b 1
