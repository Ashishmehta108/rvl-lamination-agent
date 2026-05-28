@echo off
:: RVL Lamination Agent - PM2 Auto-Start Script
:: This is run by Windows Scheduled Task on login/boot

cd /d "C:\Users\ashis\rvl-lamination-agent"

:: Wait 10 seconds for network/services to be ready
timeout /t 10 /nobreak >nul

:: Try pm2 resurrect first (uses saved dump)
call "C:\Users\ashis\AppData\Roaming\npm\pm2.cmd" resurrect

:: Wait and check if services came up
timeout /t 5 /nobreak >nul

:: If resurrect failed (no processes), fall back to starting from ecosystem
"C:\Users\ashis\AppData\Roaming\npm\pm2.cmd" status 2>nul | findstr /i "online" >nul
if errorlevel 1 (
    echo PM2 resurrect found no processes. Starting from ecosystem config...
    "C:\Users\ashis\AppData\Roaming\npm\pm2.cmd" start "C:\Users\ashis\rvl-lamination-agent\ecosystem.config.cjs"
    timeout /t 5 /nobreak >nul
    "C:\Users\ashis\AppData\Roaming\npm\pm2.cmd" save --force
)

exit /b 0


