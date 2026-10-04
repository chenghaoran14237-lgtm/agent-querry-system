"""Offline tests for the persistent local working-copy CRUD surface."""
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import live_service as live


class FakeSession:
    owner = "mirror-owner"
    mode = "admin-session"

    def check_source(self, source_id):
        assert source_id == 26

    def table(self, source_id, schema_name, table_name):
        return {
            "source_id": source_id,
            "schema_name": schema_name,
            "table_name": table_name,
            "profile_run_id": 121,
            "primary_key": "code",
            "columns": [
                {"name": "code", "type": "text", "label": "编码", "nullable": False},
                {"name": "name", "type": "text", "label": "名称", "nullable": True},
                {"name": "status", "type": "text", "label": "状态", "nullable": True},
            ],
        }

    def sample(self, *args):
        return {"rows": [{"code": "B-01", "name": "一号床", "status": "available"}, {"code": "B-02", "name": "二号床", "status": "occupied"}], "row_count": 2}


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = live.DB
        live.DB = Path(self.temp.name) / "mirror.sqlite3"
        live.SESSIONS.clear()
        live.SESSIONS["mirror-session"] = {"token": "test", "user": {"id": 9}, "expires": time.time() + 60}
        live.initialize()
        self.session_patch = patch.object(live, "Session", lambda _: FakeSession())
        self.session_patch.start()

    def tearDown(self):
        self.session_patch.stop()
        live.DB = self.old_db
        live.SESSIONS.clear()
        self.temp.cleanup()

    def call(self, method, path, query=None, body=None):
        return live.dispatch(method, path, query or {}, body or {}, "mirror-session")

    def test_import_persists_and_full_local_crud(self):
        code, imported = self.call("POST", "/api/live/mirror/imports/commit", body={"source_id": 26, "schema_name": "public", "table_name": "bed_master", "limit": 20})
        self.assertEqual(code, 200)
        binding_id = imported["binding"]["id"]
        code, listed = self.call("GET", "/api/live/mirror/records", {"binding_id": [binding_id], "page_size": ["1"]})
        self.assertEqual(code, 200)
        self.assertEqual(listed["total"], 2)
        self.assertEqual(len(listed["records"]), 1)

        code, created = self.call("POST", "/api/live/mirror/records", body={"binding_id": binding_id, "record": {"code": "B-03", "name": "三号床", "status": "available"}})
        self.assertEqual(code, 201)
        row = created["record"]
        code, updated = self.call("PATCH", "/api/live/mirror/records/" + row["_id"], body={"binding_id": binding_id, "_version": row["_version"], "record": {"status": "occupied"}})
        self.assertEqual(code, 200)
        self.assertEqual(updated["record"]["status"], "occupied")
        with self.assertRaises(live.LiveError) as conflict:
            self.call("PATCH", "/api/live/mirror/records/" + row["_id"], body={"binding_id": binding_id, "_version": 1, "record": {"status": "available"}})
        self.assertEqual(conflict.exception.status, 409)
        code, deleted = self.call("DELETE", "/api/live/mirror/records/" + row["_id"], body={"binding_id": binding_id, "_version": 2})
        self.assertEqual(code, 200)
        self.assertTrue(deleted["record"]["_archived"])
        code, restored = self.call("POST", "/api/live/mirror/records/" + row["_id"] + "/restore", body={"binding_id": binding_id})
        self.assertEqual(code, 200)
        self.assertFalse(restored["record"]["_archived"])

    def test_unknown_fields_are_rejected(self):
        _, imported = self.call("POST", "/api/live/mirror/imports/commit", body={"source_id": 26, "schema_name": "public", "table_name": "bed_master"})
        with self.assertRaises(live.LiveError) as exc:
            self.call("POST", "/api/live/mirror/records", body={"binding_id": imported["binding"]["id"], "record": {"code": "B-09", "not_a_column": 1}})
        self.assertEqual(exc.exception.code, "unknown_field")


if __name__ == "__main__":
    unittest.main()
