@echo off
setlocal

REM  DentalCare - finish the cleanup pass
REM  Deletes the quarantine folder, then reinstalls dependencies.
REM  Written by Claude on 2026-08-21. Safe to delete this file afterwards.

cd /d "%~dp0"

echo.
echo ==========================================================
echo  DentalCare cleanup - finishing up
echo  Folder: %CD%
echo ==========================================================
echo.

if exist "_to_delete\*" (
    echo [1/2] Deleting _to_delete ^(~313 MB, 28k+ files^)...
    rmdir /s /q "_to_delete"
    if exist "_to_delete\*" (
        echo       WARNING: some files were locked and could not be deleted.
        echo       Close VS Code / Cursor / any terminal in this folder, then rerun.
    ) else (
        echo       Done.
    )
) else (
    echo [1/2] _to_delete not present - nothing to delete.
)
echo.

echo [2/2] Reinstalling dependencies ^(npm install^)...
call npm install
if errorlevel 1 (
    echo.
    echo       npm install FAILED. Check the output above.
    goto :end
)
echo       Done.

echo.
echo ==========================================================
echo  Ready. Next steps:
echo    npm run migrate:up
echo    npm run api:dev      ^(API      :3000^)
echo    npm run web:dev      ^(clinic   :5173^)
echo    npm run admin:dev    ^(platform :5174^)
echo.
echo  First platform admin: see docs/DEPLOYMENT.md
echo ==========================================================

:end
echo.
pause
