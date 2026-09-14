#!/bin/bash
# 切换为 HTTPS：80 端口只做跳转 + 保留续期验证目录，443 反代到游戏服务
set -e
NGINX=/www/server/nginx/sbin/nginx
DOM=${GS_DOMAIN}
CONF=/www/server/panel/vhost/nginx/${DOM}.conf
CERTDIR=/www/server/panel/vhost/cert/${DOM}
WEBROOT=/www/wwwroot/gs-game/acme

echo "MARK cert-sanity"
[ -s "$CERTDIR/fullchain.pem" ] && [ -s "$CERTDIR/privkey.pem" ] && echo "证书文件就绪" || { echo "证书缺失"; exit 1; }
openssl x509 -in "$CERTDIR/fullchain.pem" -noout -subject -enddate

echo "MARK write-vhost"
cat > "$CONF" <<CONFEOF
server
{
    listen 80;
    server_name ${DOM};

    access_log  /www/wwwlogs/mapgame.log;
    error_log   /www/wwwlogs/mapgame.error.log;

    # 证书续期验证目录（必须留在 80 端口）
    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server
{
    listen 443 ssl http2;
    server_name ${DOM};

    ssl_certificate     ${CERTDIR}/fullchain.pem;
    ssl_certificate_key ${CERTDIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers EECDH+CHACHA20:EECDH+CHACHA20-draft:EECDH+AES128:RSA+AES128:EECDH+AES256:RSA+AES256:EECDH+3DES:RSA+3DES:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    access_log  /www/wwwlogs/mapgame.log;
    error_log   /www/wwwlogs/mapgame.error.log;

    #GS-GAME-START  王朝纪元·1444 联机版（独立域名，整站反代 + WebSocket）
    location / {
        proxy_pass http://127.0.0.1:7788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
    }
    #GS-GAME-END
}
CONFEOF

echo "MARK reload"
$NGINX -t
$NGINX -s reload
sleep 1

echo "MARK verify-https"
curl -s -o /dev/null -w "https /        -> %{http_code}\n" -k --resolve ${DOM}:443:127.0.0.1 https://${DOM}/
curl -s -o /dev/null -w "https core.js  -> %{http_code}\n" -k --resolve ${DOM}:443:127.0.0.1 https://${DOM}/game-core.js
curl -s -o /dev/null -w "http  /        -> %{http_code} (应为 301)\n" -H "Host: ${DOM}" http://127.0.0.1/
curl -s -k --resolve ${DOM}:443:127.0.0.1 https://${DOM}/healthz; echo

echo "MARK renew-cron"
crontab -l 2>/dev/null | grep -c acme.sh || true
echo "MARK done"
