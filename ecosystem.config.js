module.exports = {
  apps: [
    {
      name: 'clickup-ws-daemon',
      script: './scripts/ws-daemon.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      // Restart the daemon every 12 hours to prevent memory leaks and stale websockets
      cron_restart: '*/15 * * * *',
      env: {
        NODE_ENV: 'production',
        // ClickUp credentials
        CLICKUP_EMAIL: process.env.CLICKUP_EMAIL,
        CLICKUP_PASSWORD: process.env.CLICKUP_PASSWORD,
        CLICKUP_USER_ID: process.env.CLICKUP_USER_ID,
        
        // Where to send detection events (points to your local Clawdbot instance or relay)
        // Default: point to the event handler script which already knows how to wake Clawdbot
        CLICKUP_WS_CALLBACK: 'http://127.0.0.1:3482/clickup/event',
        
        // Optional logging
        CLICKUP_WS_LOG: '/tmp/clickup-ws-raw.log',
      }
    },
    {
      name: 'clickup-event-handler',
      script: './scripts/clickup-event-handler.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        CLICKUP_API_KEY: process.env.CLICKUP_API_KEY,
        PORT: 3482
      }
    }
  ]
};
