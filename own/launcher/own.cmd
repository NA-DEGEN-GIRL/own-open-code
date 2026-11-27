@echo off
rem own-open-code launcher entry point (01 sec. 5.1: the only command on PATH). Forwards everything to own.ps1.
setlocal
rem Windows PowerShell 5.1 cannot load its own modules with PowerShell 7's inherited PSModulePath (Get-FileHash fails).
set "PSModulePath="
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0own.ps1" %*
exit /b %ERRORLEVEL%
