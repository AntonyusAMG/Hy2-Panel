#!/usr/bin/env bash
# Сравнивает node-agent в репозитории с /opt/hy2-agent; при отличиях копирует файлы
# и перезапускает hy2-agent (без обновления Hysteria через get.hy2.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_AGENT_SRC="${REPO_ROOT}/node-agent"
OPT="/opt/hy2-agent"

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
[[ -d "${OPT}/venv" ]] || die "Нет ${OPT}/venv — сначала install.sh"

FILES=(
  "agent.py:${OPT}/agent.py"
  "requirements.txt:${OPT}/requirements.txt"
  "hy2-agent.service:/etc/systemd/system/hy2-agent.service"
  "ui/app.js:${OPT}/ui/app.js"
  "ui/index.html:${OPT}/ui/index.html"
  "ui/style.css:${OPT}/ui/style.css"
)

need=0
for pair in "${FILES[@]}"; do
  rel="${pair%%:*}"
  dest="${pair#*:}"
  src="${NODE_AGENT_SRC}/${rel}"
  [[ -f "$src" ]] || die "Нет файла: $src"
  if ! cmp -s "$src" "$dest" 2>/dev/null; then
    need=1
    info "Изменён: $rel"
  fi
done

if [[ "$need" -eq 0 ]]; then
  success "Обновление не требуется: /opt/hy2-agent совпадает с репозиторием."
  exit 0
fi

info "Установка pip-зависимостей..."
"${OPT}/venv/bin/pip" install -r "${NODE_AGENT_SRC}/requirements.txt" -q

info "Копирование в ${OPT}..."
cp -f "${NODE_AGENT_SRC}/agent.py" "${OPT}/agent.py"
cp -f "${NODE_AGENT_SRC}/requirements.txt" "${OPT}/requirements.txt"
cp -f "${NODE_AGENT_SRC}/ui/index.html" "${OPT}/ui/index.html"
cp -f "${NODE_AGENT_SRC}/ui/style.css" "${OPT}/ui/style.css"
cp -f "${NODE_AGENT_SRC}/ui/app.js" "${OPT}/ui/app.js"
chmod 644 "${OPT}/ui/"*

cp -f "${NODE_AGENT_SRC}/hy2-agent.service" /etc/systemd/system/hy2-agent.service
systemctl daemon-reload
systemctl restart hy2-agent.service
success "hy2-agent перезапущен (были отличия от репозитория)."
exit 0
