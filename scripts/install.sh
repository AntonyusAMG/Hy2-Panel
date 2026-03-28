#!/usr/bin/env bash
# HY2 Panel — установка Hysteria 2 + Node Agent на Ubuntu 24.04
# Использование:
#   sudo bash scripts/install.sh MASTER_URL TOKEN "NODE_NAME" DOMAIN
# Локально (из корня репозитория):
#   sudo bash ./scripts/install.sh https://master.example.com "$(openssl rand -hex 32)" "FI-01" vpn.example.com
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_AGENT_SRC="${REPO_ROOT}/node-agent"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

die() { error "$*"; exit 1; }

require_root() {
  if [[ "${EUID:-0}" -ne 0 ]]; then
    die "Запустите скрипт от root: sudo $0 ..."
  fi
}

check_ubuntu_24() {
  [[ -f /etc/os-release ]] || die "Не найден /etc/os-release"
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "Требуется Ubuntu (сейчас: ${ID:-unknown})"
  [[ "${VERSION_ID:-}" == "24.04" ]] || die "Требуется Ubuntu 24.04 LTS (сейчас: ${VERSION_ID:-unknown})"
}

# Hysteria 2 использует в основном UDP :443; Apache — TCP :443. Конфликт только если чужой процесс занял TCP 443.
check_tcp443_available() {
  local line
  line="$(ss -H -tlnp 2>/dev/null | grep -E ':443(\s|$)' || true)"
  if [[ -z "$line" ]]; then
    return 0
  fi
  if echo "$line" | grep -qE 'apache2|httpd'; then
    info "TCP 443 уже слушает Apache — продолжаем (certbot/HTTPS)."
    return 0
  fi
  die "TCP 443 занят (нужен для HTTPS Apache). Проверьте: ss -tlnp | grep 443"
}

usage() {
  cat <<EOF
Установка HY2 Panel (Hysteria 2 + агент)

Использование:
  sudo bash ${SCRIPT_DIR}/install.sh MASTER_URL TOKEN "NODE_NAME" DOMAIN

Аргументы:
  MASTER_URL  — URL мастер-панели (https://...)
  TOKEN       — Bearer-токен для API агента (рекомендуется \`openssl rand -hex 32\`)
  NODE_NAME   — отображаемое имя ноды
  DOMAIN      — домен для ACME (A-запись на этот сервер)

Переменные окружения (опционально):
  ACME_EMAIL  — email для Let's Encrypt (если не задан — спросит интерактивно)

  HAPP (подписка HAPP / заголовок профиля) — не приходят с мастера; мастер при регистрации
  не отдаёт страну. Задайте до установки или отредактируйте /opt/hy2-agent/config.json позже:
    HY2_CFG_HAPP_PROFILE_TITLE   — например "⚡ XTinder VPN" (#profile-title в подписке)
    HY2_CFG_COUNTRY_CODE         — ISO, например NL (флаг/название подтянутся из пресетов агента)
    HY2_CFG_COUNTRY_FLAG         — переопределение флага, например 🇳🇱
    HY2_CFG_COUNTRY_NAME         — переопределение названия страны
    HY2_CFG_SUPPORT_URL          — Telegram: https://t.me/...
    HY2_CFG_PROFILE_WEB_URL      — страница «инфо»: https://...

Панель по HTTPS: Apache (TCP 443) → reverse-proxy на агент; сертификат Let's Encrypt через certbot (автопродление).
Hysteria 2 (QUIC) слушает UDP 443 с теми же сертификатами из файлов (TCP 443 не занимает).

Нелокальные копии agent/ui берутся из: ${NODE_AGENT_SRC}
EOF
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }

[[ $# -ge 4 ]] || { usage; die "Нужно 4 аргумента."; }

MASTER_URL="${1%/}"
AGENT_TOKEN="$2"
NODE_NAME="$3"
DOMAIN="$4"
AGENT_PORT="${AGENT_PORT:-4000}"

[[ -n "$MASTER_URL" ]] || die "MASTER_URL пустой"
[[ -n "$AGENT_TOKEN" ]] || die "TOKEN пустой"
if [[ "${#AGENT_TOKEN}" -lt 16 ]]; then
  warn "Токен короче 16 символов — для продакшена лучше openssl rand -hex 32"
fi
[[ -n "$NODE_NAME" ]] || die "NODE_NAME пустой"
[[ -n "$DOMAIN" ]] || die "DOMAIN пустой"

[[ -d "$NODE_AGENT_SRC" ]] || die "Не найден каталог node-agent: ${NODE_AGENT_SRC}"
[[ -f "$NODE_AGENT_SRC/agent.py" ]] || die "Не найден ${NODE_AGENT_SRC}/agent.py"
[[ -f "$NODE_AGENT_SRC/requirements.txt" ]] || die "Не найден ${NODE_AGENT_SRC}/requirements.txt"

require_root
check_ubuntu_24

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}  HY2 Panel — установка ноды (Hysteria 2 + агент)        ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
info "Мастер:     $MASTER_URL"
info "Имя ноды:   $NODE_NAME"
info "Домен:      $DOMAIN"
info "Порт агента: $AGENT_PORT"
echo ""

if [[ -n "${ACME_EMAIL:-}" ]]; then
  info "ACME email: $ACME_EMAIL (из окружения ACME_EMAIL)"
else
  read -r -p "Email для Let's Encrypt / ${ACME_CA} (уведомления CA): " ACME_EMAIL
  [[ "$ACME_EMAIL" == *"@"* ]] || die "Нужен корректный email для ACME"
fi

if [[ -n "${HY2_PANEL_LOGIN:-}" && -n "${HY2_PANEL_PASSWORD:-}" ]]; then
  PANEL_LOGIN="$HY2_PANEL_LOGIN"
  PANEL_PASSWORD="$HY2_PANEL_PASSWORD"
  info "Используются HY2_PANEL_LOGIN / HY2_PANEL_PASSWORD из окружения"
else
  read -r -p "Логин панели ноды: " PANEL_LOGIN
  [[ -n "$PANEL_LOGIN" ]] || die "Логин не может быть пустым"
  while true; do
    read -r -s -p "Пароль панели (мин. 8 символов): " PANEL_PASSWORD
    echo ""
    read -r -s -p "Повторите пароль: " PANEL_PASSWORD2
    echo ""
    [[ "${#PANEL_PASSWORD}" -ge 8 ]] || { warn "Пароль слишком короткий"; continue; }
    [[ "$PANEL_PASSWORD" == "$PANEL_PASSWORD2" ]] || { warn "Пароли не совпадают"; continue; }
    break
  done
fi

read -r -p "Продолжить установку? [y/N]: " CONFIRM
[[ "${CONFIRM,,}" == "y" || "${CONFIRM,,}" == "yes" ]] || die "Отменено пользователем."

check_tcp443_available

info "Обновление списка пакетов..."
apt-get update -qq

info "Обновление установленных пакетов (может занять время)..."
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

info "Установка зависимостей (в т.ч. Apache + certbot для HTTPS панели)..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3 python3-pip python3-venv ufw git openssl dnsutils \
  apache2 certbot python3-certbot-apache

info "Проверка DNS для ACME (A-запись должна указывать на этот сервер)..."
RRS="$(dig +short A "$DOMAIN" 2>/dev/null | head -n1)"
if [[ -z "$RRS" ]]; then
  warn "Для ${DOMAIN} нет A-записи или DNS ещё не обновился — выпуск сертификата может не пройти."
else
  info "DNS A ${DOMAIN} → ${RRS}"
  PUB_IP_PRE="$(curl -fsSL --connect-timeout 10 https://ipinfo.io/ip 2>/dev/null || true)"
  if [[ -n "$PUB_IP_PRE" && "$RRS" != "$PUB_IP_PRE" ]]; then
    warn "Публичный IP сервера (${PUB_IP_PRE}) не совпадает с A-записью (${RRS}). Для Let's Encrypt они должны совпадать."
  fi
fi

info "Версии:"
python3 --version
curl --version | head -n1
git --version

info "Установка Hysteria 2 (официальный скрипт get.hy2.sh)..."
bash <(curl -fsSL https://get.hy2.sh/)

command -v hysteria >/dev/null 2>&1 || die "hysteria не найден в PATH после установки"
hysteria version

if ! systemctl list-unit-files | grep -q '^hysteria-server.service'; then
  warn "Юнит hysteria-server.service не найден в list-unit-files — проверьте установку HY2"
fi

STATS_SECRET="$(openssl rand -hex 32)"
JWT_SECRET="$(openssl rand -hex 32)"
HY2_TLS_DIR="/var/lib/hysteria/letsencrypt"
# HY2 ≥2.7 не принимает пустой userpass — временный пользователь, удалите в панели после добавления своих
HY2_PLACEHOLDER_TG="${HY2_PLACEHOLDER_TG:-999999999}"
PLACEHOLDER_USERPASS="$(openssl rand -hex 16)"

info "Создание каталогов..."
mkdir -p /etc/hysteria /opt/hy2-agent/ui /var/log/hy2-agent "$HY2_TLS_DIR"
if id hysteria &>/dev/null; then
  chown -R hysteria:hysteria "$HY2_TLS_DIR" || warn "chown ${HY2_TLS_DIR} не удался"
else
  warn "Пользователь hysteria не найден — после установки HY2 проверьте права на ${HY2_TLS_DIR}"
fi

info "Остановка hysteria-server до выпуска сертификатов (конфиг запишем после Let's Encrypt)..."
systemctl stop hysteria-server.service 2>/dev/null || true
systemctl disable hysteria-server.service 2>/dev/null || true

info "Python venv и зависимости агента..."
python3 -m venv /opt/hy2-agent/venv
/opt/hy2-agent/venv/bin/pip install --upgrade pip -q
/opt/hy2-agent/venv/bin/pip install -r "$NODE_AGENT_SRC/requirements.txt" -q

info "Копирование agent.py и ui..."
cp -f "$NODE_AGENT_SRC/agent.py" /opt/hy2-agent/agent.py
cp -f "$NODE_AGENT_SRC/requirements.txt" /opt/hy2-agent/requirements.txt
if [[ -f "$NODE_AGENT_SRC/ui/index.html" ]]; then
  cp -f "$NODE_AGENT_SRC/ui/index.html" /opt/hy2-agent/ui/index.html
else
  warn "Нет ui/index.html — сгенерирован минимальный заглушечный файл"
  echo '<!DOCTYPE html><html><head><meta charset="utf-8"><title>HY2</title></head><body><p>HY2 UI</p></body></html>' > /opt/hy2-agent/ui/index.html
fi

info "Хэш пароля панели (bcrypt)..."
PASSWORD_HASH="$(printf '%s' "$PANEL_PASSWORD" | /opt/hy2-agent/venv/bin/python3 -c "import sys; from passlib.hash import bcrypt; print(bcrypt.hash(sys.stdin.read()), end='')")"

export HY2_CFG_NODE_NAME="$NODE_NAME"
export HY2_CFG_MASTER_URL="$MASTER_URL"
export HY2_CFG_TOKEN="$AGENT_TOKEN"
export HY2_CFG_AGENT_PORT="$AGENT_PORT"
export HY2_CFG_STATS_SECRET="$STATS_SECRET"
export HY2_CFG_LOGIN="$PANEL_LOGIN"
export HY2_CFG_PASSWORD_HASH="$PASSWORD_HASH"
export HY2_CFG_JWT_SECRET="$JWT_SECRET"
export HY2_CFG_DOMAIN="$DOMAIN"
HAPP_SUB_KEY="$(openssl rand -hex 24)"
export HY2_CFG_HAPP_SUB_KEY="$HAPP_SUB_KEY"

# HAPP: мастер страну не присылает — только опциональные env (см. usage).
export HY2_CFG_HAPP_PROFILE_TITLE="${HY2_CFG_HAPP_PROFILE_TITLE:-}"
export HY2_CFG_COUNTRY_CODE="${HY2_CFG_COUNTRY_CODE:-}"
export HY2_CFG_COUNTRY_FLAG="${HY2_CFG_COUNTRY_FLAG:-}"
export HY2_CFG_COUNTRY_NAME="${HY2_CFG_COUNTRY_NAME:-}"
export HY2_CFG_SUPPORT_URL="${HY2_CFG_SUPPORT_URL:-}"
export HY2_CFG_PROFILE_WEB_URL="${HY2_CFG_PROFILE_WEB_URL:-}"

info "Запись /opt/hy2-agent/config.json..."
/opt/hy2-agent/venv/bin/python3 <<'PY'
import json, os
node = os.environ.get("HY2_CFG_NODE_NAME", "VPN") or "VPN"
dom = (os.environ.get("HY2_CFG_DOMAIN") or "").strip()
public_base_url = f"https://{dom}" if dom else ""
cfg = {
    "node_name": node,
    "master_url": os.environ["HY2_CFG_MASTER_URL"],
    "token": os.environ["HY2_CFG_TOKEN"],
    "agent_port": int(os.environ.get("HY2_CFG_AGENT_PORT", "4000")),
    "hysteria_config": "/etc/hysteria/config.yaml",
    "hysteria_service": "hysteria-server",
    "stats_secret": os.environ["HY2_CFG_STATS_SECRET"],
    "login": os.environ["HY2_CFG_LOGIN"],
    "password_hash": os.environ["HY2_CFG_PASSWORD_HASH"],
    "jwt_secret": os.environ["HY2_CFG_JWT_SECRET"],
    "happ_subscription_key": os.environ.get("HY2_CFG_HAPP_SUB_KEY", ""),
    "public_base_url": public_base_url,
    "happ": {
        "profile_title": (os.environ.get("HY2_CFG_HAPP_PROFILE_TITLE") or "").strip(),
        "country_code": (os.environ.get("HY2_CFG_COUNTRY_CODE") or "").strip(),
        "country_flag": (os.environ.get("HY2_CFG_COUNTRY_FLAG") or "").strip(),
        "country_name": (os.environ.get("HY2_CFG_COUNTRY_NAME") or "").strip(),
        "region_label": "",
        "support_url": (os.environ.get("HY2_CFG_SUPPORT_URL") or "").strip(),
        "profile_web_page_url": (os.environ.get("HY2_CFG_PROFILE_WEB_URL") or "").strip(),
        "subscription_total_bytes": 0,
        "default_expire_unix": 0,
    },
    "user_expires": {},
}
with open("/opt/hy2-agent/config.json", "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY

unset HY2_CFG_NODE_NAME HY2_CFG_MASTER_URL HY2_CFG_TOKEN HY2_CFG_AGENT_PORT HY2_CFG_STATS_SECRET HY2_CFG_LOGIN HY2_CFG_PASSWORD_HASH HY2_CFG_JWT_SECRET HY2_CFG_HAPP_SUB_KEY HY2_CFG_DOMAIN
unset HY2_CFG_HAPP_PROFILE_TITLE HY2_CFG_COUNTRY_CODE HY2_CFG_COUNTRY_FLAG HY2_CFG_COUNTRY_NAME HY2_CFG_SUPPORT_URL HY2_CFG_PROFILE_WEB_URL

info "Установка systemd: hy2-agent.service..."
cp -f "$NODE_AGENT_SRC/hy2-agent.service" /etc/systemd/system/hy2-agent.service
sed -i "s/--port 4000/--port ${AGENT_PORT}/g" /etc/systemd/system/hy2-agent.service

info "Настройка UFW (HTTP/HTTPS для Apache и панели)..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow "${AGENT_PORT}"/tcp
ufw --force enable

info "Apache: модули и виртуальный хост (HTTP → агент, затем HTTPS после сертификата)..."
a2enmod ssl proxy proxy_http headers rewrite
a2dissite 000-default.conf 2>/dev/null || true

mkdir -p /var/www/html/.well-known/acme-challenge
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

systemctl enable apache2.service
systemctl restart apache2.service

info "Запуск hy2-agent..."
systemctl daemon-reload
systemctl enable hy2-agent.service
systemctl restart hy2-agent.service

SKIP_LE_CERT=0
if [[ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" && -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]]; then
  info "Сертификат Let's Encrypt для ${DOMAIN} уже есть — certbot пропускаем."
  SKIP_LE_CERT=1
fi

if [[ "$SKIP_LE_CERT" -eq 0 ]]; then
  info "Получение сертификата Let's Encrypt (certbot + Apache)..."
  certbot certonly --apache -d "${DOMAIN}" --non-interactive --agree-tos -m "${ACME_EMAIL}" --no-eff-email \
    || die "certbot не смог получить сертификат (проверьте DNS A→этот сервер и порт 80 снаружи)."
fi

[[ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]] || die "Нет fullchain.pem для ${DOMAIN}"
[[ -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]] || die "Нет privkey.pem для ${DOMAIN}"

info "Копирование сертификатов для Hysteria (UDP 443)..."
cp -L "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${HY2_TLS_DIR}/fullchain.pem"
cp -L "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" "${HY2_TLS_DIR}/privkey.pem"
chown hysteria:hysteria "${HY2_TLS_DIR}/fullchain.pem" "${HY2_TLS_DIR}/privkey.pem" 2>/dev/null || chown root:root "${HY2_TLS_DIR}/"*.pem
chmod 640 "${HY2_TLS_DIR}/fullchain.pem"
chmod 600 "${HY2_TLS_DIR}/privkey.pem"

info "Apache: HTTPS reverse-proxy и редирект с HTTP..."
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

mkdir -p /var/www/html/.well-known/acme-challenge
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
systemctl reload apache2.service

info "Запись /etc/hysteria/config.yaml (TLS из файлов Let's Encrypt, без встроенного ACME)..."
cat > /etc/hysteria/config.yaml <<YAML
listen: :443

tls:
  cert: ${HY2_TLS_DIR}/fullchain.pem
  key: ${HY2_TLS_DIR}/privkey.pem

auth:
  type: userpass
  userpass:
    "${HY2_PLACEHOLDER_TG}": "${PLACEHOLDER_USERPASS}"

masquerade:
  type: proxy
  proxy:
    url: https://news.ycombinator.com
    rewriteHost: true

trafficStats:
  listen: :25413
  secret: ${STATS_SECRET}
YAML

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

info "Запуск hysteria-server..."
systemctl enable hysteria-server.service
systemctl restart hysteria-server.service || warn "hysteria-server не запустился — см. journalctl -u hysteria-server"

PUBLIC_IP="$(curl -fsSL --connect-timeout 10 https://ipinfo.io/ip || true)"
if [[ -z "${PUBLIC_IP:-}" ]]; then
  warn "Не удалось получить публичный IP через ipinfo.io"
  PUBLIC_IP="unknown"
fi

export HY2_REG_NAME="$NODE_NAME"
export HY2_REG_IP="$PUBLIC_IP"
export HY2_REG_DOMAIN="$DOMAIN"
export HY2_REG_PORT="$AGENT_PORT"
export HY2_REG_TOKEN="$AGENT_TOKEN"
REGISTER_PAYLOAD="$(python3 <<'PY'
import json, os
print(json.dumps({
    "name": os.environ["HY2_REG_NAME"],
    "ip": os.environ["HY2_REG_IP"],
    "domain": os.environ["HY2_REG_DOMAIN"],
    "agent_port": int(os.environ.get("HY2_REG_PORT", "4000")),
    "token": os.environ["HY2_REG_TOKEN"],
}))
PY
)"
unset HY2_REG_NAME HY2_REG_IP HY2_REG_DOMAIN HY2_REG_PORT HY2_REG_TOKEN

info "Регистрация ноды на мастере..."
REGISTER_URL="${MASTER_URL%/}/api/hy2/nodes/register"
if curl -fsS -X POST "$REGISTER_URL" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_PAYLOAD" \
  --connect-timeout 10 --max-time 30; then
  echo ""
  success "Запрос регистрации отправлен"
else
  echo ""
  warn "Регистрация на мастере не удалась (мастер недоступен или endpoint ещё не настроен). Добавьте ноду вручную позже."
fi

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
success "Установка завершена"
echo ""
info "Публичный IP:   $PUBLIC_IP"
info "Панель (HTTPS): https://${DOMAIN}/ui"
info "Прямой агент:   http://${PUBLIC_IP}:${AGENT_PORT}/status  (Bearer TOKEN; только для отладки)"
info "Логин панели:   $PANEL_LOGIN"
echo ""
info "HTTPS: Apache (TCP 443) → reverse-proxy на агент; сертификат Let's Encrypt (certbot, автопродление certbot.timer)."
info "Hysteria: UDP 443 (QUIC), те же PEM в ${HY2_TLS_DIR}; продление LE → hook обновляет файлы и reload hysteria-server."
warn "Временный userpass в ${HY2_PLACEHOLDER_TG} — удалите в панели после добавления реальных пользователей (HY2 не принимает пустой userpass)."
echo ""
systemctl --no-pager -l status hysteria-server.service || true
echo ""
systemctl --no-pager -l status hy2-agent.service || true
echo ""
success "Готово."
