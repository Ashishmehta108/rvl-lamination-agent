#!/bin/bash

# Simple runner script for the Lamination Agent
# Ensures we are in the correct directory and environment

# Navigate to the project directory
# Adjust this path if you install the project elsewhere
PROJECT_DIR="/home/pi/rvl-lamination-agent"

if [ -d "$PROJECT_DIR" ]; then
    cd "$PROJECT_DIR"
else
    echo "Error: Project directory $PROJECT_DIR not found."
    exit 1
fi

# Run the agent
# Using npm start to respect package.json scripts
npm start
