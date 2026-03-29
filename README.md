# ⚡ Hy2-Panel: High-Performance Hysteria 2 Management

Профессиональное решение для управления нодами **Hysteria 2** на базе **FastAPI**. Система включает в себя интеллектуальный агент управления, современный веб-интерфейс с поддержкой тем и полностью автоматизированные скрипты развертывания для Ubuntu 24.04.

[![Python](https://img.shields.io/badge/Python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Modern-green.svg)](https://fastapi.tiangolo.com/)
[![Ubuntu](https://img.shields.io/badge/OS-Ubuntu_24.04_LTS-orange.svg)](https://ubuntu.com/)

---

## 🚀 Ключевые возможности

### 🛡️ Безопасность (Security First)
- **Anti-Brute Force**: Встроенный лимитер попыток входа (Rate Limiting) на уровне API.
- **JWT & Bearer Auth**: Полноценная авторизация для доступа к управлению нодой.
- **Secret Validation**: Автоматическая проверка надежности ключей шифрования при запуске.
- **Secure Subscriptions**: Ссылки подписки защищены хешированными ключами, производными от основного секрета, что исключает их утечку.

### 📊 Умный учет трафика (Persistence)
- **Traffic Persistence**: Агент сохраняет статистику пользователей в локальную БД (`traffic_counters.json`).
- **Seamless Merge**: При перезагрузке сервера или обновлении Hysteria данные «склеиваются», предотвращая обнуление счетчиков трафика.

### 📱 Интеграция с клиентами
- **HAPP Support**: Полная поддержка метаданных HAPP (иконки стран, лимиты трафика, даты истечения).
- **Auto-Config**: Генерация `hysteria2://` ссылок на лету с корректным SNI и портами.

### 🎨 Современный Web UI
- **Многотемность**: Темы Telegram Dark, CRM Soft, Light и Violet.
- **Реальное время**: Мониторинг нагрузки CPU, RAM и сетевой активности (BPS) через API агента.

---

## 🏗️ Архитектура

```text
hy2-panel/
├── node-agent/         # Backend: FastAPI Агент
│   ├── agent.py        # Ядро управления и API
│   ├── ui/             # Frontend Dashboard (HTML/JS/CSS)
│   └── data/           # Постоянное хранилище трафика
├── scripts/            # Infrastructure-as-a-Code
│   ├── install.sh      # Полная авто-установка (Apache + SSL + HY2)
│   ├── update.sh       # Бесшовное обновление
│   └── uninstall.sh    # Чистая деинсталляция
└── master-integration/ # Модули для связи с центральной панелью
```

---

## 🛠️ Быстрый старт (Deployment)

### 1. Установка ноды
Для развертывания на чистой **Ubuntu 24.04** выполните одну команду в корне репозитория:

```bash
sudo bash ./scripts/install.sh "https://ВАШ_МАСТЕР" "ВАШ_TOKEN" "ИМЯ_НОДЫ" "vpn.example.com"
```

**Что сделает скрипт:**
1. Установит **Apache 2** в режиме Reverse Proxy.
2. Получит SSL-сертификат **Let's Encrypt** и настроит автопродление.
3. Развернет **Hysteria 2** и настроит её на UDP:443 (QUIC) с использованием тех же сертификатов.
4. Создаст изолированное **Python venv**, скопирует **весь каталог** `node-agent/ui` в `/opt/hy2-agent/ui/` (в т.ч. `style.css`, `app.js`) и запустит Агента как `systemd` сервис.
5. Настроит фаервол **UFW**.

### 2. Параметры настройки
Вы можете передать переменные перед запуском для автоматизации:
- `ACME_EMAIL`: для уведомлений Let's Encrypt.
- `HY2_PANEL_LOGIN / HY2_PANEL_PASSWORD`: учетные данные для веб-интерфейса ноды.

---

## 🔄 Обновление и обслуживание

Обновление агента и самого бинарного файла Hysteria 2 до актуальных версий:
```bash
sudo bash ./scripts/update.sh
```

Только панель (без `get.hy2.sh` и без перезапуска hysteria-server):
```bash
sudo bash ./scripts/update.sh --agent-only
```

Если на сервере уже совпадает с `node-agent/` в репо — ничего не делает; иначе копирует и перезапускает `hy2-agent`:
```bash
sudo bash ./scripts/update-agent-if-needed.sh
```



### Панель открывается без стилей / 404 на `/ui/style.css`
Убедитесь, что в `/opt/hy2-agent/ui/` есть **все** файлы из `node-agent/ui/` репозитория. В старых установках копировался только `index.html` — выполните:
`cp -a ./node-agent/ui/. /opt/hy2-agent/ui/` и `systemctl restart hy2-agent`, либо `sudo bash ./scripts/update.sh --agent-only`.

### Просмотр логов
- Агент: `journalctl -u hy2-agent -f`
- Hysteria: `journalctl -u hysteria-server -f`

---

## ⚙️ Конфигурация (`/opt/hy2-agent/config.json`)
Файл конфигурации агента создается автоматически, но может быть отредактирован вручную:
- `token`: Bearer-токен для связи с мастером.
- `jwt_secret`: Секрет для подписи сессий браузера.
- `traffic_persist`: `true/false` — включение/отключение сохранения трафика на диск.
- `happ`: Настройки отображения в приложении HAPP (флаги, названия стран).

---

## 🤝 Контакты и поддержка
Разработано для обеспечения максимальной приватности и скорости доступа. По вопросам интеграции обращайтесь в [Telegram-бот](https://t.me/privatevpnest_bot).

*Лицензия MIT. Используйте на свой страх и риск.*
