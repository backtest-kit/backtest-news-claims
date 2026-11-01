@echo off
setlocal
rem Downloads investinglive.jsonl from Hugging Face as .\assets\wwwroot.jsonl
rem
rem Usage:
rem   scripts\windows\fetch_dataset.bat
rem
rem Environment:
rem   FORCE=1     re-download even if assets\wwwroot.jsonl already exists
rem
rem Requires: curl.exe (built into Windows 10 1803+) or PowerShell

set "URL=https://huggingface.co/datasets/tripolskypetr/investinglive-crypto/resolve/main/investinglive.jsonl"

set "ROOT_DIR=%~dp0..\.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "ASSETS_DIR=%ROOT_DIR%\assets"
set "OUT_PATH=%ASSETS_DIR%\wwwroot.jsonl"
set "PART_PATH=%OUT_PATH%.part"

if not exist "%ASSETS_DIR%" mkdir "%ASSETS_DIR%"

if not exist "%OUT_PATH%" goto :download
if defined FORCE goto :download
echo %OUT_PATH% already exists, skipping. Set FORCE=1 to re-download.
exit /b 0

rem --- download ---------------------------------------------------------------
:download
echo Downloading %URL%
if exist "%PART_PATH%" del /q "%PART_PATH%"
where curl.exe >nul 2>&1
if errorlevel 1 goto :download_powershell
curl.exe -fL --retry 3 --retry-delay 2 --progress-bar -o "%PART_PATH%" "%URL%"
if errorlevel 1 goto :download_failed
goto :verify

:download_powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%URL%', '%PART_PATH%')"
if errorlevel 1 goto :download_failed

rem --- verify -----------------------------------------------------------------
:verify
if not exist "%PART_PATH%" goto :download_failed
for %%I in ("%PART_PATH%") do if %%~zI EQU 0 goto :download_failed
move /y "%PART_PATH%" "%OUT_PATH%" >nul
if errorlevel 1 goto :download_failed
for %%I in ("%OUT_PATH%") do echo Done: %%~fI (%%~zI bytes)
exit /b 0

rem --- errors -----------------------------------------------------------------
:download_failed
echo Error: download failed. >&2
if exist "%PART_PATH%" del /q "%PART_PATH%"
exit /b 1
