module.exports = {
  apps: [
    {
      name: 'flap-vault-monitor',
      script: 'monitor.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
  ],
};
