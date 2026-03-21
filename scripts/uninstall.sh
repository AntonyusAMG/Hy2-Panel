#!/usr/bin/env bash
# Удаление HY2 агента и конфигурации (Hysteria оставляет опционально)
set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ "${EUID:-0}" -ne 0 ]] && die "Запуск от root: sudo $0"

REMOVE_HYSTERIA="${REMOVE_HYSTERIA:-0}"

echo ""
read -r -p "Остановить и удалить hy2-agent и /opt/hy2-agent? [y/N]: " a
[[ "${a,,}" == "y" || "${a,,}" == "yes" ]] || die "Отменено."

systemctl disable --now hy2-agent.service 2>/dev/null || true
rm -f /etc/systemd/system/hy2-agent.service
systemctl daemon-reload

rm -rf /opt/hy2-agent /var/log/hy2-agent

info "hy2-agent удалён"

if [[ "$REMOVE_HYSTERIA" == "1" ]]; then
  read -r -p "Удалить hysteria-server и /etc/hysteria? [y/N]: " b
  if [[ "${b,,}" == "y" || "${b,,}" == "yes" ]]; then
    systemctl disable --now hysteria-server.service 2>/dev/null || true
    rm -rf /etc/hysteria
    command -v hysteria >/dev/null 2>&1 && warn "Бинарник hysteria остался в PATH — удалите пакет вручную при необходимости"
  fi
else
  warn "Hysteria не трогали. Полное удаление: REMOVE_HYSTERIA=1 sudo -E $0"
fi

info "Правила UFW не удаляются автоматически — проверьте: ufw status numbered"
