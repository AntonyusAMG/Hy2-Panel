#!/usr/bin/env bash
# Проверка синтаксиса UI и agent.py. Для деплоя: VERIFY_ROOT=/opt/hy2-agent ./verify-panel.sh
set -euo pipefail
ROOT="${VERIFY_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
js="${ROOT}/ui/app.js"
py="${ROOT}/agent.py"
code=0

if [[ -f "$js" ]]; then
  NODE_BIN=""
  command -v node >/dev/null 2>&1 && NODE_BIN=node
  [[ -z "$NODE_BIN" ]] && command -v nodejs >/dev/null 2>&1 && NODE_BIN=nodejs
  if [[ -n "$NODE_BIN" ]]; then
    "$NODE_BIN" --check "$js" || code=1
  else
    echo "WARN: нет node/nodejs — установите nodejs для проверки app.js (node --check)."
  fi
else
  echo "WARN: нет файла $js"
fi

if [[ -f "$py" ]]; then
  python3 -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())" "$py" || code=1
else
  echo "WARN: нет файла $py"
fi

exit "$code"
