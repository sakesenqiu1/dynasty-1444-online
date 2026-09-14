#!/bin/bash
# 为 ${GS_DOMAIN} 建立独立站点：整站反代到游戏服务
set -e
NGINX=/www/server/nginx/sbin/nginx
CONF=/www/server/panel/vhost/nginx/${GS_DOMAIN}.conf

echo "MARK existing-certs"
ls -1 /www/server/panel/vhost/cert/ 2>/dev/null | head -30
echo "MARK wildcard-check"
for d in /www/server/panel/vhost/cert/*/; do
  n=$(basename "$d")
  if [ -f "$d/fullchain.pem" ]; then
    dom=$(openssl x509 -in "$d/fullchain.pem" -noout -text 2>/dev/null | grep -A1 "Subject Alternative Name" | tail -1)
    echo "$n => $dom"
  fi
done
echo "MARK write-vhost"
cat > "$CONF" <<'CONFEOF'
server
{
    listen 80;
    server_name ${GS_DOMAIN};

    access_log  /www/wwwlogs/mapgame.log;
    error_log   /www/wwwlogs/mapgame.error.log;

    #GS-GAME-START  王朝纪元·1444 联机版（独立域名，整站反代）
    location / {
        proxy_pass http://127.0.0.1:7788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
    }
    #GS-GAME-END
}
CONFEOF

echo "MARK nginx-test"
$NGINX -t
$NGINX -s reload
sleep 1
echo "MARK verify-local"
curl -s -o /dev/null -w "mapgame /        -> %{http_code}\n" -H "Host: ${GS_DOMAIN}" http://127.0.0.1/
curl -s -o /dev/null -w "mapgame core.js  -> %{http_code}\n" -H "Host: ${GS_DOMAIN}" http://127.0.0.1/game-core.js
curl -s -H "Host: ${GS_DOMAIN}" http://127.0.0.1/healthz; echo
echo "MARK done"
