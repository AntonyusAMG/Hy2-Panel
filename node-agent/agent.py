"""
HY2 Node Agent — FastAPI. Конфиг: /opt/hy2-agent/config.json (путь можно переопределить переменной HY2_AGENT_CONFIG).

Накопительный трафик (ответ GET /traffic для панели и HAPP): по умолчанию пишется в data/traffic_counters.json
рядом с agent.py (или в traffic_persist_path). Переживает перезапуск Hysteria и сервера. Отключить: "traffic_persist": false.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from html import escape as html_escape
from urllib.parse import quote, urlparse
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import psutil
import yaml
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field

CONFIG_PATH = Path(os.environ.get("HY2_AGENT_CONFIG", "/opt/hy2-agent/config.json"))
# Публичная заглушка: кнопка Telegram, если в config не задан landing_telegram_bot
LANDING_TELEGRAM_DEFAULT = "https://t.me/privatevpnest_bot"

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
app = FastAPI(title="HY2 Node Agent", docs_url=None, redoc_url=None, openapi_url=None)
_traffic_merge_lock = asyncio.Lock()
_login_lock = asyncio.Lock()
_login_rate_limit: dict[str, list[float]] = {}

_config: dict[str, Any] = {}
_ui_path: Path = Path(__file__).resolve().parent / "ui" / "index.html"


def load_config() -> None:
    global _config, _ui_path
    if not CONFIG_PATH.is_file():
        raise RuntimeError(f"Config not found: {CONFIG_PATH}")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        _config = json.load(f)

    # Валидация безопасности секретов
    for k in ("token", "jwt_secret"):
        if len(str(_config.get(k, ""))) < 32:
            print(f"SECURITY WARNING: '{k}' is too short/weak in config! Please use at least 32 chars.")

    base = Path(__file__).resolve().parent
    _ui_path = base / "ui" / "index.html"


@app.on_event("startup")
async def startup() -> None:
    load_config()


def _agent_token() -> str:
    return str(_config.get("token", ""))


def _jwt_secret() -> str:
    return str(_config.get("jwt_secret", ""))


def _stats_secret() -> str:
    return str(_config.get("stats_secret", ""))


def _hysteria_config_path() -> Path:
    return Path(os.environ.get("HYSTERIA_CONFIG", _config.get("hysteria_config", "/etc/hysteria/config.yaml")))


def _hysteria_service() -> str:
    return str(_config.get("hysteria_service", "hysteria-server"))


# Имя cookie совпадает с JWT_KEY в node-agent/ui/app.js
_UI_JWT_COOKIE = "hy2_jwt"


def _client_https(request: Request) -> bool:
    """За Apache SSL терминатором смотрим X-Forwarded-Proto."""
    xf = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if xf == "https":
        return True
    return request.url.scheme == "https"


def _raw_token_candidates(request: Request, authorization: str | None) -> list[str]:
    """Сначала Bearer (часто из localStorage), затем cookie. Оба могут отличаться — пробуем по очереди."""
    seen: set[str] = set()
    out: list[str] = []
    if authorization:
        auth = authorization.strip()
        if auth[:7].lower() == "bearer ":
            t = auth[7:].strip()
            if t and t not in seen:
                seen.add(t)
                out.append(t)
    c = (request.cookies.get(_UI_JWT_COOKIE) or "").strip()
    if c and c not in seen:
        seen.add(c)
        out.append(c)
    return out


def _verify_from_request(request: Request, authorization: str | None) -> dict[str, Any]:
    candidates = _raw_token_candidates(request, authorization)
    if not candidates:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    last: HTTPException | None = None
    for raw in candidates:
        try:
            return _auth_from_raw_token(raw)
        except HTTPException as e:
            if e.status_code == 401:
                last = e
                continue
            raise
    raise last if last else HTTPException(status_code=401, detail="Invalid or expired token")


def _auth_from_raw_token(raw: str) -> dict[str, Any]:
    token = _agent_token()
    if token and len(token) >= 32 and raw == token:
        return {"kind": "agent"}
    try:
        payload = jwt.decode(raw, _jwt_secret(), algorithms=["HS256"])
        return {"kind": "jwt", "sub": payload.get("sub")}
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from None


async def verify_bearer(
    request: Request,
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    return _verify_from_request(request, authorization)


async def verify_sub_key_or_jwt(
    request: Request,
    k: str | None = Query(None, description="happ_subscription_key из config.json"),
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    """Подписка HAPP: доступ по ?k= (тот же ключ, что в ссылке из панели) или Bearer JWT."""
    kq = (k or "").strip()
    expected = _happ_subscription_key()
    if expected and kq == expected:
        return {"kind": "subkey"}
    return _verify_from_request(request, authorization)


class LoginBody(BaseModel):
    login: str
    password: str


class UserCreate(BaseModel):
    telegram_id: str = Field(..., description="Telegram chat_id как строка цифр")
    password: str


class ConfigPut(BaseModel):
    content: str


TG_ID_RE = re.compile(r"^\d{1,32}$")


def _validate_tg_id(tid: str) -> str:
    tid = (tid or "").strip()
    if not TG_ID_RE.match(tid):
        raise HTTPException(status_code=400, detail="telegram_id must be a numeric string")
    return tid


def _read_hysteria_yaml() -> dict[str, Any]:
    path = _hysteria_config_path()
    if not path.is_file():
        raise HTTPException(status_code=500, detail=f"Hysteria config missing: {path}")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _write_hysteria_yaml(data: dict[str, Any]) -> None:
    path = _hysteria_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)


def _restart_hysteria() -> None:
    subprocess.run(
        ["systemctl", "restart", _hysteria_service()],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )


def _stats_authorization_headers() -> dict[str, str]:
    """Hysteria 2 Traffic Stats API: заголовок `Authorization: <secret>` без префикса Bearer."""
    sec = str(_stats_secret() or "").strip()
    if not sec:
        return {}
    return {"Authorization": sec}


async def _stats_request(method: str, url_path: str, content: bytes | None = None) -> Any:
    base = "http://127.0.0.1:25413"
    headers = _stats_authorization_headers()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.request(method, f"{base}{url_path}", headers=headers, content=content)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=503, detail=f"Stats API unreachable: {e}") from e
    # Некоторые сборки могут ожидать Bearer — повторяем запрос
    if r.status_code == 401 and headers:
        sec = str(_stats_secret() or "").strip()
        if sec:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    r = await client.request(
                        method,
                        f"{base}{url_path}",
                        headers={"Authorization": f"Bearer {sec}"},
                        content=content,
                    )
            except httpx.HTTPError as e:
                raise HTTPException(status_code=503, detail=f"Stats API unreachable: {e}") from e
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Stats API error: {r.status_code} {r.text[:200]}")
    if not r.content:
        return {}
    try:
        return r.json()
    except Exception:
        return {"raw": r.text}


# --- Накопительный трафик на диске (переживает перезапуск HY2 / сервера) ---


def _traffic_persist_enabled() -> bool:
    return _config.get("traffic_persist", True) is not False


def _traffic_persist_path() -> Path:
    p = _config.get("traffic_persist_path")
    if p:
        return Path(str(p)).expanduser()
    return Path(__file__).resolve().parent / "data" / "traffic_counters.json"


def _read_traffic_state() -> dict[str, Any]:
    path = _traffic_persist_path()
    if not path.is_file():
        return {"version": 1, "users": {}}
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {"version": 1, "users": {}}
        u = d.get("users")
        if not isinstance(u, dict):
            d["users"] = {}
        d.setdefault("version", 1)
        return d
    except Exception:
        return {"version": 1, "users": {}}


def _write_traffic_state(d: dict[str, Any]) -> None:
    path = _traffic_persist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _pairs_from_traffic_val(v: Any) -> tuple[int, int]:
    if not isinstance(v, dict):
        return 0, 0
    up = v.get("tx") if v.get("tx") is not None else v.get("upload")
    down = v.get("rx") if v.get("rx") is not None else v.get("download")
    try:
        return max(0, int(up or 0)), max(0, int(down or 0))
    except (TypeError, ValueError):
        return 0, 0


def _extract_traffic_users(raw: Any) -> tuple[dict[str, dict[str, Any]] | None, str]:
    """Выделяет карту user_id → объект счётчиков из ответа HY2. Режим: users_key | flat | none."""
    if not isinstance(raw, dict):
        return None, "none"
    if "users" in raw and isinstance(raw["users"], dict) and not isinstance(raw["users"], list):
        return raw["users"], "users_key"
    skip = frozenset({"online", "data", "users", "meta", "server", "system", "version"})
    out: dict[str, dict[str, Any]] = {}
    for k, v in raw.items():
        if k in skip:
            continue
        if isinstance(v, dict):
            up, down = _pairs_from_traffic_val(v)
            if up or down or any(x in v for x in ("tx", "rx", "upload", "download")):
                out[str(k)] = v
    if out:
        return out, "flat"
    return None, "none"


def _merge_traffic_persist_sync(raw: Any) -> Any:
    """
    Для каждого пользователя: total = base + текущий HY2.
    Если tx/rx от HY2 уменьшились (рестарт) — прошлая «сессия» добавляется в base.
    """
    if not _traffic_persist_enabled():
        return raw
    state = _read_traffic_state()
    users_state: dict[str, Any] = state.setdefault("users", {})
    extracted, mode = _extract_traffic_users(raw)
    if extracted is None or mode == "none":
        return raw

    merged_users: dict[str, dict[str, Any]] = {}
    all_ids = set(extracted.keys()) | set(users_state.keys())

    for uid in sorted(all_ids):
        st = users_state.get(uid)
        if not isinstance(st, dict):
            st = {}
        base_up = int(st.get("base_up") or 0)
        base_down = int(st.get("base_down") or 0)
        last_up = int(st.get("last_up") or 0)
        last_down = int(st.get("last_down") or 0)

        if uid in extracted:
            cur_up, cur_down = _pairs_from_traffic_val(extracted[uid])
            if cur_up < last_up:
                base_up += last_up
            if cur_down < last_down:
                base_down += last_down
            last_up = cur_up
            last_down = cur_down
            total_up = base_up + cur_up
            total_down = base_down + cur_down
        else:
            total_up = base_up
            total_down = base_down

        users_state[uid] = {
            "base_up": base_up,
            "base_down": base_down,
            "last_up": last_up,
            "last_down": last_down,
        }

        orig = extracted.get(uid) if uid in extracted else None
        if isinstance(orig, dict):
            merged_val = dict(orig)
            if "tx" in merged_val or "rx" in merged_val:
                merged_val["tx"] = total_up
                merged_val["rx"] = total_down
            if "upload" in merged_val or "download" in merged_val:
                merged_val["upload"] = total_up
                merged_val["download"] = total_down
            if "tx" not in merged_val and "rx" not in merged_val and "upload" not in merged_val and "download" not in merged_val:
                merged_val["tx"] = total_up
                merged_val["rx"] = total_down
        else:
            merged_val = {"tx": total_up, "rx": total_down}
        merged_users[uid] = merged_val

    _write_traffic_state(state)

    if mode == "users_key":
        out = {k: v for k, v in raw.items() if k != "users"}
        out["users"] = merged_users
        return out
    out = dict(raw)
    for uid, mv in merged_users.items():
        out[uid] = mv
    return out


async def _traffic_with_persistence() -> Any:
    if not _traffic_persist_enabled():
        return await _stats_request("GET", "/traffic")
    async with _traffic_merge_lock:
        raw = await _stats_request("GET", "/traffic")
        return await asyncio.to_thread(_merge_traffic_persist_sync, raw)


def _traffic_persist_remove_user(tid: str) -> None:
    state = _read_traffic_state()
    u = state.get("users")
    if isinstance(u, dict) and tid in u:
        del u[tid]
        _write_traffic_state(state)


def _traffic_persist_clear_user(tid: str) -> None:
    """Сброс накопленного для пользователя (после reset в HY2)."""
    state = _read_traffic_state()
    u = state.setdefault("users", {})
    u[tid] = {"base_up": 0, "base_down": 0, "last_up": 0, "last_down": 0}
    _write_traffic_state(state)


def _systemctl_is_active(unit: str) -> str:
    return subprocess.run(
        ["systemctl", "is-active", unit],
        capture_output=True,
        text=True,
    ).stdout.strip()


_net_io_last: tuple[float, int, int] | None = None


def _net_io_snapshot() -> dict[str, Any]:
    """Суммарный трафик интерфейсов и мгновенная скорость (по дельте между запросами /status)."""
    global _net_io_last
    now = time.time()
    try:
        c = psutil.net_io_counters()
    except Exception:
        return {}
    sent = int(c.bytes_sent)
    recv = int(c.bytes_recv)
    out: dict[str, Any] = {
        "bytes_sent_total": sent,
        "bytes_recv_total": recv,
        "net_speed_up_bps": 0.0,
        "net_speed_down_bps": 0.0,
    }
    if _net_io_last is not None:
        t0, s0, r0 = _net_io_last
        dt = now - t0
        if dt > 0.05:
            out["net_speed_up_bps"] = max(0.0, (sent - s0) / dt)
            out["net_speed_down_bps"] = max(0.0, (recv - r0) / dt)
    _net_io_last = (now, sent, recv)
    return out


_HY_VER_RE = re.compile(
    r"v?\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?",
)


def _line_is_hysteria_banner(s: str) -> bool:
    """Новые сборки hysteria печатают ASCII/Unicode-арт в начале вывода version."""
    n = len(s)
    if n < 10:
        return False
    blocky = 0
    for c in s:
        o = ord(c)
        if 0x2580 <= o <= 0x259F or c in "█░▒▓▄▀":
            blocky += 1
    return blocky >= max(8, n // 4)


def _hysteria_version_line() -> str:
    try:
        p = subprocess.run(
            ["hysteria", "version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        text = (p.stdout or p.stderr or "").strip()
        if not text:
            return "unknown"
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if not lines:
            return "unknown"
        for ln in lines:
            m = re.search(r"(?i)version\s*:\s*(.+)", ln)
            if m:
                tail = m.group(1).strip()
                vm = _HY_VER_RE.search(tail)
                return (vm.group(0) if vm else tail)[:120]
        for ln in lines:
            if _line_is_hysteria_banner(ln):
                continue
            vm = _HY_VER_RE.search(ln)
            if vm:
                return vm.group(0)[:120]
            if len(ln) < 64:
                return ln[:120]
        for ln in lines:
            vm = _HY_VER_RE.search(ln)
            if vm:
                return vm.group(0)[:120]
        for ln in lines:
            if not _line_is_hysteria_banner(ln):
                return ln[:120]
        return "unknown"
    except Exception:
        return "unknown"


@app.get("/status")
async def status(_: dict = Depends(verify_bearer)) -> dict[str, Any]:
    hysteria_active = _systemctl_is_active(_hysteria_service())
    hy2_agent_active = _systemctl_is_active("hy2-agent")
    boot = psutil.boot_time()
    uptime_s = int(time.time() - boot)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    sw = psutil.swap_memory()
    load_avg: list[float] = []
    try:
        load_avg = [round(float(x), 2) for x in os.getloadavg()]
    except OSError:
        pass
    pb = str(_config.get("public_base_url") or "").strip().rstrip("/")
    resolved_domain = ""
    hy_yaml = {}
    try:
        hy_yaml = _read_hysteria_yaml()
        resolved_domain = _hysteria_public_domain(hy_yaml)
    except Exception:
        pass

    masq = hy_yaml.get("masquerade", {})
    acme = hy_yaml.get("acme", {})
    tls = hy_yaml.get("tls", {})

    payload: dict[str, Any] = {
        "node_name": str(_config.get("node_name", "")),
        "panel_public_url": pb,
        "hysteria_client_domain": resolved_domain,
        "hysteria_service": _hysteria_service(),
        "hysteria_active": hysteria_active,
        "hysteria_version": _hysteria_version_line(),
        "hy2_agent_active": hy2_agent_active,

        "tls_active": bool(acme or tls),
        "tls_mode": "Auto (ACME)" if acme else ("Manual" if tls else "None"),
        "masquerade_enabled": bool(masq),
        "masquerade_type": masq.get("type", "None") if masq else "None",
        "stats_secret_configured": bool(_config.get("stats_secret")),

        "cpu_percent": psutil.cpu_percent(interval=None),
        "cpu_count": psutil.cpu_count(logical=True) or 0,
        "load_average": load_avg,
        "memory": {
            "total": vm.total,
            "used": vm.used,
            "percent": vm.percent,
        },
        "swap": {
            "total": int(sw.total),
            "used": int(sw.used),
            "percent": float(sw.percent),
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "percent": disk.percent,
        },
        "uptime_seconds": uptime_s,
    }
    payload.update(_net_io_snapshot())
    return payload


@app.get("/users")
async def list_users(_: dict = Depends(verify_bearer)) -> dict[str, Any]:
    y = _read_hysteria_yaml()
    auth = y.get("auth") or {}
    if auth.get("type") != "userpass":
        return {"users": [], "note": "auth.type is not userpass"}
    up = auth.get("userpass") or {}
    if isinstance(up, dict):
        users = list(up.keys())
    else:
        users = []
    return {"users": users}


def _host_from_url(s: str) -> str:
    """Домен из https://host/path или host:port."""
    s = (s or "").strip()
    if not s:
        return ""
    u = s if "://" in s else f"https://{s}"
    h = urlparse(u).hostname
    return (h or "").strip()


def _domain_from_le_cert_path(y: dict[str, Any]) -> str:
    """Домен из пути cert Let's Encrypt: .../live/example.com/fullchain.pem."""
    tls = y.get("tls")
    if not isinstance(tls, dict):
        return ""
    cert = str(tls.get("cert") or "").strip().replace("\\", "/")
    if not cert:
        return ""
    m = re.search(r"/live/([^/]+)/", cert)
    return m.group(1).strip() if m else ""


def _hysteria_listen_port(y: dict[str, Any]) -> int:
    listen = y.get("listen", ":443")
    if isinstance(listen, (int, float)):
        return int(listen)
    s = str(listen).strip()
    if not s:
        return 443
    if ":" in s:
        tail = s.rsplit(":", 1)[-1].rstrip("]")
        try:
            return int(tail)
        except ValueError:
            pass
    return 443


def _hysteria_public_domain(y: dict[str, Any]) -> str:
    """Домен для hysteria2:// (SNI). Сначала config агента и LE-путь cert — не masquerade (там часто чужой URL)."""
    agent_dom = str(_config.get("hysteria_public_domain") or "").strip()
    if agent_dom:
        return agent_dom
    pb = str(_config.get("public_base_url") or "").strip().rstrip("/")
    if pb:
        host = _host_from_url(pb)
        if host:
            return host
    acme = y.get("acme") or {}
    doms = acme.get("domains")
    if isinstance(doms, list) and doms:
        d = str(doms[0]).strip()
        if d:
            return d
    for key in ("public_domain", "server_name", "sni"):
        v = (y.get(key) or "").strip()
        if v:
            return v
    tls = y.get("tls")
    if isinstance(tls, dict):
        for key in ("sni", "server_name", "domain"):
            v = (tls.get(key) or "").strip()
            if v:
                return v
    d = _domain_from_le_cert_path(y)
    if d:
        return d
    return ""


def _happ_cfg() -> dict[str, Any]:
    h = _config.get("happ")
    return h if isinstance(h, dict) else {}


# Префикс по ISO-коду, если в конфиге не заданы country_flag / country_name
_HAPP_COUNTRY_PRESETS: dict[str, tuple[str, str]] = {
    "NL": ("🇳🇱", "Netherlands"),
    "DE": ("🇩🇪", "Germany"),
    "FI": ("🇫🇮", "Finland"),
    "US": ("🇺🇸", "United States"),
    "GB": ("🇬🇧", "United Kingdom"),
    "SG": ("🇸🇬", "Singapore"),
    "TH": ("🇹🇭", "Thailand"),
    "VN": ("🇻🇳", "Vietnam"),
    "RU": ("🇷🇺", "Russia"),
    "UA": ("🇺🇦", "Ukraine"),
    "PL": ("🇵🇱", "Poland"),
    "FR": ("🇫🇷", "France"),
    "ES": ("🇪🇸", "Spain"),
    "TR": ("🇹🇷", "Turkey"),
    "IS": ("🇮🇸", "Iceland"),
    "CA": ("🇨🇦", "Canada"),
}


def _happ_country_flag_name(hc: dict[str, Any]) -> tuple[str, str]:
    """Флаг и полное имя страны для отображения в HAPP (fragment после #)."""
    flag = (hc.get("country_flag") or hc.get("flag") or "").strip()
    name = (hc.get("country_name") or hc.get("country_full") or "").strip()
    if flag and name:
        return flag, name
    cc = (hc.get("country_code") or "").strip().upper()
    if cc and cc in _HAPP_COUNTRY_PRESETS:
        pf, pn = _HAPP_COUNTRY_PRESETS[cc]
        return (flag or pf), (name or pn)
    return flag, name


def _happ_fragment_for_client(tid: str, node_name: str, hc: dict[str, Any]) -> str:
    """Текст после # в hysteria2:// — строка сервера: «🇳🇱 Страна - ID» (как карточка в HAPP), без бренда в названии."""
    flag, cname = _happ_country_flag_name(hc)
    region = (hc.get("region_label") or hc.get("country") or "").strip()
    if flag and cname:
        return f"{flag} {cname} - {tid}"
    if cname:
        return f"{cname} - {tid}"
    if region:
        return f"{region} - {tid}"
    return f"{node_name} - {tid}"


def _happ_subscription_key() -> str:
    """Ключ ?k= для /sub/…. Явный happ_subscription_key или стабильный производный от jwt_secret."""
    k = str(_config.get("happ_subscription_key") or "").strip()
    if k:
        return k
    js = str(_config.get("jwt_secret") or "")
    if len(js) < 8:
        return ""
    return hashlib.sha256((js + "|hy2-happ-subscription-v1").encode("utf-8")).hexdigest()


def _public_base_url(request: Request) -> str:
    """Ссылка для клиента: public_base_url в config или X-Forwarded-* за reverse-proxy."""
    pb = str(_config.get("public_base_url") or "").strip().rstrip("/")
    if pb:
        return pb
    xf = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    xhost = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if xf and xhost:
        return f"{xf}://{xhost}"
    return str(request.base_url).rstrip("/")


def _landing_urls(request: Request) -> tuple[str, str, str]:
    """(резерв: ссылка /ui для служебных целей, сайт, Telegram)."""
    panel = _public_base_url(request).rstrip("/") + "/ui"
    home = str(_config.get("landing_home_url") or "https://xtinder.ru").strip() or "https://xtinder.ru"
    tg = str(_config.get("landing_telegram_bot") or "").strip() or LANDING_TELEGRAM_DEFAULT
    return panel, home, tg


def _landing_html(request: Request, *, not_found: bool) -> str:
    """Публичная страница: сайт и Telegram (без ссылки на панель)."""
    _panel, home, tg = _landing_urls(request)
    node = html_escape(str(_config.get("node_name") or "HY2 Node"))
    hint = ""
    if not_found:
        hint = (
            '<p class="hint warn">Страница по этому адресу не найдена. '
            "Проверьте URL или настройки прокси. Панель ноды доступна только по служебному адресу для администраторов.</p>"
        )
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{node} — доступ</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {{
      --bg: #0e1621;
      --card: #17212b;
      --border: rgba(255,255,255,0.08);
      --txt: #e4edf5;
      --muted: #8f9aad;
      --accent: #5288c1;
      --accent2: #6ab3f3;
      --green: #5dc992;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100dvh;
      font-family: "Plus Jakarta Sans", system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 20% -10%, rgba(82,136,193,0.18), transparent 55%),
        radial-gradient(900px 500px at 100% 30%, rgba(93,201,146,0.08), transparent 50%),
        var(--bg);
      color: var(--txt);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }}
    .card {{
      width: 100%;
      max-width: 420px;
      background: linear-gradient(165deg, color-mix(in srgb, var(--card) 100%, transparent), #1a2430);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 28px 26px 26px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04) inset;
    }}
    .logo {{
      font-weight: 800;
      font-size: 1.35rem;
      letter-spacing: -0.03em;
      margin: 0 0 6px;
      background: linear-gradient(135deg, var(--accent2), var(--accent));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }}
    .sub {{
      margin: 0 0 20px;
      font-size: 0.88rem;
      color: var(--muted);
      line-height: 1.5;
    }}
    .hint {{
      font-size: 0.82rem;
      color: var(--muted);
      line-height: 1.5;
      margin: 0 0 18px;
    }}
    .hint.warn {{ color: #e9a84c; }}
    .hint code {{ font-size: 0.78em; padding: 2px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); }}
    .actions {{
      display: flex;
      flex-direction: column;
      gap: 10px;
    }}
    .btn {{
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 18px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 0.92rem;
      text-decoration: none;
      border: 1px solid var(--border);
      transition: transform 0.18s ease, box-shadow 0.2s ease, border-color 0.2s;
    }}
    .btn:hover {{ transform: translateY(-1px); }}
    .btn-secondary {{
      background: rgba(255,255,255,0.04);
      color: var(--txt);
    }}
    .btn-tg {{
      background: linear-gradient(135deg, #2aabee, #229ed9);
      color: #fff;
      border-color: transparent;
    }}
  </style>
</head>
<body>
  <div class="card">
    <h1 class="logo">{node}</h1>
    <p class="sub">Частный VPN · узел на Hysteria 2</p>
    {hint}
    <div class="actions">
      <a class="btn btn-tg" href="{html_escape(tg, quote=True)}" target="_blank" rel="noopener">Telegram — бот</a>
      <a class="btn btn-secondary" href="{html_escape(home, quote=True)}" target="_blank" rel="noopener">Сайт xtinder.ru</a>
    </div>
  </div>
</body>
</html>"""


def _serve_ui_file() -> FileResponse:
    if not _ui_path.is_file():
        raise HTTPException(status_code=404, detail="ui/index.html not found")
    return FileResponse(_ui_path, media_type="text/html; charset=utf-8")


def _trunc_happ_title(s: str, max_len: int = 25) -> str:
    s = (s or "").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"


def _user_expire_unix(tid: str) -> int:
    ue = _config.get("user_expires")
    if isinstance(ue, dict) and tid in ue:
        try:
            return int(ue[tid])
        except (TypeError, ValueError):
            pass
    d = _happ_cfg().get("default_expire_unix")
    try:
        return int(d) if d is not None else 0
    except (TypeError, ValueError):
        return 0


def _subscription_total_bytes() -> int:
    try:
        return int(_happ_cfg().get("subscription_total_bytes", 0))
    except (TypeError, ValueError):
        return 0


async def _user_traffic_up_down(tid: str) -> tuple[int, int]:
    try:
        data = await _traffic_with_persistence()
    except HTTPException:
        return 0, 0
    if not isinstance(data, dict):
        return 0, 0
    u: dict[str, Any] | None = None
    if tid in data and isinstance(data[tid], dict):
        u = data[tid]
    users = data.get("users")
    if u is None and isinstance(users, dict) and tid in users and isinstance(users[tid], dict):
        u = users[tid]
    if not u:
        return 0, 0
    up = int(u.get("tx") or u.get("upload") or 0)
    down = int(u.get("rx") or u.get("download") or 0)
    return up, down


def _build_hysteria2_uri_dict(tid: str) -> dict[str, Any]:
    """Собирает hysteria2:// и человекочитаемый fragment (#) для HAPP."""
    y = _read_hysteria_yaml()
    auth = y.get("auth") or {}
    up = auth.get("userpass") or {}
    if not isinstance(up, dict) or tid not in up:
        raise HTTPException(status_code=404, detail="User not found")
    password = str(up[tid])
    domain = _hysteria_public_domain(y)
    if not domain:
        raise HTTPException(
            status_code=503,
            detail=(
                "Не задан домен для ссылки (SNI). Укажите в config.json агента public_base_url "
                "(https://тот-же-домен-что-у-панели-Apache) или hysteria_public_domain; "
                "либо в config.yaml Hysteria: acme.domains, public_domain / server_name, tls.sni, "
                "или путь tls.cert вида .../letsencrypt/live/ДОМЕН/fullchain.pem."
            ),
        )
    port = _hysteria_listen_port(y)
    node_name = str(_config.get("node_name", "HY2"))
    hc = _happ_cfg()
    frag_text = _happ_fragment_for_client(tid, node_name, hc)
    tid_q = quote(tid, safe="")
    pw_q = quote(password, safe="")
    sni_q = quote(domain, safe="")
    frag_q = quote(frag_text, safe="")
    uri = f"hysteria2://{tid_q}:{pw_q}@{domain}:{port}/?sni={sni_q}&insecure=0#{frag_q}"
    return {
        "uri": uri,
        "telegram_id": tid,
        "domain": domain,
        "port": port,
        "node_name": node_name,
        "fragment": frag_text,
    }


@app.get("/users/{telegram_id}/client-uri")
async def client_uri(telegram_id: str, request: Request, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    """Готовая hysteria2:// и URL подписки HAPP (формат profile-title + subscription-userinfo)."""
    tid = _validate_tg_id(telegram_id)
    d = _build_hysteria2_uri_dict(tid)
    base = _public_base_url(request)
    key = _happ_subscription_key()
    d["happ_subscription_url"] = f"{base}/sub/{tid}?k={quote(key, safe='')}" if key else None
    d["happ_subscription_hint"] = (
        "В HAPP: Subscriptions → + → вставьте только эту HTTPS-ссылку. Удалите старую подписку и добавьте заново, затем «Обновить». Одна строка hysteria2 не даёт блок с трафиком."
        if key
        else "Задайте jwt_secret в config.json агента (нужен для ключа подписки)."
    )
    return d


@app.get("/sub/{telegram_id}")
async def happ_subscription_export(
    telegram_id: str,
    _auth: dict[str, Any] = Depends(verify_sub_key_or_jwt),
) -> Response:
    """Текст подписки для HAPP: метаданные + hysteria2:// (см. документацию Happ)."""
    tid = _validate_tg_id(telegram_id)
    d = _build_hysteria2_uri_dict(tid)
    up, down = await _user_traffic_up_down(tid)
    tot = _subscription_total_bytes()
    exp = _user_expire_unix(tid)
    hc = _happ_cfg()
    pt = (hc.get("profile_title") or "").strip()
    if not pt:
        fl, cn = _happ_country_flag_name(hc)
        if fl and cn:
            pt = f"{fl} {cn}"
        else:
            pt = str(_config.get("node_name") or "VPN")
    title = _trunc_happ_title(pt)
    lines = [
        f"#profile-title: {title}",
        "#profile-update-interval: 1",
        f"#subscription-userinfo: upload={up}; download={down}; total={tot}; expire={exp}",
    ]
    su = (hc.get("support_url") or "").strip()
    if su:
        lines.append(f"#support-url: {su}")
    pwu = (hc.get("profile_web_page_url") or "").strip()
    if pwu:
        lines.append(f"#profile-web-page-url: {pwu}")
    lines.append(d["uri"])
    body = "\n".join(lines) + "\n"
    info_hdr = f"upload={up}; download={down}; total={tot}; expire={exp}"
    return Response(
        content=body.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={
            "subscription-userinfo": info_hdr,
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="subscription.txt"',
        },
    )


@app.get("/users/{telegram_id}")
async def get_user(telegram_id: str, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    tid = _validate_tg_id(telegram_id)
    y = _read_hysteria_yaml()
    auth = y.get("auth") or {}
    up = auth.get("userpass") or {}
    if not isinstance(up, dict) or tid not in up:
        raise HTTPException(status_code=404, detail="User not found")
    return {"telegram_id": tid, "has_password": True}


@app.post("/users")
async def add_user(body: UserCreate, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    tid = _validate_tg_id(body.telegram_id)
    y = _read_hysteria_yaml()
    if "auth" not in y:
        y["auth"] = {}
    y["auth"]["type"] = "userpass"
    if "userpass" not in y["auth"] or y["auth"]["userpass"] is None:
        y["auth"]["userpass"] = {}
    up = y["auth"]["userpass"]
    if not isinstance(up, dict):
        up = {}
        y["auth"]["userpass"] = up
    up[tid] = body.password
    _write_hysteria_yaml(y)
    await asyncio.to_thread(_restart_hysteria)
    return {"ok": True, "telegram_id": tid}


@app.delete("/users/{telegram_id}")
async def delete_user(telegram_id: str, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    tid = _validate_tg_id(telegram_id)
    y = _read_hysteria_yaml()
    auth = y.get("auth") or {}
    up = auth.get("userpass")
    if not isinstance(up, dict) or tid not in up:
        raise HTTPException(status_code=404, detail="User not found")
    del up[tid]
    _write_hysteria_yaml(y)
    if _traffic_persist_enabled():
        await asyncio.to_thread(_traffic_persist_remove_user, tid)
    await asyncio.to_thread(_restart_hysteria)
    return {"ok": True}


@app.get("/traffic")
async def traffic_all(_: dict = Depends(verify_bearer)) -> Any:
    return await _traffic_with_persistence()


@app.get("/online")
async def online_stats(_: dict = Depends(verify_bearer)) -> Any:
    """Прокси к встроенному HY2 Traffic Stats API: карта user_id → число подключений (клиентов)."""
    return await _stats_request("GET", "/online")


@app.get("/traffic/{telegram_id}")
async def traffic_one(telegram_id: str, _: dict = Depends(verify_bearer)) -> Any:
    tid = _validate_tg_id(telegram_id)
    data = await _traffic_with_persistence()
    # Ответ HY2 может быть dict/list — пытаемся отфильтровать по ключу пользователя
    if isinstance(data, dict) and tid in data:
        return {tid: data[tid]}
    if isinstance(data, dict) and "users" in data:
        u = data["users"]
        if isinstance(u, dict) and tid in u:
            return {tid: u[tid]}
    return {"telegram_id": tid, "data": data}


@app.post("/traffic/{telegram_id}/reset")
async def traffic_reset(telegram_id: str, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    tid = _validate_tg_id(telegram_id)
    # Популярные варианты API — если не сработает, вернём 501
    for path in (f"/traffic/{tid}/reset", "/traffic/reset", f"/reset/{tid}"):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"http://127.0.0.1:25413{path}",
                    headers=_stats_authorization_headers(),
                )
            if r.status_code < 400:
                if _traffic_persist_enabled():
                    await asyncio.to_thread(_traffic_persist_clear_user, tid)
                return {"ok": True, "path": path, "response": r.text[:500]}
        except Exception:
            continue
    raise HTTPException(
        status_code=501,
        detail="Traffic reset is not supported by this Hysteria stats API build; use server-side tools if needed.",
    )


@app.get("/config")
async def get_config(_: dict = Depends(verify_bearer)) -> dict[str, str]:
    path = _hysteria_config_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="config not found")
    return {"path": str(path), "content": path.read_text(encoding="utf-8")}


@app.put("/config")
async def put_config(body: ConfigPut, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    try:
        yaml.safe_load(body.content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}") from e
    path = _hysteria_config_path()
    path.write_text(body.content, encoding="utf-8")
    await asyncio.to_thread(_restart_hysteria)
    return {"ok": True}


@app.post("/service/node-agent/{action}")
async def service_node_agent(action: str, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    """Управление systemd-юнитом hy2-agent (должен быть выше /service/{action})."""
    if action not in ("start", "stop", "restart"):
        raise HTTPException(status_code=400, detail="action must be start|stop|restart")
    try:
        subprocess.run(["systemctl", action, "hy2-agent"], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=e.stderr or str(e)) from e
    return {"ok": True, "service": "hy2-agent", "action": action}


@app.post("/service/{action}")
async def service_action(action: str, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    if action not in ("start", "stop", "restart"):
        raise HTTPException(status_code=400, detail="action must be start|stop|restart")
    svc = _hysteria_service()
    try:
        subprocess.run(["systemctl", action, svc], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=e.stderr or str(e)) from e
    return {"ok": True, "service": svc, "action": action}


@app.get("/logs")
async def logs(_: dict = Depends(verify_bearer)) -> dict[str, Any]:
    try:
        out = subprocess.run(
            ["journalctl", "-u", _hysteria_service(), "-n", "100", "--no-pager"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=e.stderr or str(e)) from e
    return {"lines": out.splitlines()}


@app.get("/auth/me")
async def auth_me(auth: dict[str, Any] = Depends(verify_bearer)) -> dict[str, Any]:
    """Проверка сессии по Bearer или cookie (для F5 без чтения HttpOnly в JS)."""
    sub = auth.get("sub") if auth.get("kind") == "jwt" else None
    return {"ok": True, "kind": auth.get("kind"), "sub": sub}


@app.post("/auth/logout")
async def auth_logout(request: Request) -> JSONResponse:
    r = JSONResponse(content={"ok": True})
    # Параметры как у set_cookie — иначе браузер может не сбросить HttpOnly
    r.delete_cookie(
        _UI_JWT_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_client_https(request),
    )
    return r


@app.post("/auth/login")
async def login(body: LoginBody, request: Request) -> JSONResponse:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    async with _login_lock:
        if ip not in _login_rate_limit:
            _login_rate_limit[ip] = []
        # Ограничение: 5 попыток за 15 минут (900 сек)
        _login_rate_limit[ip] = [t for t in _login_rate_limit[ip] if now - t < 900]
        if len(_login_rate_limit[ip]) >= 5:
            raise HTTPException(status_code=429, detail="Too many failed login attempts. Please wait 15 minutes.")

    if body.login != _config.get("login"):
        async with _login_lock:
            _login_rate_limit[ip].append(now)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    ph = str(_config.get("password_hash", ""))
    if not pwd_ctx.verify(body.password, ph):
        async with _login_lock:
            _login_rate_limit[ip].append(now)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Сброс счетчика при успешном входе
    async with _login_lock:
        if ip in _login_rate_limit:
            del _login_rate_limit[ip]

    exp = datetime.now(timezone.utc) + timedelta(hours=24)
    token = jwt.encode(
        {"sub": body.login, "exp": exp},
        _jwt_secret(),
        algorithm="HS256",
    )
    payload = {"access_token": token, "token_type": "bearer", "expires_in": 86400}
    response = JSONResponse(content=payload)
    # HttpOnly: переживает сбои localStorage; JS дублирует в localStorage для Authorization
    response.set_cookie(
        key=_UI_JWT_COOKIE,
        value=token,
        max_age=86400,
        path="/",
        httponly=True,
        secure=_client_https(request),
        samesite="lax",
    )
    return response


@app.get("/")
async def root_landing(request: Request) -> HTMLResponse:
    """Красивая точка входа: панель, сайт, Telegram (без JSON)."""
    return HTMLResponse(_landing_html(request, not_found=False), status_code=200)


@app.get("/ui")
@app.get("/ui/", include_in_schema=False)
async def ui_entry() -> FileResponse:
    return _serve_ui_file()


@app.get("/ui/style.css", include_in_schema=False)
async def ui_css() -> FileResponse:
    path = _ui_path.parent / "style.css"
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="text/css")


@app.get("/ui/app.js", include_in_schema=False)
async def ui_js() -> FileResponse:
    path = _ui_path.parent / "app.js"
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="application/javascript")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/{catch_all:path}", include_in_schema=False)
async def catch_all_get(catch_all: str, request: Request) -> Response:
    """Любой неизвестный GET: браузеру — HTML-заглушка, API — JSON 404."""
    accept = (request.headers.get("accept") or "").lower()
    if "text/html" in accept:
        return HTMLResponse(_landing_html(request, not_found=True), status_code=404)
    raise HTTPException(status_code=404, detail="Not Found")


@app.exception_handler(HTTPException)
async def hy2_http_exception_handler(request: Request, exc: HTTPException) -> Response:
    """Браузеру при 404 — HTML-заглушка вместо JSON {detail: Not Found}."""
    if exc.status_code == 404:
        accept = (request.headers.get("accept") or "").lower()
        if "text/html" in accept:
            return HTMLResponse(_landing_html(request, not_found=True), status_code=404)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

