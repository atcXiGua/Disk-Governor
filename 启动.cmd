@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Disk Governor

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

if not defined NODE_EXE goto nonode

echo.
echo   Disk Governor - starting...
echo.
"%NODE_EXE%" "%~dp0src\server.js"
echo.
echo   Stopped. Press any key to close.
pause >nul
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js 18+ not found.
echo.
echo   Either install Node.js, or download the portable build
echo   which bundles the runtime (no install needed).
echo.
pause >nul
exit /b 1
