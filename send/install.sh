#!/usr/bin/env bash
# ============================================================
#  install.sh — Production deployment for Nonwoven AI Agent
#  Run once on the Raspberry Pi as root:
#    sudo bash install.sh
# ============================================================
set -euo pipefail

APP_DIR=/opt/nonwoven-agent
DATA_DIR=/var/lib/nonwoven-agent
SERVICE_NAME=nonwoven-agent
PYTHON=python3

echo "======================================================"
echo "  Nonwoven Agent — Production Installer"
echo "======================================================"

# ── 1. System dependencies ────────────────────────────────────
echo "[1/7] Installing system packages …"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip

# ── 2. Create app directory & virtual environment ─────────────
echo "[2/7] Setting up app directory at $APP_DIR …"
mkdir -p "$APP_DIR"
$PYTHON -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --upgrade pip --quiet
"$APP_DIR/venv/bin/pip" install pymodbus requests python-dotenv --quiet
echo "       ✓ Python venv ready"

# ── 3. Copy application file ──────────────────────────────────
echo "[3/7] Copying data_source.py …"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/data_source.py" "$APP_DIR/data_source.py"
chmod 755 "$APP_DIR/data_source.py"
echo "       ✓ Script installed"

# ── 4. Create WAL data directories ───────────────────────────
echo "[4/7] Creating WAL data directories …"
mkdir -p "$DATA_DIR/wal" "$DATA_DIR/sent" "$DATA_DIR/dead" "$DATA_DIR/logs"
chmod -R 755 "$DATA_DIR"
echo "       ✓ Directories: $DATA_DIR/{wal,sent,dead,logs}"

# ── 5. Install .env if not present ───────────────────────────
echo "[5/7] Checking .env …"
if [ ! -f "$APP_DIR/.env" ]; then
    cp "$SCRIPT_DIR/.env.example" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
    echo "       ⚠  Created $APP_DIR/.env from template"
    echo "       ⚠  EDIT THIS FILE before starting the service!"
else
    echo "       ✓ .env already exists (not overwritten)"
fi

# ── 6. Install systemd service ────────────────────────────────
echo "[6/7] Installing systemd service …"
cp "$SCRIPT_DIR/nonwoven-agent.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "       ✓ Service enabled: $SERVICE_NAME"

# ── 7. Optional: allow port 502 without root ──────────────────
echo "[7/7] Granting CAP_NET_BIND_SERVICE for port 502 …"
PYTHON_BIN="$APP_DIR/venv/bin/python3"
if command -v setcap &>/dev/null; then
    setcap 'cap_net_bind_service=+ep' "$PYTHON_BIN"
    echo "       ✓ setcap applied — service can now bind port 502 as non-root"
    # Now update service to run as non-root
    sed -i 's/^User=root/User=pi/' "/etc/systemd/system/$SERVICE_NAME.service"
    sed -i 's/^Group=root/Group=pi/' "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    echo "       ✓ Service updated to run as 'pi' user"
else
    echo "       ⚠  setcap not found — service will run as root"
fi

echo ""
echo "======================================================"
echo "  Installation complete!"
echo ""
echo "  Next steps:"
echo "    1. Edit /opt/nonwoven-agent/.env  (fill in your ngrok URL & token)"
echo "    2. sudo systemctl start $SERVICE_NAME"
echo "    3. sudo systemctl status $SERVICE_NAME"
echo "    4. sudo journalctl -u $SERVICE_NAME -f   (live logs)"
echo ""
echo "  WAL data stored at: $DATA_DIR"
echo "    wal/   — pending batches (will auto-replay)"
echo "    sent/  — confirmed sent (pruned after 24h)"
echo "    dead/  — permanently failed (investigate!)"
echo "    logs/  — rotating log files"
echo "======================================================"
