@echo off
REM Thin wrapper for cmd.exe users — just hands off to install.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
