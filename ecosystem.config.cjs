const path = require("path");

module.exports = {
  apps: [
    {
      name: "rvl-backend",
      cwd: __dirname,
      script: "apps/backend/dist/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: "7000"
      },
      max_memory_restart: "600M",
      max_restarts: 10,
      restart_delay: 2000,
      autorestart: true,
      time: true
    },
    {
      name: "rvl-ngrok",
      cwd: __dirname,
      script: "ngrok-start.cjs",   // wrapper handles windowsHide
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      },
      max_restarts: 5,
      restart_delay: 5000,
      autorestart: true,
      time: true
    }
  ]
};
