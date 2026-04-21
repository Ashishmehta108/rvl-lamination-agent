module.exports = {
  apps: [
    {
      name: "rvl-backend",
      cwd: __dirname,
      script: "apps/backend/dist/index.js",
      env: {
        NODE_ENV: "production"
      },
      max_memory_restart: "600M",
      time: true
    }
  ]
};

