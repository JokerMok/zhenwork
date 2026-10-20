import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import uuid
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("knowledge_directory_sync.py")
SPEC = importlib.util.spec_from_file_location("knowledge_directory_sync", MODULE_PATH)
SYNC = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SYNC
SPEC.loader.exec_module(SYNC)


class MockState:
    def __init__(self):
        self.documents = {}
        self.commands = {}
        self.fail_upload = False
        self.upload_calls = 0


def handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_json(self, code, data, status=200, headers=None):
            payload = json.dumps({"code": code, "data": data}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if headers:
                for key, value in headers.items():
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            if self.path == "/api/auth/login":
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_json(200, {"access_token": "cookie-session"}, headers={"Set-Cookie": "__Host-workspace-rc2=test; Secure; HttpOnly; SameSite=Strict; Path=/"})
                return
            if self.path == "/api/auth/logout":
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_json(200, None)
                return
            if "/documents?" not in self.path:
                self.send_json(404, None, 404)
                return
            state.upload_calls += 1
            if state.fail_upload:
                self.send_json(500, None, 500)
                return
            query = dict(item.split("=", 1) for item in self.path.split("?", 1)[1].split("&"))
            key = query["idempotencyKey"]
            if key in state.commands:
                self.send_json(200, state.commands[key])
                return
            length = int(self.headers["Content-Length"])
            payload = self.rfile.read(length)
            disposition = payload.split(b"\r\n", 2)[1].decode()
            filename = disposition.split('filename="', 1)[1].split('"', 1)[0]
            if "documentId" in query:
                document_id = query["documentId"]
                document = state.documents[document_id]
                self.assert_equal(int(query["expectedVersion"]), document["latest_version"])
                document["latest_version"] += 1
                document["title"] = filename
            else:
                document_id = str(uuid.uuid4())
                state.documents[document_id] = {"id": document_id, "title": filename, "latest_version": 1}
            result = {"id": document_id, "version": state.documents[document_id]["latest_version"], "status": "QUEUED"}
            state.commands[key] = result
            self.send_json(200, result)

        def assert_equal(self, left, right):
            if left != right:
                raise AssertionError(f"{left!r} != {right!r}")

        def do_GET(self):
            if "/api/ai/knowledge/" in self.path and "/documents?page=" in self.path:
                page = int(self.path.rsplit("=", 1)[1])
                rows = list(state.documents.values()) if page == 1 else []
                self.send_json(200, rows)
                return
            self.send_json(404, None, 404)

        def do_DELETE(self):
            document_id = self.path.rsplit("/", 1)[1]
            if document_id not in state.documents:
                self.send_json(404, None, 404)
                return
            del state.documents[document_id]
            self.send_json(200, None)

    return Handler


class KnowledgeDirectorySyncTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.fd_path_patcher = None
        if sys.platform != "linux":
            import fcntl

            def macos_fd_path(fd):
                value = fcntl.fcntl(fd, 50, b"\0" * 1024)
                return Path(value.split(b"\0", 1)[0].decode()).resolve()

            self.fd_path_patcher = mock.patch.object(SYNC, "_opened_fd_canonical_path", side_effect=macos_fd_path)
            self.fd_path_patcher.start()
        self.state_file = self.root / "state.json"
        self.credentials = self.root / "credentials.json"
        self.credentials.write_text(json.dumps({"clientId": "client", "username": "user", "password": "secret"}))
        self.credentials.chmod(0o600)
        self.mock = MockState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.mock))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = f"http://127.0.0.1:{self.server.server_port}"
        self.config = SYNC.SyncConfig(
            source_root=self.source.resolve(),
            knowledge_id=str(uuid.uuid4()),
            allowed_extensions=frozenset({".txt"}),
            max_files=5,
            max_file_bytes=1024,
            max_total_bytes=4096,
            max_directories=5,
            max_depth=2,
            source_readonly=True,
            credential_file=self.credentials,
            state_file=self.state_file,
            api_base_url=base + "/api",
            origin=base,
            allow_retract=False,
        )
        self.client = SYNC.Rc2Client(self.config.api_base_url, self.config.origin, "client", allow_http_for_test=True)
        self.client.login("user", "secret")

    def tearDown(self):
        self.client.logout()
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        if self.fd_path_patcher is not None:
            self.fd_path_patcher.stop()
        self.temp.cleanup()

    def test_upload_unchanged_update_and_failed_update_does_not_advance_state(self):
        document = self.source / "policy.txt"
        document.write_text("version one")
        first = SYNC.synchronize(self.config, self.client)
        self.assertEqual(first["uploaded"], 1)
        state_one = json.loads(self.state_file.read_text())
        tracked_one = state_one["files"]["policy.txt"]
        self.assertEqual(tracked_one["version"], 1)
        self.assertEqual(tracked_one["sha256"], hashlib.sha256(b"version one").hexdigest())

        unchanged = SYNC.synchronize(self.config, self.client)
        self.assertEqual(unchanged["unchanged"], 1)
        self.assertEqual(self.mock.upload_calls, 1)

        document.write_text("version two")
        changed = SYNC.synchronize(self.config, self.client)
        self.assertEqual(changed["updated"], 1)
        state_two = json.loads(self.state_file.read_text())
        self.assertEqual(state_two["files"]["policy.txt"]["version"], 2)

        document.write_text("version three")
        before_failure = self.state_file.read_bytes()
        self.mock.fail_upload = True
        with self.assertRaises(SYNC.SyncError):
            SYNC.synchronize(self.config, self.client)
        self.assertEqual(self.state_file.read_bytes(), before_failure)
        self.assertEqual(self.mock.documents[tracked_one["documentId"]]["latest_version"], 2)

    def test_rejects_symlink_escape_and_unknown_source_config(self):
        outside = self.root / "outside.txt"
        outside.write_text("outside")
        (self.source / "escape.txt").symlink_to(outside)
        with self.assertRaisesRegex(SYNC.SyncError, "symbolic links"):
            SYNC.scan_source(self.config)

        missing = self.root / "missing-config.json"
        with self.assertRaisesRegex(SYNC.SyncError, "does not exist"):
            SYNC.SyncConfig.load(missing)

    def test_missing_file_is_retained_without_double_opt_in_retract(self):
        document = self.source / "policy.txt"
        document.write_text("keep remote")
        SYNC.synchronize(self.config, self.client)
        document.unlink()
        retained = SYNC.synchronize(self.config, self.client)
        self.assertEqual(retained["retainedMissing"], 1)
        with self.assertRaisesRegex(SYNC.SyncError, "allowRetract=true"):
            SYNC.synchronize(self.config, self.client, retract_missing=True)
        self.assertEqual(len(self.mock.documents), 1)

        retraction_enabled = replace(self.config, allow_retract=True)
        retracted = SYNC.synchronize(retraction_enabled, self.client, retract_missing=True)
        self.assertEqual(retracted["retracted"], 1)
        self.assertEqual(len(self.mock.documents), 0)
        self.assertEqual(json.loads(self.state_file.read_text())["files"], {})

    def test_opened_descriptor_escape_and_tampered_state_are_rejected(self):
        document = self.source / "policy.txt"
        document.write_text("confined")
        source = SYNC.scan_source(self.config)[0]
        with mock.patch.object(SYNC, "_opened_fd_canonical_path", return_value=self.root / "outside.txt"):
            with self.assertRaisesRegex(SYNC.SyncError, "escapes or changed path"):
                SYNC.read_source_bytes(self.config, source)

        SYNC.synchronize(self.config, self.client)
        state = json.loads(self.state_file.read_text())
        state["files"]["policy.txt"]["documentId"] = "../../not-a-document-id"
        self.state_file.write_text(json.dumps(state))
        self.state_file.chmod(0o600)
        with self.assertRaisesRegex(SYNC.SyncError, "invalid documentId"):
            SYNC.synchronize(self.config, self.client)


if __name__ == "__main__":
    unittest.main()
