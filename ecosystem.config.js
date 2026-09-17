module.exports = {
  apps: [{
    name: 'dynasty-1444',
    script: 'srv/server.js',
    cwd: __dirname,
    env: {
      PORT: 7788,
      BASE: '/gs',
      /* 地图工坊：玩家提交的地图仓库。
         不设时默认落在 srv/maps/，这里显式写出来便于备份与排查。 */
      MAPS_DIR: require('path').join(__dirname, 'srv', 'maps'),
      /* 地图审核后台的管理员口令。**必须自己提供**，不要写死在这个文件里：
           MAP_ADMIN_PASS=你的口令 npx pm2 start ecosystem.config.js
         没提供时审核接口会自动关闭（fail closed），游戏本身照常运行。 */
      MAP_ADMIN_PASS: process.env.MAP_ADMIN_PASS || ''
    },
    autorestart: true,
    watch: false,
    max_memory_restart: '200M'
  }]
};
