#!/usr/bin/env bash
# Обновление Hysteria 2 (get.hy2.sh) и файлов агента из локального репозитория
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
die() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ "${EUID:-0}" -ne 0 ]] && die "Запуск от root: sudo $0"
[[ -d "$NODE_AGENT_SRC" ]] || die "Не найден ${NODE_AGENT_SRC}"

info "Обновление Hysteria 2 через get.hy2.sh..."
bash <(curl -fsSL https://get.hy2.sh/)

if [[ -d /opt/hy2-agent/venv ]]; then
  info "Обновление pip-зависимостей агента..."
  /opt/hy2-agent/venv/bin/pip install -r "$NODE_AGENT_SRC/requirements.txt" -q
  info "Копирование agent.py и ui..."
  cp -f "$NODE_AGENT_SRC/agent.py" /opt/hy2-agent/agent.py
  [[ -f "$NODE_AGENT_SRC/ui/index.html" ]] && cp -f "$NODE_AGENT_SRC/ui/index.html" /opt/hy2-agent/ui/index.html
  cp -f "$NODE_AGENT_SRC/hy2-agent.service" /etc/systemd/system/hy2-agent.service
  systemctl daemon-reload
  systemctl restart hy2-agent.service
  success "hy2-agent перезапущен"
else
  warn "Нет /opt/hy2-agent/venv — сначала выполните install.sh"
fi

systemctl restart hysteria-server.service || warn "hysteria-server не перезапустился — см. journalctl -u hysteria-server"
success "Готово."
