module.exports = {
  apps: [{
    name: 'dynasty-1444',
    script: 'srv/server.js',
    cwd: __dirname,
    env: {
      PORT: 7788,
      BASE: '/gs'
    },
    autorestart: true,
    watch: false,
    max_memory_restart: '200M'
  }]
};
