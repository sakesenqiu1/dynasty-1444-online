#!/bin/bash
# 为 ${GS_DOMAIN} 申请 Let's Encrypt 证书
# 用 webroot 方式，先在站点里放一个 acme-challenge location，不影响任何既有站点
set -e
NGINX=/www/server/nginx/sbin/nginx
DOM=${GS_DOMAIN}
CONF=/www/server/panel/vhost/nginx/${DOM}.conf
WEBROOT=/www/wwwroot/gs-game/acme
CERTDIR=/www/server/panel/vhost/cert/${DOM}
ACME=/root/.acme.sh/acme.sh

mkdir -p "$WEBROOT/.well-known/acme-challenge" "$CERTDIR"

echo "MARK write-http-vhost-with-challenge"
cat > "$CONF" <<CONFEOF
server
{
    listen 80;
    server_name ${DOM};

    access_log  /www/wwwlogs/mapgame.log;
    error_log   /www/wwwlogs/mapgame.error.log;

    # 证书验证目录必须走本地文件，不能代理到游戏服务
    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    #GS-GAME-START  王朝纪元·1444 联机版（独立域名，整站反代）
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

$NGINX -t >/dev/null 2>&1 && $NGINX -s reload
sleep 1
echo "MARK challenge-endpoint"
echo "probe-$$" > "$WEBROOT/.well-known/acme-challenge/probe"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOM}" "http://127.0.0.1/.well-known/acme-challenge/probe")
echo "challenge http code = $code"
rm -f "$WEBROOT/.well-known/acme-challenge/probe"
if [ "$code" != "200" ]; then echo "挑战目录不可用，放弃签发"; exit 1; fi

echo "MARK issue"
"$ACME" --register-account -m admin@${DOM} --server letsencrypt >/dev/null 2>&1 || true
"$ACME" --issue -d "${DOM}" --webroot "$WEBROOT" --server letsencrypt --keylength ec-256 --force 2>&1 | tail -20

echo "MARK install-cert"
"$ACME" --install-cert -d "${DOM}" --ecc \
  --key-file       "${CERTDIR}/privkey.pem" \
  --fullchain-file "${CERTDIR}/fullchain.pem" \
  --reloadcmd      "$NGINX -s reload" 2>&1 | tail -5

echo "MARK cert-files"
ls -l "$CERTDIR"
echo "MARK done"
