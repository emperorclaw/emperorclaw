"""Turn file contract with the plugin (section 5.4 as built by W5)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from emperor_bridge import turn_context  # noqa: E402
from emperor_bridge.turn_context import TurnContext  # noqa: E402


def ctx(submission: str = "emp-m1", expires_in: float = 60) -> TurnContext:
    return TurnContext(thread_id="8f2c-thread", session_generation=3, message_id="m1", run_id="run-1",
                       submission_id=submission, message_ids=("m0", "m1"), expires_at=time.time() + expires_in)


class TurnContextTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_write_matches_plugin_reader(self) -> None:
        path = turn_context.write(self.home, "8f2c-thread", ctx())
        self.assertEqual(path, self.home / "emperor" / "turns" / "8f2c-thread.json")
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["messageId"], "m1")
        self.assertEqual(data["sessionGeneration"], "3")  # compared as a string with EMPEROR_SESSION_GEN
        self.assertEqual(data["threadId"], "8f2c-thread")
        self.assertEqual(data["submissionId"], "emp-m1")
        expires = datetime.fromisoformat(data["expiresAt"].replace("Z", "+00:00")).timestamp()
        self.assertGreater(expires, time.time())
        if hasattr(os, "getuid"):
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_clear_only_own_submission(self) -> None:
        turn_context.write(self.home, "8f2c-thread", ctx("emp-m2"))
        self.assertFalse(turn_context.clear(self.home, "8f2c-thread", "emp-m1"))
        self.assertIsNotNone(turn_context.read(self.home, "8f2c-thread"))
        self.assertTrue(turn_context.clear(self.home, "8f2c-thread", "emp-m2"))
        self.assertFalse(turn_context.clear(self.home, "8f2c-thread"))

    def test_unsafe_thread_id_rejected(self) -> None:
        for bad in ("../etc", "a/b", "", ".hidden"):
            with self.assertRaises(ValueError):
                turn_context.turn_file_path(self.home, bad)


if __name__ == "__main__":
    unittest.main()
