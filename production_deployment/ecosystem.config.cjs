module.exports = {
  apps: [
    {
      name: 'rvl-frontend',
      script: 'npm',
      args: 'run dev',
      cwd: 'C:\\Users\\ashis\\rvl-lamination-agent\\apps\\web',  // absolute path
      shell: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
    {
      name: 'rvl-backend',
      script: 'node',
      args: 'dist/index.js',
      cwd: 'C:\\Users\\ashis\\rvl-lamination-agent\\apps\\backend',  // absolute path
      env: {
        NODE_ENV: 'production',
        PORT: 7000
      },
      restart_delay: 2000,
      exp_backoff_restart_delay: 100
    },
    {
      name: 'tunnel-frontend',
      script: 'lt',                          // use global lt, not npx
      args: '--port 3000 --subdomain lamination-ai-agent',
      shell: true,
      restart_delay: 5000,
      autorestart: true
    },
    {
      name: 'tunnel-backend',
      script: 'ngrok',                       // use global ngrok, not npx
      args: 'http 7000',
      shell: true,
      restart_delay: 5000,
      autorestart: true
    }
  ]
};