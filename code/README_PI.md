# Raspberry Pi Deployment Guide

This guide explains how to set up the Lamination Agent to run automatically on your Raspberry Pi.

## Prerequisites

1. A Raspberry Pi running Raspberry Pi OS (Debian-based).
2. SSH access or terminal access to the Pi.
3. The project files copied to `/home/pi/rvl-lamination-agent`.

## Installation

1. **Clone/Copy the project**: Ensure the project is located at `/home/pi/rvl-lamination-agent`.
2. **Navigate to the directory**:
   ```bash
   cd /home/pi/rvl-lamination-agent
   ```
3. **Run the setup script**:
   The setup script will install Node.js (if missing), install npm dependencies, and configure the systemd service.
   ```bash
   sudo chmod +x scripts/setup-pi.sh
   sudo ./scripts/setup-pi.sh
   ```

## Managing the Service

Once installed, the agent will start automatically on boot. You can manage it manually using the following commands:

- **Check status**:
  ```bash
  systemctl status lamination-agent
  ```
- **Stop the agent**:
  ```bash
  sudo systemctl stop lamination-agent
  ```
- **Start the agent**:
  ```bash
  sudo systemctl start lamination-agent
  ```
- **Restart the agent**:
  ```bash
  sudo systemctl restart lamination-agent
  ```
- **View live logs**:
  ```bash
  journalctl -u lamination-agent -f
  ```

## Configuration

The agent uses environment variables defined in the `.env` file. Ensure you have configured your `.env` file correctly in the project root before starting the service.

If you change the installation path from `/home/pi/rvl-lamination-agent`, make sure to update the following files:
1. `scripts/run-agent.sh` (PROJECT_DIR variable)
2. `scripts/lamination-agent.service` (WorkingDirectory and ExecStart paths)
