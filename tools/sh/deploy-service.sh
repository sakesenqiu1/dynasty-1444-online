#!/bin/bash
# 安装并启动 systemd 服务
set -e
echo "MARK write-unit"
cat > /etc/systemd/system/gs-game.service <<'UNIT'
[Unit]
Description=Dynasty 1444 - multiplayer game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/www/wwwroot/gs-game/srv
Environment=PORT=7788
Environment=HOST=127.0.0.1
Environment=BASE=/gs
Environment=MAX_ROOMS=40
ExecStart=/usr/local/bin/node /www/wwwroot/gs-game/srv/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=append:/var/log/gs-game.log
StandardError=append:/var/log/gs-game.log

[Install]
WantedBy=multi-user.target
UNIT

echo "MARK install-deps"
cd /www/wwwroot/gs-game/srv
if [ ! -d node_modules/ws ]; then
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
fi

echo "MARK enable-start"
systemctl daemon-reload
systemctl enable gs-game >/dev/null 2>&1
systemctl restart gs-game
sleep 3

echo "MARK status"
systemctl is-active gs-game
systemctl --no-pager -l status gs-game | head -14

echo "MARK local-http"
curl -s -o /dev/null -w "healthz=%{http_code}\n" http://127.0.0.1:7788/healthz
curl -s -o /dev/null -w "index=%{http_code}\n" http://127.0.0.1:7788/gs/
curl -s -o /dev/null -w "core=%{http_code}\n" http://127.0.0.1:7788/gs/game-core.js
echo "MARK through-nginx"
curl -s -o /dev/null -w "nginx-index=%{http_code}\n" http://127.0.0.1/gs/
curl -s -o /dev/null -w "nginx-healthz=%{http_code}\n" http://127.0.0.1/gs/../healthz
echo "MARK log"
tail -6 /var/log/gs-game.log
echo "MARK done"
