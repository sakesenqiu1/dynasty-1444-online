#!/bin/bash
# 部署 王朝纪元·1444 联机版：nginx 反向代理 /gs/ -> 127.0.0.1:7788
# 幂等：重复执行会先把旧配置块摘掉再写入最新的
set -e
CONF=/www/server/panel/vhost/nginx/${GS_HOST}.conf
NGINX=/www/server/nginx/sbin/nginx

echo "MARK selinux"
getenforce 2>/dev/null || echo "selinux n/a"

echo "MARK patch-nginx"
python3 - "$CONF" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8', errors='ignore').read()

# 先摘掉旧的标记块（若有）
s2 = re.sub(r'\n?[ \t]*#GS-GAME-START.*?#GS-GAME-END\n?', '\n', s, flags=re.S)
had = s2 != s
s = s2

block = """
    #GS-GAME-START  王朝纪元·1444 联机版反向代理（由部署脚本维护，请勿手改）
    # 不带斜杠时补一个斜杠，避免落到站点根目录的 404
    location = /gs { return 301 /gs/; }

    location ^~ /gs/ {
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
"""
i = s.rstrip().rfind('}')
assert i > 0, 'cannot find server block end'
s = s[:i] + block + s[i:]
open(p, 'w', encoding='utf-8').write(s)
print(('replaced' if had else 'inserted'), 'game block in', p)
PY

echo "MARK nginx-test"
$NGINX -t
echo "MARK nginx-reload"
$NGINX -s reload
sleep 1
echo "MARK verify"
# 注意：必须带上 Host 头，否则 nginx 会落到默认站点（server_name _）而返回 404
curl -s -o /dev/null -w "local /gs/   -> %{http_code}\n" -H "Host: ${GS_HOST}" http://127.0.0.1/gs/
curl -s -o /dev/null -w "local /gs    -> %{http_code}\n" -H "Host: ${GS_HOST}" http://127.0.0.1/gs
curl -s -o /dev/null -w "local core   -> %{http_code}\n" -H "Host: ${GS_HOST}" http://127.0.0.1/gs/game-core.js
echo "MARK done"
