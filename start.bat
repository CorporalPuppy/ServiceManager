@echo off
rem Service dashboard launcher. Asks for administrator rights so the
rem Start / Stop / Restart buttons can control Windows services.

net session >NUL 2>&1
if %errorlevel% neq 0 (
    echo Asking for administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
title Service dashboard (admin)

rem Use whichever virtual environment PyCharm made: venv or .venv
set "VENV="
if exist "venv\Scripts\waitress-serve.exe" set "VENV=venv"
if exist ".venv\Scripts\waitress-serve.exe" set "VENV=.venv"
if not defined VENV (
    echo Could not find waitress in venv or .venv.
    echo In PyCharm's terminal run: pip install -r requirements.txt
    pause
    exit /b 1
)

echo Dashboard running at http://localhost:8088  (close this window to stop it)
start "" http://localhost:8088
%VENV%\Scripts\waitress-serve.exe --listen=127.0.0.1:8088 app:app
pause
