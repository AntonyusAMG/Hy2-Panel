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

## Локальная установка ноды (без GitHub)

Из корня репозитория `hy2-panel`:

```bash
sudo bash ./scripts/install.sh "https://ВАШ_МАСТЕР" "$(openssl rand -hex 32)" "ИМЯ_НОДЫ" "vpn.ваш-домен.ru"
```

Скрипт спросит **email для ACME** (Let's Encrypt / ZeroSSL). Можно задать заранее: `export ACME_EMAIL=you@mail.com`. По умолчанию `ACME_CA=letsencrypt`.

**Сертификаты:** Hysteria 2 получает и **автоматически продлевает** TLS через встроенный ACME (`acme` в `config.yaml`). Отдельная установка **certbot** не требуется и обычно не нужна.

**Userpass:** в конфиге создаётся временный пользователь `999999999` со случайным паролем (HY2 2.7+ не принимает пустой `userpass: {}`). Удалите его в панели после добавления реальных `telegram_id`.

Файлы `agent.py`, `requirements.txt` и `ui/` копируются из каталога `node-agent/` рядом со скриптом. Для неинтерактивного ввода логина/пароля панели:

```bash
export HY2_PANEL_LOGIN=admin
export HY2_PANEL_PASSWORD='ваш_пароль_8+'
echo y | sudo -E bash ./scripts/install.sh ...
```

## Обновление

```bash
sudo bash ./scripts/update.sh
```
