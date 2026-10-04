#!/usr/bin/env python3
"""BuildKit Platform local backend.

The backend intentionally uses only the Python standard library so the formal
prototype can run immediately. SQLite is a persistence adapter for this local
vertical slice; the API boundaries are designed to be replaced by PostgreSQL
and a governed business-data gateway later.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit
from live_service import handle as handle_live, initialize as initialize_live


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.environ.get("BUILDKIT_DB_PATH", DATA_DIR / "buildkit.sqlite3"))
PORT = int(os.environ.get("PORT", "4180"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


SCHEMA = """
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, version)
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_entity_idx ON records(entity, archived, updated_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  record_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


BED_SEED = [
    {"id": "B-01-01", "ward": "内分泌一病区", "type": "单人间", "status": "occupied", "patient": "患者 035"},
    {"id": "B-01-02", "ward": "内分泌一病区", "type": "双人间", "status": "available", "patient": "—"},
    {"id": "B-02-08", "ward": "内分泌二病区", "type": "双人间", "status": "occupied", "patient": "患者 260"},
    {"id": "B-03-03", "ward": "糖尿病中心", "type": "单人间", "status": "available", "patient": "—"},
    {"id": "B-03-04", "ward": "糖尿病中心", "type": "双人间", "status": "available", "patient": "—"},
    {"id": "B-04-12", "ward": "代谢病区", "type": "单人间", "status": "occupied", "patient": "患者 116"},
]
PATIENT_SEED = [
    {"id": "P-000035", "name": "患者 035", "sex": "男", "age": 58, "insurance": "城镇职工医保", "ward": "内分泌一病区"},
    {"id": "P-000116", "name": "患者 116", "sex": "女", "age": 63, "insurance": "城乡居民医保", "ward": "代谢病区"},
    {"id": "P-000260", "name": "患者 260", "sex": "男", "age": 47, "insurance": "商业保险", "ward": "内分泌二病区"},
]


def app_spec(name: str = "床位调度管理系统") -> dict[str, Any]:
    return {
        "version": "1.0",
        "name": name,
        "data_sources": [{"id": "his-demo", "name": "医疗演示 HIS 库", "governance": "脱敏样例"}],
        "entities": [
            {"name": "bed", "label": "床位", "fields": ["id", "ward", "type", "status", "patient"], "actions": ["create", "update", "soft_delete", "restore"]},
            {"name": "patient", "label": "患者", "fields": ["id", "name", "sex", "age", "insurance", "ward"], "actions": ["create", "update", "soft_delete", "restore"]},
        ],
        "views": [
            {"id": "bed-list", "type": "table", "entity": "bed", "filters": ["ward", "status", "free_text"]},
            {"id": "patient-list", "type": "table", "entity": "patient", "filters": ["ward", "sex", "insurance", "free_text"]},
            {"id": "operations", "type": "dashboard", "metrics": ["occupancy_rate", "available_count"]},
        ],
        "policies": {"read": "workspace_member", "write": "gateway_validated", "sensitive_fields": ["name"], "audit": True},
    }


def seed() -> None:
    with connect() as db:
        db.executescript(SCHEMA)
        if db.execute("SELECT 1 FROM apps LIMIT 1").fetchone():
            return
        app_id = "app-bed-management"
        stamp = now()
        db.execute("INSERT INTO apps VALUES (?, ?, ?, ?, ?, ?)", (app_id, "床位调度管理系统", "按病区管理床位和患者", "draft", stamp, stamp))
        db.execute("INSERT INTO app_versions VALUES (?, ?, ?, ?, ?, ?)", (str(uuid.uuid4()), app_id, 1, "draft", json.dumps(app_spec(), ensure_ascii=False), stamp))
        for entity, rows in (("bed", BED_SEED), ("patient", PATIENT_SEED)):
            for row in rows:
                rid = row["id"]
                db.execute("INSERT INTO records VALUES (?, ?, ?, 1, 0, ?, ?)", (rid, entity, json.dumps(row, ensure_ascii=False), stamp, stamp))


def row_record(row: sqlite3.Row) -> dict[str, Any]:
    value = json.loads(row["data_json"])
    value.update({"_version": row["version"], "_archived": bool(row["archived"]), "_updated_at": row["updated_at"]})
    return value


def error(code: str, message: str, status: int = 400) -> tuple[int, dict[str, Any]]:
    return status, {"detail": {"code": code, "message": message}}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep local logs useful without printing request bodies.
        super().log_message(fmt, *args)

    def send_json(self, status: int, payload: Any) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "response_cookie", None):
            self.send_header("Set-Cookie", self.response_cookie)
            self.response_cookie = None
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 1_000_000:
                return None
            value = json.loads(self.rfile.read(length) or b"{}")
            return value if isinstance(value, dict) else None
        except (ValueError, json.JSONDecodeError):
            return None

    def actor(self) -> str:
        return self.headers.get("X-BuildKit-Actor", "local_admin")[:128]

    def audit(self, db: sqlite3.Connection, request_id: str, action: str, entity: str, record_id: str | None, before: Any, after: Any) -> None:
        db.execute("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (str(uuid.uuid4()), request_id, self.actor(), action, entity, record_id, json.dumps(before, ensure_ascii=False) if before is not None else None, json.dumps(after, ensure_ascii=False) if after is not None else None, now()))

    def do_GET(self) -> None:  # noqa: N802
        if handle_live(self):
            return
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            if path == "/":
                self.path = "/live.html"
            return super().do_GET()
        query = parse_qs(urlsplit(self.path).query)
        try:
            with connect() as db:
                if path == "/api/health":
                    return self.send_json(200, {"ok": True, "service": "buildkit-platform", "persistence": "sqlite", "external_configured": bool(os.environ.get("KNOWNET_AGENT_APP_KEY"))})
                if path == "/api/assets":
                    return self.send_json(200, {"sources": [{"id": "his-demo", "name": "医疗演示 HIS 库", "driver": "PostgreSQL", "tables": 80, "status": "ready"}], "entities": app_spec()["entities"]})
                if path == "/api/apps":
                    rows = [dict(row) for row in db.execute("SELECT id, name, description, status, updated_at FROM apps ORDER BY updated_at DESC")]
                    return self.send_json(200, {"apps": rows})
                if path.startswith("/api/apps/") and path.endswith("/spec"):
                    app_id = path.split("/")[3]
                    row = db.execute("SELECT * FROM app_versions WHERE app_id=? ORDER BY version DESC LIMIT 1", (app_id,)).fetchone()
                    return self.send_json(200, {"app_id": app_id, "spec": json.loads(row["spec_json"]) if row else app_spec()})
                if path == "/api/audit":
                    rows = [dict(row) for row in db.execute("SELECT id, request_id, actor, action, entity, record_id, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100")]
                    return self.send_json(200, {"events": rows})
                match = re.fullmatch(r"/api/runtime/records", path)
                if match:
                    entity = query.get("entity", ["bed"])[0]
                    include_archived = query.get("scope", ["active"])[0] == "archived"
                    search = query.get("q", [""])[0].lower()
                    ward = query.get("ward", [""])[0]
                    rows = [row_record(row) for row in db.execute("SELECT * FROM records WHERE entity=? AND archived=? ORDER BY updated_at DESC", (entity, int(include_archived)))]
                    rows = [r for r in rows if (not search or search in json.dumps(r, ensure_ascii=False).lower()) and (not ward or r.get("ward") == ward)]
                    return self.send_json(200, {"entity": entity, "records": rows, "total": len(rows), "page": 1, "page_size": 100})
                return self.send_json(*error("not_found", "接口不存在", 404))
        except sqlite3.Error as exc:
            return self.send_json(*error("storage_error", str(exc), 500))

    def do_POST(self) -> None:  # noqa: N802
        if handle_live(self):
            return
        path = urlsplit(self.path).path
        payload = self.read_json()
        if payload is None:
            return self.send_json(*error("invalid_request", "请求体必须是 JSON 对象"))
        request_id = self.headers.get("X-Request-ID", str(uuid.uuid4()))
        try:
            with connect() as db:
                if path == "/api/apps/generate":
                    prompt = str(payload.get("prompt", "")).strip()
                    if not prompt:
                        return self.send_json(*error("invalid_request", "请输入业务描述"))
                    patient = any(word in prompt for word in ("患者", "病人", "医保"))
                    name = "患者运营管理系统" if patient else "床位调度管理系统"
                    stamp = now()
                    app_id = "app-" + uuid.uuid4().hex[:12]
                    spec = app_spec(name)
                    db.execute("INSERT INTO apps VALUES (?, ?, ?, ?, ?, ?)", (app_id, name, prompt, "draft", stamp, stamp))
                    db.execute("INSERT INTO app_versions VALUES (?, ?, ?, ?, ?, ?)", (str(uuid.uuid4()), app_id, 1, "draft", json.dumps(spec, ensure_ascii=False), stamp))
                    db.execute("INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?)", (str(uuid.uuid4()), app_id, "user", prompt, stamp))
                    db.execute("INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?)", (str(uuid.uuid4()), app_id, "assistant", "已生成 AppSpec 草稿，可在右侧预览并操作。", stamp))
                    return self.send_json(201, {"app": {"id": app_id, "name": name, "status": "draft"}, "spec": spec, "message": "已生成 AppSpec 草稿"})
                if path == "/api/runtime/records":
                    entity = str(payload.get("entity", "")).strip()
                    record = payload.get("record")
                    if entity not in {"bed", "patient"} or not isinstance(record, dict):
                        return self.send_json(*error("invalid_request", "entity 和 record 必须有效"))
                    fields = app_spec()["entities"][0 if entity == "bed" else 1]["fields"]
                    record = {key: value for key, value in record.items() if key in fields}
                    rid = str(record.get("id", "")).strip()
                    if not rid or db.execute("SELECT 1 FROM records WHERE id=?", (rid,)).fetchone():
                        return self.send_json(*error("invalid_request", "记录 ID 不能为空且不能重复"))
                    if entity == "bed" and record.get("status") == "occupied" and not record.get("patient"):
                        return self.send_json(*error("validation_error", "使用中的床位必须填写当前患者"))
                    stamp = now()
                    db.execute("INSERT INTO records VALUES (?, ?, ?, 1, 0, ?, ?)", (rid, entity, json.dumps(record, ensure_ascii=False), stamp, stamp))
                    after = dict(record); after.update({"_version": 1, "_archived": False, "_updated_at": stamp})
                    self.audit(db, request_id, "create", entity, rid, None, after)
                    return self.send_json(201, {"record": after})
                match = re.fullmatch(r"/api/runtime/records/(restore/)?([^/]+)", path)
                if match:
                    rid = match.group(2)
                    row = db.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
                    if not row:
                        return self.send_json(*error("not_found", "记录不存在", 404))
                    before = row_record(row)
                    archived = 0 if match.group(1) else 1
                    db.execute("UPDATE records SET archived=?, version=version+1, updated_at=? WHERE id=?", (archived, now(), rid))
                    after = dict(before); after["_archived"] = bool(archived); after["_version"] += 1
                    self.audit(db, request_id, "restore" if match.group(1) else "soft_delete", row["entity"], rid, before, after)
                    return self.send_json(200, {"record": after})
                return self.send_json(*error("not_found", "接口不存在", 404))
        except sqlite3.Error as exc:
            return self.send_json(*error("storage_error", str(exc), 500))

    def do_PUT(self) -> None:  # noqa: N802
        if handle_live(self):
            return
        return self.send_json(*error("not_found", "接口不存在", 404))

    def do_PATCH(self) -> None:  # noqa: N802
        if handle_live(self):
            return
        path = urlsplit(self.path).path
        payload = self.read_json()
        if payload is None:
            return self.send_json(*error("invalid_request", "请求体必须是 JSON 对象"))
        match = re.fullmatch(r"/api/runtime/records/([^/]+)", path)
        if not match:
            return self.send_json(*error("not_found", "接口不存在", 404))
        rid = match.group(1)
        try:
            with connect() as db:
                row = db.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
                if not row:
                    return self.send_json(*error("not_found", "记录不存在", 404))
                before = row_record(row)
                expected = payload.pop("_version", None)
                if expected is not None and int(expected) != row["version"]:
                    return self.send_json(*error("conflict", "记录已被其他请求修改，请刷新后重试", 409))
                data = json.loads(row["data_json"])
                allowed = set(app_spec()["entities"][0 if row["entity"] == "bed" else 1]["fields"])
                data.update({k: v for k, v in payload.items() if k in allowed and k != "id"})
                stamp = now()
                db.execute("UPDATE records SET data_json=?, version=version+1, updated_at=? WHERE id=?", (json.dumps(data, ensure_ascii=False), stamp, rid))
                after = dict(data); after.update({"_version": row["version"] + 1, "_archived": bool(row["archived"]), "_updated_at": stamp})
                self.audit(db, self.headers.get("X-Request-ID", str(uuid.uuid4())), "update", row["entity"], rid, before, after)
                return self.send_json(200, {"record": after})
        except (sqlite3.Error, ValueError) as exc:
            return self.send_json(*error("storage_error", str(exc), 500))

    def do_DELETE(self) -> None:  # noqa: N802
        if handle_live(self):
            return
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/api/runtime/records/([^/]+)", path)
        if not match:
            return self.send_json(*error("not_found", "接口不存在", 404))
        rid = match.group(1)
        try:
            with connect() as db:
                row = db.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
                if not row:
                    return self.send_json(*error("not_found", "记录不存在", 404))
                before = row_record(row)
                stamp = now()
                db.execute("UPDATE records SET archived=1, version=version+1, updated_at=? WHERE id=?", (stamp, rid))
                after = dict(before); after.update({"_version": row["version"] + 1, "_archived": True, "_updated_at": stamp})
                self.audit(db, self.headers.get("X-Request-ID", str(uuid.uuid4())), "soft_delete", row["entity"], rid, before, after)
                return self.send_json(200, {"record": after})
        except sqlite3.Error as exc:
            return self.send_json(*error("storage_error", str(exc), 500))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> None:
    seed()
    initialize_live()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"BuildKit Platform listening on http://127.0.0.1:{PORT}/")
    print(f"SQLite: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
