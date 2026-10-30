@echo off
setlocal
rem Downloads wwwroot.zip from Hugging Face and extracts wwwroot.jsonl into .\assets
rem
rem Usage:
rem   scripts\windows\fetch_dataset.bat
rem
rem Environment:
rem   FORCE=1     re-download even if assets\wwwroot.jsonl already exists
rem   KEEP_ZIP=1  keep assets\wwwroot.zip after extraction (deleted by default)
rem
rem Requires: curl.exe (built into Windows 10 1803+) or PowerShell,
rem           plus one of: 7-Zip, tar.exe (Windows 10 1803+), Python 3

set "URL=https://huggingface.co/datasets/tripolskypetr/market-forecasting-dataset/resolve/main/assets/wwwroot.zip"
set "PASSWORD=123"
set "ENTRY=wwwroot.jsonl"

set "ROOT_DIR=%~dp0..\.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "ASSETS_DIR=%ROOT_DIR%\assets"
set "ZIP_PATH=%ASSETS_DIR%\wwwroot.zip"
set "PART_PATH=%ZIP_PATH%.part"
set "OUT_PATH=%ASSETS_DIR%\%ENTRY%"

if not exist "%ASSETS_DIR%" mkdir "%ASSETS_DIR%"

if not exist "%OUT_PATH%" goto :download
if defined FORCE goto :download
echo %OUT_PATH% already exists, skipping. Set FORCE=1 to re-download.
exit /b 0

rem --- download ---------------------------------------------------------------
:download
if not exist "%ZIP_PATH%" goto :do_download
if defined FORCE goto :do_download
echo Using existing %ZIP_PATH%
goto :extract

:do_download
echo Downloading %URL%
if exist "%PART_PATH%" del /q "%PART_PATH%"
where curl.exe >nul 2>&1
if errorlevel 1 goto :download_powershell
curl.exe -fL --retry 3 --retry-delay 2 --progress-bar -o "%PART_PATH%" "%URL%"
if errorlevel 1 goto :download_failed
goto :download_done

:download_powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%URL%', '%PART_PATH%')"
if errorlevel 1 goto :download_failed

:download_done
move /y "%PART_PATH%" "%ZIP_PATH%" >nul
if errorlevel 1 goto :download_failed

rem --- extract ----------------------------------------------------------------
:extract
if exist "%OUT_PATH%" del /q "%OUT_PATH%"

set "SEVENZIP="
where 7z.exe >nul 2>&1 && set "SEVENZIP=7z.exe"
if not defined SEVENZIP if exist "%ProgramFiles%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles%\7-Zip\7z.exe"
if not defined SEVENZIP if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles(x86)%\7-Zip\7z.exe"
if not defined SEVENZIP where 7za.exe >nul 2>&1 && set "SEVENZIP=7za.exe"
if defined SEVENZIP goto :use_7zip

where tar.exe >nul 2>&1
if not errorlevel 1 goto :use_tar

set "PYTHON="
py.exe -3 -c "import zipfile" >nul 2>&1 && set "PYTHON=py.exe -3"
if defined PYTHON goto :use_python
python.exe -c "import zipfile" >nul 2>&1 && set "PYTHON=python.exe"
if defined PYTHON goto :use_python

echo Error: no supported extractor found. Install 7-Zip (https://www.7-zip.org/) or Python 3 and run again. >&2
echo The downloaded archive was kept at %ZIP_PATH% >&2
exit /b 1

:use_7zip
echo Extracting %ENTRY% with 7-Zip
"%SEVENZIP%" x -y -p%PASSWORD% -o"%ASSETS_DIR%" "%ZIP_PATH%" "%ENTRY%"
if errorlevel 1 goto :extract_failed
goto :verify

:use_tar
echo Extracting %ENTRY% with tar
tar.exe --passphrase "%PASSWORD%" -xf "%ZIP_PATH%" -C "%ASSETS_DIR%" "%ENTRY%"
if errorlevel 1 goto :extract_failed
goto :verify

:use_python
echo Extracting %ENTRY% with Python (slow, pure-Python decryption)
%PYTHON% -I -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3], pwd=sys.argv[4].encode())" "%ZIP_PATH%" "%ENTRY%" "%ASSETS_DIR%" "%PASSWORD%"
if errorlevel 1 goto :extract_failed
goto :verify

rem --- verify -----------------------------------------------------------------
:verify
if not exist "%OUT_PATH%" goto :extract_failed
for %%I in ("%OUT_PATH%") do if %%~zI EQU 0 goto :extract_failed
if not defined KEEP_ZIP del /q "%ZIP_PATH%"
for %%I in ("%OUT_PATH%") do echo Done: %%~fI (%%~zI bytes)
exit /b 0

rem --- errors -----------------------------------------------------------------
:download_failed
echo Error: download failed. >&2
if exist "%PART_PATH%" del /q "%PART_PATH%"
exit /b 1

:extract_failed
echo Error: %ENTRY% was not extracted (wrong password or corrupted archive?). >&2
echo The downloaded archive was kept at %ZIP_PATH% >&2
exit /b 1
