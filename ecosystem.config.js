module.exports = {
  apps: [
    {
      name:              'cardcove-backend',
      script:            'server.js',
      cwd:               '/var/www/cardcove/backend',
      instances:         2,
      exec_mode:         'cluster',
      watch:             false,
      max_memory_restart:'512M',
      env_production: {
        NODE_ENV: 'production',
        PORT:     5000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/var/log/cardcove/backend-error.log',
      out_file:        '/var/log/cardcove/backend-out.log',
      merge_logs:      true,
      restart_delay:   3000,
      max_restarts:    10,
      min_uptime:      '10s',
    },
    {
      name:              'cardcove-admin',
      script:            'node_modules/.bin/next',
      args:              'start -p 3000',
      cwd:               '/var/www/cardcove/admin',
      instances:         1,
      watch:             false,
      env_production: {
        NODE_ENV: 'production',
        PORT:     3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/var/log/cardcove/admin-error.log',
      out_file:        '/var/log/cardcove/admin-out.log',
      merge_logs:      true,
      restart_delay:   3000,
      max_restarts:    10,
      min_uptime:      '10s',
    },
  ]
};
