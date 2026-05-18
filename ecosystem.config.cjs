const path = require("path");

// On Windows, npx is a .cmd file — must be invoked via cmd.exe
const isWin = process.platform === "win32";
const npxCmd = isWin ? "cmd" : "npx";
const ngrokArgs = isWin
  ? ["/c", "npx", "ngrok", "http", "7000"]
  : ["ngrok", "http", "7000"];

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
      script: npxCmd,
      args: ngrokArgs,
      interpreter: "none",
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
