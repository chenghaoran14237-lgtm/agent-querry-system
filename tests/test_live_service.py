"""Offline contract tests. No test calls the remote platform or production DB."""
import copy
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import live_service as live

TABLE = {"source_id": 26, "schema_name": "public", "table_name": "bed_master",
         "profile_run_id": 121, "columns": [{"name": "code"}, {"name": "status"}]}
SPEC = {"schema_version": 1, "name": "床位", "source": {"id": 26, "schema_name": "public", "table_name": "bed_master", "profile_run_id": 121},
        "columns": [{"field": "code", "label": "编码"}, {"field": "status", "label": "状态"}], "filters": ["status"], "actions": ["read"]}
BODY = {"prompt": "生成床位只读页面", "source_id": 26, "schema_name": "public", "table_name": "bed_master", "request_id": "test-001"}


class FakeSession:
    owner, mode = "3", "admin-session"
    def table(self, *args): return TABLE
    def start(self, *args): return "thread-test", "run-test"
    def events(self, *args): return io.BytesIO(b'id: 1000-0\nevent: completed\ndata: {"status":"completed"}\n\n')
    def run(self, *args): return {"status": "completed"}
    def final_text(self, *args): return json.dumps(SPEC)
    def cancel(self, *args): return {"status": "cancelled"}


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = live.DB
        live.DB = Path(self.temp.name) / "test.sqlite3"
        live.SESSIONS.clear(); live.JOBS.clear()
        live.SESSIONS["test"] = {"token": "unit-test-only", "user": {"id": 3}, "expires": time.time()+30}
        live.initialize()

    def tearDown(self):
        live.DB = self.old_db
        live.SESSIONS.clear(); live.JOBS.clear()
        self.temp.cleanup()

    def request(self, body=BODY):
        with patch("threading.Thread.start"):
            code, result = live.dispatch("POST", "/api/live/generate", {}, body, "test")
        return code, result

    def queue(self):
        _, result = self.request()
        return live.JOBS[result["id"]]

    def test_valid_spec(self):
        self.assertEqual(live.validate_spec(json.dumps(SPEC), TABLE)["actions"], ["read"])

    def test_invalid_model_output(self):
        for value in [None, [], "hello", "null", '{"name":"x"}']:
            with self.subTest(value=value), self.assertRaises(live.LiveError): live.validate_spec(value, TABLE)

    def test_no_invented_fields_or_writes(self):
        cases = []
        for field in ["nonexistent", [], {}]:
            value = copy.deepcopy(SPEC); value["columns"][0]["field"] = field; cases.append(value)
        for change in [{"actions": ["read", "create"]}, {"filters": ["missing"]}, {"columns": [SPEC["columns"][0]]*2}, {"source": {"id": 27}}]:
            cases.append(dict(SPEC, **change))
        for value in cases:
            with self.subTest(value=value), self.assertRaises(live.LiveError): live.validate_spec(json.dumps(value), TABLE)

    def test_sse_opaque_cursor_and_crlf(self):
        event = live.parse_sse_frame(': keepalive\r\nid: 1723-9\r\nevent: loading\r\ndata: {"a":\r\ndata: 1}\r\n\r\n')
        self.assertEqual(event, {"id": "1723-9", "event": "loading", "data": {"a": 1}})
        self.assertIsNone(live.parse_sse_frame(": ping\n\n"))
        with self.assertRaises(live.LiveError): live.parse_sse_frame('data: broken\n\n')

    def test_unauthenticated_cannot_generate(self):
        with self.assertRaises(live.LiveError) as exc: live.dispatch("POST", "/api/live/generate", {}, BODY, "anonymous")
        self.assertEqual(exc.exception.status, 401)
        with live.db_connect() as db: self.assertEqual(db.execute("select count(*) from live_jobs").fetchone()[0], 0)

    def test_session_isolation_and_expiry(self):
        self.assertTrue(live.status("test")["connected"])
        self.assertFalse(live.status("another-browser")["connected"])
        live.SESSIONS["test"]["expires"] = 0
        with self.assertRaises(live.LiveError): live.Session("test")

    def test_catalog_omits_empty_optional_params(self):
        session = live.Session("test")
        with patch.object(session, "check_source"), patch.object(session, "request", return_value={}) as request:
            session.catalog(26)
            self.assertEqual(request.call_args[0][0], "/api/data-integration/sources/26/profile-catalog?limit=20")

    def test_idempotency_and_conflict(self):
        _, first = self.request(); _, second = self.request()
        self.assertEqual(first["id"], second["id"])
        with self.assertRaises(live.LiveError) as exc: self.request(dict(BODY, prompt="不同内容"))
        self.assertEqual(exc.exception.code, "idempotency_conflict")

    def test_same_owner_concurrency_rejected(self):
        self.request()
        with self.assertRaises(live.LiveError) as exc: self.request(dict(BODY, request_id="different"))
        self.assertEqual(exc.exception.code, "busy")

    def test_success_persists_spec_and_run(self):
        job = self.queue(); live.worker(job, FakeSession(), BODY)
        result = live.get_job(job["id"], "3")
        self.assertEqual(result["status"], "completed")
        app = live.get_app(result["app_id"], "3")
        self.assertEqual(app["spec"]["name"], "床位")
        self.assertEqual(app["last_run"]["last_seq"], "1000-0")
        with self.assertRaises(live.LiveError): live.get_app(result["app_id"], "different-owner")

    def test_invalid_response_never_publishes(self):
        job = self.queue()
        with patch.object(FakeSession, "final_text", return_value="我无法生成这个 JSON"):
            live.worker(job, FakeSession(), BODY)
        self.assertEqual(live.get_job(job["id"], "3")["status"], "failed")
        with live.db_connect() as db: self.assertEqual(db.execute("select count(*) from live_apps").fetchone()[0], 0)

    def test_cancel_before_upstream_start(self):
        job = self.queue(); job["_cancel"] = True
        with patch.object(FakeSession, "start") as start:
            live.worker(job, FakeSession(), BODY); start.assert_not_called()
        self.assertEqual(live.get_job(job["id"], "3")["status"], "cancelled")

    def test_cancel_during_final_response_never_publishes(self):
        job = self.queue()
        def answer(*args): job["_cancel"] = True; return json.dumps(SPEC)
        with patch.object(FakeSession, "final_text", side_effect=answer): live.worker(job, FakeSession(), BODY)
        self.assertEqual(live.get_job(job["id"], "3")["status"], "cancelled")
        with live.db_connect() as db: self.assertEqual(db.execute("select count(*) from live_apps").fetchone()[0], 0)

    def test_restart_marks_incomplete_and_preserves_completed(self):
        job = self.queue(); live.initialize()
        self.assertEqual(live.get_job(job["id"], "3")["status"], "interrupted")

    def test_cancel_sent_once(self):
        job = self.queue(); job["run_id"] = "run-test"
        with patch.object(FakeSession, "cancel") as cancel:
            live.cancel_upstream(job, FakeSession()); live.cancel_upstream(job, FakeSession())
            self.assertEqual(cancel.call_count, 1)

    def test_cross_site_and_host_rejected(self):
        class Handler:
            path, command = "/api/live/status", "GET"
            server = type("Server", (), {"server_port": 4180})()
            def send_json(self, code, body): self.result = code, body
        for headers in [{"Host": "attacker.example"}, {"Host": "127.0.0.1:4180", "Origin": "https://attacker.example"}]:
            h = Handler(); h.headers = headers; live.handle(h)
            self.assertEqual(h.result[0], 403)


if __name__ == "__main__": unittest.main()
