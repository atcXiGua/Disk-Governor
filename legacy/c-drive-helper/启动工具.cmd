@echo off
chcp 65001
setlocal
cd /d "%~dp0"
title C-Drive Helper

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

if not defined NODE_EXE goto nonode

echo.
echo   C-Drive Helper - starting...
echo.
"%NODE_EXE%" server.js
echo.
echo   Helper stopped.
pause
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Install Node.js, or edit NODE_EXE in this file.
echo.
pause
exit /b 1
