#!/usr/bin/env bash
# Донастройка существующей ноды: Apache (HTTPS) + Let's Encrypt + Hysteria с TLS из файлов.
# Сохраняет auth / trafficStats из текущего /etc/hysteria/config.yaml (если есть).
#
# Использование (от root):
#   export DOMAIN=nl2.xtinder.ru
#   export ACME_EMAIL=admin@example.com
#   export AGENT_PORT=4000   # опционально, по умолчанию 4000
#   bash scripts/finish-node-https.sh
#
# Или из каталога репозитория:
#   sudo DOMAIN=... ACME_EMAIL=... bash ./scripts/finish-node-https.sh
set -euo pipefail

DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
AGENT_PORT="${AGENT_PORT:-4000}"
HY2_TLS_DIR="/var/lib/hysteria/letsencrypt"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ "${EUID:-0}" -eq 0 ]] || die "Запустите от root (sudo)"
[[ -n "$DOMAIN" ]] || die "Задайте DOMAIN=..."
[[ -n "$ACME_EMAIL" ]] || die "Задайте ACME_EMAIL=..."
[[ "$ACME_EMAIL" == *"@"* ]] || die "ACME_EMAIL должен быть email"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apache2 certbot python3-certbot-apache

a2enmod ssl proxy proxy_http headers rewrite
a2dissite 000-default.conf 2>/dev/null || true

mkdir -p /var/www/html/.well-known/acme-challenge "$HY2_TLS_DIR"

cat > /etc/apache2/sites-available/hy2-panel-80.conf <<EOF
<VirtualHost *:80>
    ServerName ${DOMAIN}
    DocumentRoot /var/www/html
    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/
    <Directory /var/www/html/.well-known/acme-challenge>
        Require all granted
        Options None
    </Directory>
    ProxyPreserveHost On
    ProxyPass /.well-known/acme-challenge/ !
    ProxyPass / http://127.0.0.1:${AGENT_PORT}/
    ProxyPassReverse / http://127.0.0.1:${AGENT_PORT}/
    RequestHeader set X-Forwarded-Proto "http"
    RequestHeader set X-Forwarded-Port "80"
</VirtualHost>
EOF
a2ensite hy2-panel-80.conf
apache2ctl configtest
systemctl enable apache2
systemctl restart apache2

systemctl start hy2-agent.service 2>/dev/null || true

if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  echo "[INFO] Получаем сертификат Let's Encrypt..."
  certbot certonly --apache -d "${DOMAIN}" --non-interactive --agree-tos -m "${ACME_EMAIL}" --no-eff-email \
    || die "certbot не смог получить сертификат (DNS A, порт 80 снаружи)"
fi

cp -L "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${HY2_TLS_DIR}/fullchain.pem"
cp -L "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" "${HY2_TLS_DIR}/privkey.pem"
if id hysteria &>/dev/null; then
  chown hysteria:hysteria "${HY2_TLS_DIR}/fullchain.pem" "${HY2_TLS_DIR}/privkey.pem" || true
fi
chmod 640 "${HY2_TLS_DIR}/fullchain.pem"
chmod 600 "${HY2_TLS_DIR}/privkey.pem"

cat > /etc/apache2/sites-available/hy2-panel-ssl.conf <<EOF
<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName ${DOMAIN}
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/${DOMAIN}/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/${DOMAIN}/privkey.pem
    Include /etc/letsencrypt/options-ssl-apache.conf
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${AGENT_PORT}/
    ProxyPassReverse / http://127.0.0.1:${AGENT_PORT}/
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"
</VirtualHost>
</IfModule>
EOF
a2ensite hy2-panel-ssl.conf

cat > /etc/apache2/sites-available/hy2-panel-80.conf <<EOF
<VirtualHost *:80>
    ServerName ${DOMAIN}
    DocumentRoot /var/www/html
    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/
    <Directory /var/www/html/.well-known/acme-challenge>
        Require all granted
        Options None
    </Directory>
    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
    RewriteRule ^ https://${DOMAIN}%{REQUEST_URI} [R=301,L]
</VirtualHost>
EOF
apache2ctl configtest
systemctl reload apache2

VENV="/opt/hy2-agent/venv/bin/python3"
[[ -x "$VENV" ]] || die "Нет $VENV — сначала установите агент"

systemctl stop hysteria-server.service 2>/dev/null || true

"$VENV" <<PY
import pathlib
import yaml

hy_path = pathlib.Path("/etc/hysteria/config.yaml")
hy2_tls_dir = pathlib.Path("${HY2_TLS_DIR}")
old = {}
if hy_path.is_file():
    try:
        old = yaml.safe_load(hy_path.read_text(encoding="utf-8")) or {}
    except Exception as e:
        raise SystemExit(f"Не удалось прочитать {hy_path}: {e}")

auth = old.get("auth") or {"type": "userpass", "userpass": {"999999999": "change-me"}}
ts = old.get("trafficStats") or {"listen": ":25413", "secret": "change-me"}
if not isinstance(ts, dict) or "secret" not in ts:
    raise SystemExit("В старом config.yaml нет trafficStats.secret — задайте вручную")

out = {
    "listen": ":443",
    "tls": {
        "cert": str(hy2_tls_dir / "fullchain.pem"),
        "key": str(hy2_tls_dir / "privkey.pem"),
    },
    "auth": auth,
    "masquerade": old.get("masquerade")
    or {"type": "proxy", "proxy": {"url": "https://news.ycombinator.com", "rewriteHost": True}},
    "trafficStats": ts,
}
hy_path.write_text(yaml.safe_dump(out, allow_unicode=True, sort_keys=False), encoding="utf-8")
print("[OK] Записан", hy_path)
PY

install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/99-hy2-hysteria-certs.sh <<'EOS'
#!/bin/bash
set -euo pipefail
if [[ -z "${RENEWED_LINEAGE:-}" ]]; then
  exit 0
fi
HY2_TLS_DIR="/var/lib/hysteria/letsencrypt"
cp -L "${RENEWED_LINEAGE}/fullchain.pem" "${HY2_TLS_DIR}/fullchain.pem"
cp -L "${RENEWED_LINEAGE}/privkey.pem" "${HY2_TLS_DIR}/privkey.pem"
if id hysteria &>/dev/null; then
  chown hysteria:hysteria "${HY2_TLS_DIR}/fullchain.pem" "${HY2_TLS_DIR}/privkey.pem" || true
fi
chmod 640 "${HY2_TLS_DIR}/fullchain.pem"
chmod 600 "${HY2_TLS_DIR}/privkey.pem"
systemctl reload hysteria-server.service || systemctl restart hysteria-server.service || true
EOS
chmod +x /etc/letsencrypt/renewal-hooks/deploy/99-hy2-hysteria-certs.sh

# public_base_url в агенте
"$VENV" <<PY
import json, pathlib
p = pathlib.Path("/opt/hy2-agent/config.json")
cfg = json.loads(p.read_text(encoding="utf-8"))
cfg["public_base_url"] = f"https://${DOMAIN}"
p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("[OK] public_base_url ->", cfg["public_base_url"])
PY

systemctl restart hy2-agent.service
systemctl enable hysteria-server.service
systemctl restart hysteria-server.service

echo ""
echo "Готово. Панель: https://${DOMAIN}/ui"
echo "Проверка: curl -fsS https://${DOMAIN}/healthz"
