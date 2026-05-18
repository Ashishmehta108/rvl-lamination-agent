# ─── RVL Lamination Agent — PM2 Startup Setup for Windows ───────────
# This script:
#   1. Ensures PM2 is installed globally
#   2. Starts all services via ecosystem.config.cjs
#   3. Saves the PM2 process list
#   4. Creates a Windows Scheduled Task to resurrect PM2 on system boot
# ────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ecosystemPath = Join-Path $projectRoot "ecosystem.config.cjs"

Write-Host "`n=== RVL PM2 Startup Setup ===" -ForegroundColor Cyan

# 1. Check/install PM2 globally
Write-Host "`n[1/4] Checking PM2..." -ForegroundColor Yellow
$pm2Version = & pm2 --version 2>$null
if (-not $pm2Version) {
    Write-Host "  PM2 not found. Installing globally..." -ForegroundColor Yellow
    npm install -g pm2
    $pm2Version = & pm2 --version 2>$null
    if (-not $pm2Version) {
        Write-Host "  ERROR: PM2 installation failed." -ForegroundColor Red
        exit 1
    }
}
Write-Host "  PM2 v$pm2Version is available." -ForegroundColor Green

# 2. Start services
Write-Host "`n[2/4] Starting services via ecosystem.config.cjs..." -ForegroundColor Yellow
Push-Location $projectRoot
pm2 start $ecosystemPath
Pop-Location
Write-Host "  Services started." -ForegroundColor Green

# 3. Save PM2 process list (so `pm2 resurrect` can restore them)
Write-Host "`n[3/4] Saving PM2 process list..." -ForegroundColor Yellow
pm2 save
Write-Host "  Process list saved." -ForegroundColor Green

# 4. Create Scheduled Task for PM2 resurrect on system boot
Write-Host "`n[4/4] Creating Windows Scheduled Task for PM2 auto-start..." -ForegroundColor Yellow

$taskName = "RVL-PM2-Resurrect"
$npmPrefix = (npm config get prefix).Trim()
$pm2Bin = Join-Path $npmPrefix "pm2.cmd"

if (-not (Test-Path $pm2Bin)) {
    # Fallback: try to find pm2 in PATH
    $pm2Bin = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
}

if (-not $pm2Bin) {
    Write-Host "  WARNING: Could not locate pm2.cmd — skipping scheduled task." -ForegroundColor Red
    Write-Host "  You can manually create a task to run: pm2 resurrect" -ForegroundColor Yellow
} else {
    # Remove existing task if any
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "  Removed existing task '$taskName'." -ForegroundColor Yellow
    }

    $action = New-ScheduledTaskAction -Execute $pm2Bin -Argument "resurrect"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Resurrect RVL Lamination PM2 services on login" `
        -RunLevel Limited

    Write-Host "  Scheduled task '$taskName' created — PM2 will auto-resurrect on login." -ForegroundColor Green
}

# Summary
Write-Host "`n=== Setup Complete ===" -ForegroundColor Cyan
Write-Host "  Backend, Ngrok, and Localtunnel will now:"
Write-Host "    - Run in background even after closing the Electron app"
Write-Host "    - Auto-restart on crash (managed by PM2)"
Write-Host "    - Auto-start after system reboot (via scheduled task)"
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor Yellow
Write-Host "    pm2 status          - check running services"
Write-Host "    pm2 logs            - view live logs"
Write-Host "    pm2 restart all     - restart all services"
Write-Host "    pm2 stop all        - stop all services"
Write-Host "    npm run pm2:start   - start via ecosystem config"
Write-Host ""
