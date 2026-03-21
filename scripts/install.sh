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

port_443_free() {
  if command -v ss >/dev/null 2>&1; then
    if ss -H -lnp 2>/dev/null | grep -qE ':443(\s|$)'; then
      die "Порт 443 уже занят. Остановите сервис, слушающий 443, или смените конфигурацию."
    fi
  elif command -v netstat >/dev/null 2>&1; then
    if netstat -tulnp 2>/dev/null | grep -qE ':443\s'; then
      die "Порт 443 уже занят."
    fi
  fi
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

port_443_free

info "Обновление списка пакетов..."
apt-get update -qq

info "Обновление установленных пакетов (может занять время)..."
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

info "Установка зависимостей..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3 python3-pip python3-venv ufw git openssl

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
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"

info "Создание каталогов..."
mkdir -p /etc/hysteria /opt/hy2-agent/ui /var/log/hy2-agent

info "Запись /etc/hysteria/config.yaml..."
cat > /etc/hysteria/config.yaml <<YAML
listen: :443

acme:
  domains:
    - ${DOMAIN}
  email: ${ACME_EMAIL}

auth:
  type: userpass
  userpass: {}

masquerade:
  type: proxy
  proxy:
    url: https://news.ycombinator.com
    rewriteHost: true

trafficStats:
  listen: :25413
  secret: ${STATS_SECRET}
YAML

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

info "Запись /opt/hy2-agent/config.json..."
/opt/hy2-agent/venv/bin/python3 <<'PY'
import json, os
cfg = {
    "node_name": os.environ["HY2_CFG_NODE_NAME"],
    "master_url": os.environ["HY2_CFG_MASTER_URL"],
    "token": os.environ["HY2_CFG_TOKEN"],
    "agent_port": int(os.environ.get("HY2_CFG_AGENT_PORT", "4000")),
    "hysteria_config": "/etc/hysteria/config.yaml",
    "hysteria_service": "hysteria-server",
    "stats_secret": os.environ["HY2_CFG_STATS_SECRET"],
    "login": os.environ["HY2_CFG_LOGIN"],
    "password_hash": os.environ["HY2_CFG_PASSWORD_HASH"],
    "jwt_secret": os.environ["HY2_CFG_JWT_SECRET"],
}
with open("/opt/hy2-agent/config.json", "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY

unset HY2_CFG_NODE_NAME HY2_CFG_MASTER_URL HY2_CFG_TOKEN HY2_CFG_AGENT_PORT HY2_CFG_STATS_SECRET HY2_CFG_LOGIN HY2_CFG_PASSWORD_HASH HY2_CFG_JWT_SECRET

info "Установка systemd: hy2-agent.service..."
cp -f "$NODE_AGENT_SRC/hy2-agent.service" /etc/systemd/system/hy2-agent.service
# Порт из переменной (по умолчанию 4000)
sed -i "s/--port 4000/--port ${AGENT_PORT}/g" /etc/systemd/system/hy2-agent.service

info "Настройка UFW..."
ufw allow 22/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow "${AGENT_PORT}"/tcp
ufw --force enable

info "Запуск сервисов..."
systemctl daemon-reload
systemctl enable hysteria-server.service
systemctl enable hy2-agent.service
systemctl restart hysteria-server.service || warn "hysteria-server не запустился (часто DNS/ACME — проверьте домен и логи)"
systemctl restart hy2-agent.service

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
info "Агент:          http://${PUBLIC_IP}:${AGENT_PORT}/status  (Bearer TOKEN)"
info "Веб-панель UI:  http://${PUBLIC_IP}:${AGENT_PORT}/ui"
info "Логин панели:   $PANEL_LOGIN"
echo ""
systemctl --no-pager -l status hysteria-server.service || true
echo ""
systemctl --no-pager -l status hy2-agent.service || true
echo ""
success "Готово."
