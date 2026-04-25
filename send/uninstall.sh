#!/usr/bin/env bash
# ============================================================
#  uninstall.sh — Removal script for Nonwoven AI Agent
#  Run on the Raspberry Pi as root:
#    sudo bash uninstall.sh
# ============================================================
set -euo pipefail

SERVICE_NAME=nonwoven-agent
APP_DIR=/opt/nonwoven-agent
DATA_DIR=/var/lib/nonwoven-agent

echo "======================================================"
# 1. Stop and Disable Service
echo "[1/4] Stopping and disabling $SERVICE_NAME ..."
systemctl stop "$SERVICE_NAME" || true
systemctl disable "$SERVICE_NAME" || true

# 2. Remove systemd service file
echo "[2/4] Removing systemd service file ..."
if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
    rm "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    systemctl reset-failed
    echo "       ✓ Service file removed"
else
    echo "       ✓ Service file already gone"
fi

# 3. Remove application directory
echo "[3/4] Removing application directory: $APP_DIR ..."
if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    echo "       ✓ App directory removed"
else
    echo "       ✓ App directory already gone"
fi

# 4. Optional: Remove data directory (WAL/logs)
# Uncomment the following lines if you want to wipe all stored data too
# echo "[4/4] Removing data directory: $DATA_DIR ..."
# rm -rf "$DATA_DIR"
# echo "       ✓ Data directory removed"

echo "======================================================"
echo "  Uninstallation complete!"
echo "======================================================"
