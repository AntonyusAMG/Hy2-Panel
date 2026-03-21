# HY2 Panel

Панель управления нодами **Hysteria 2** с интеграцией в PHP мастер-сервер: установка одной командой, Node Agent (FastAPI), веб-UI ноды, идентификация пользователей по **Telegram ID**.

## Стек

Ubuntu 24.04 LTS · Bash · Hysteria 2 (официальный установщик) · Python 3.12+ · FastAPI · PHP (мастер-панель)

## Структура репозитория

```
hy2-panel/
├── scripts/              # install.sh, uninstall.sh, update.sh
├── node-agent/           # agent.py, requirements.txt, ui/index.html
└── master-integration/   # sql/, php/ — встраивание в мастер-панель
```

Документация и детальный план — в каталоге проекта разработки (`HY2_Panel_Prompt.md`, `HY2_Panel_Plan.md`).
