#!/bin/bash

# Setup script for Lamination Agent on Raspberry Pi
# Run this as sudo: sudo ./scripts/setup-pi.sh

set -e

echo "Starting Raspberry Pi setup for Lamination Agent..."

# 1. Update system
echo "Updating system packages..."
apt-get update && apt-get upgrade -y

# 2. Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js is already installed: $(node -v)"
fi

# 3. Install dependencies
echo "Installing project dependencies..."
# Assuming we are in the project root or the script is in scripts/
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

if [ -f "package.json" ]; then
    npm install --production
else
    echo "Error: package.json not found in $PROJECT_ROOT"
    exit 1
fi

# 4. Setup Systemd Service
echo "Setting up systemd service..."

# Detect current user and group
CURRENT_USER=$(whoami)
CURRENT_GROUP=$(id -gn)
PROJECT_ROOT="$(pwd)"

echo "Detected User: $CURRENT_USER"
echo "Detected Path: $PROJECT_ROOT"

SERVICE_TEMPLATE="scripts/lamination-agent.service"
SERVICE_FILE="scripts/lamination-agent.service.temp"
SYSTEMD_PATH="/etc/systemd/system/lamination-agent.service"

if [ -f "$SERVICE_TEMPLATE" ]; then
    # Create a temporary service file with corrected paths and user
    sed -e "s|User=pi|User=$CURRENT_USER|" \
        -e "s|Group=pi|Group=$CURRENT_GROUP|" \
        -e "s|WorkingDirectory=/home/pi/rvl-lamination-agent|WorkingDirectory=$PROJECT_ROOT|" \
        -e "s|/home/pi/rvl-lamination-agent/scripts/run-agent.sh|$PROJECT_ROOT/scripts/run-agent.sh|" \
        "$SERVICE_TEMPLATE" > "$SERVICE_FILE"

    cp "$SERVICE_FILE" "$SYSTEMD_PATH"
    
    # Update the run-agent.sh path internally too
    sed -i "s|PROJECT_DIR=\"/home/pi/rvl-lamination-agent\"|PROJECT_DIR=\"$PROJECT_ROOT\"|" scripts/run-agent.sh

    # Make sure scripts are executable
    chmod +x scripts/run-agent.sh
    
    # Reload systemd and enable service
    systemctl daemon-reload
    systemctl enable lamination-agent
    systemctl restart lamination-agent
    
    echo "Service lamination-agent has been enabled and started with user $CURRENT_USER."
else
    echo "Error: Service template $SERVICE_TEMPLATE not found."
    exit 1
fi

echo "Setup complete!"
echo "You can check the status with: systemctl status lamination-agent"
echo "You can view logs with: journalctl -u lamination-agent -f"
