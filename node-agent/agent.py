"""
HY2 Node Agent — FastAPI. Конфиг: /opt/hy2-agent/config.json (путь можно переопределить переменной HY2_AGENT_CONFIG).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from urllib.parse import quote
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import psutil
import yaml
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field

CONFIG_PATH = Path(os.environ.get("HY2_AGENT_CONFIG", "/opt/hy2-agent/config.json"))

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
app = FastAPI(title="HY2 Node Agent", docs_url=None, redoc_url=None, openapi_url=None)

_config: dict[str, Any] = {}
_ui_path: Path = Path(__file__).resolve().parent / "ui" / "index.html"


def load_config() -> None:
    global _config, _ui_path
    if not CONFIG_PATH.is_file():
        raise RuntimeError(f"Config not found: {CONFIG_PATH}")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        _config = json.load(f)
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


async def verify_bearer(authorization: str | None = Header(None)) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=403, detail="Missing or invalid Authorization header")
    raw = authorization[7:].strip()
    if raw == _agent_token():
        return {"kind": "agent"}
    try:
        payload = jwt.decode(raw, _jwt_secret(), algorithms=["HS256"])
        return {"kind": "jwt", "sub": payload.get("sub")}
    except JWTError:
        raise HTTPException(status_code=403, detail="Invalid token") from None


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


def _systemctl_is_active(unit: str) -> str:
    return subprocess.run(
        ["systemctl", "is-active", unit],
        capture_output=True,
        text=True,
    ).stdout.strip()


def _hysteria_version_line() -> str:
    try:
        p = subprocess.run(
            ["hysteria", "version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        line = (p.stdout or p.stderr or "").strip().splitlines()
        return line[0].strip() if line else "unknown"
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
    return {
        "node_name": str(_config.get("node_name", "")),
        "hysteria_service": _hysteria_service(),
        "hysteria_active": hysteria_active,
        "hysteria_version": _hysteria_version_line(),
        "hy2_agent_active": hy2_agent_active,
        "cpu_percent": psutil.cpu_percent(interval=None),
        "memory": {
            "total": vm.total,
            "used": vm.used,
            "percent": vm.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "percent": disk.percent,
        },
        "uptime_seconds": uptime_s,
    }


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
    acme = y.get("acme") or {}
    doms = acme.get("domains")
    if isinstance(doms, list) and doms:
        return str(doms[0]).strip()
    return ""


@app.get("/users/{telegram_id}/client-uri")
async def client_uri(telegram_id: str, _: dict = Depends(verify_bearer)) -> dict[str, Any]:
    """Готовая hysteria2:// ссылка для клиентов (HAPP и др.); пароль берётся из config.yaml."""
    tid = _validate_tg_id(telegram_id)
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
            detail="В конфиге Hysteria нет acme.domains — нечего подставить в ссылку",
        )
    port = _hysteria_listen_port(y)
    node_name = str(_config.get("node_name", "HY2"))
    tid_q = quote(tid, safe="")
    pw_q = quote(password, safe="")
    sni_q = quote(domain, safe="")
    frag_q = quote(node_name, safe="")
    uri = f"hysteria2://{tid_q}:{pw_q}@{domain}:{port}/?sni={sni_q}&insecure=0#{frag_q}"
    return {
        "uri": uri,
        "telegram_id": tid,
        "domain": domain,
        "port": port,
        "node_name": node_name,
    }


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
    await asyncio.to_thread(_restart_hysteria)
    return {"ok": True}


@app.get("/traffic")
async def traffic_all(_: dict = Depends(verify_bearer)) -> Any:
    return await _stats_request("GET", "/traffic")


@app.get("/online")
async def online_stats(_: dict = Depends(verify_bearer)) -> Any:
    """Прокси к встроенному HY2 Traffic Stats API: карта user_id → число подключений (клиентов)."""
    return await _stats_request("GET", "/online")


@app.get("/traffic/{telegram_id}")
async def traffic_one(telegram_id: str, _: dict = Depends(verify_bearer)) -> Any:
    tid = _validate_tg_id(telegram_id)
    data = await _stats_request("GET", "/traffic")
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


@app.post("/auth/login")
async def login(body: LoginBody) -> dict[str, Any]:
    if body.login != _config.get("login"):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    ph = str(_config.get("password_hash", ""))
    if not pwd_ctx.verify(body.password, ph):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    exp = datetime.now(timezone.utc) + timedelta(hours=24)
    token = jwt.encode(
        {"sub": body.login, "exp": exp},
        _jwt_secret(),
        algorithm="HS256",
    )
    return {"access_token": token, "token_type": "bearer", "expires_in": 86400}


@app.get("/ui")
async def ui() -> FileResponse:
    if not _ui_path.is_file():
        raise HTTPException(status_code=404, detail="ui/index.html not found")
    return FileResponse(_ui_path, media_type="text/html; charset=utf-8")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}

