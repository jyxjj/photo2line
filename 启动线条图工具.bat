@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Photo2Line Server
echo ============================================================
echo   Photo2Line - Part Photo to 2D Line Art (SVG / PNG)
echo ============================================================
echo.
echo   Starting local server, browser will open automatically...
echo   Close this window to stop the server.
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPY

python -c "import numpy, cv2, scipy, skimage, PIL" >nul 2>nul
if errorlevel 1 goto NODEP

python server.py --port 8777 --auto-port
echo.
echo   Server stopped. If nothing opened, read README.md
echo   or run: python server.py --port 8777 --no-browser
pause
exit /b 0

:NOPY
echo.
echo [ERROR] Python not found in PATH.
echo         Install Python 3.10+ from https://www.python.org/downloads/
echo         Remember to check "Add python.exe to PATH" during install.
echo.
pause
exit /b 1

:NODEP
echo.
echo [ERROR] Required Python packages are missing.
echo         Run this command, then double-click this file again:
echo.
echo         pip install -r requirements.txt
echo.
pause
exit /b 1
