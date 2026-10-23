"""State v2: atomic save, .bak fallback, 0.3 import, thread/turn records (section 5.3)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from emperor_bridge.interfaces import ThreadSession  # noqa: E402
from emperor_bridge.state import BridgeState, state_path_for  # noqa: E402


def session(thread: str = "t1", gen: int = 3) -> ThreadSession:
    return ThreadSession(thread_id=thread, generation=gen, policy_hash="a1b2c3d4e5f60718",
                         create_params={"request_id": f"emperor/a/{thread}/g{gen}", "source": "tool",
                                        "client_env": {"HERMES_EPHEMERAL_SYSTEM_PROMPT": "x" * 30000}},
                         session_id="local-abc", replay_epoch="ep", last_seq=41, revision=17, context_used=51234)


class StateV2Test(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.path = state_path_for(self.home)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_fresh_state_and_roundtrip(self) -> None:
        state = BridgeState.load(self.path, agent_id="agent-1", runtime_id="rt")
        self.assertEqual(state.data["version"], 2)
        state.put_thread(session())
        state.put_turn("emp-m1", {"runId": "r", "threadId": "t1", "status": "running", "sawTool": True})
        asyncio.run(state.save())
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(raw["threads"]["t1"]["createParams"]["request_id"], "emperor/a/t1/g3")
        self.assertEqual(raw["threads"]["t1"]["lastSeq"], 41)
        again = BridgeState.load(self.path, agent_id="agent-1")
        rec = again.get_thread("t1")
        self.assertEqual((rec.generation, rec.session_id, rec.revision, rec.context_used), (3, "local-abc", 17, 51234))
        self.assertEqual(rec.create_params, session().create_params)
        self.assertEqual(list(again.open_turns()), ["emp-m1"])
        if hasattr(os, "getuid"):
            self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_bak_used_when_live_file_is_corrupt(self) -> None:
        state = BridgeState.load(self.path, agent_id="agent-1")
        state.put_thread(session())
        state.save_sync()
        state.put_thread(session("t2"))
        state.save_sync()  # previous file becomes .bak
        self.path.write_text("{truncated", encoding="utf-8")
        again = BridgeState.load(self.path, agent_id="agent-1")
        self.assertIsNotNone(again.get_thread("t1"))
        self.assertTrue(self.path.with_name(self.path.name + ".corrupt").exists())

    def test_import_legacy_03_state(self) -> None:
        legacy = self.home / "emperor-bridge-state.json"
        legacy.write_text(json.dumps({"seen": ["m1", "m2"], "lastSeenAt": "2026-10-20T10:00:00Z",
                                      "sessions": {"Viktor:t1": "20261001_old"}, "primed": {"Viktor:t1": {}},
                                      "direct_threads": {"t1": True}, "loop_guard": {"t9": 2},
                                      "retries": {"m3": {"attempts": 1}}, "objective": {"id": "o1"}}),
                          encoding="utf-8")
        before = legacy.read_text(encoding="utf-8")
        state = BridgeState.load(self.path, legacy_path=legacy, agent_id="agent-1")
        self.assertEqual(state.data["seen"], ["m1", "m2"])
        self.assertEqual(state.data["directThreads"], {"t1": True})
        self.assertEqual(state.data["loopGuard"], {"t9": 2})
        self.assertEqual(state.data["objective"], {"id": "o1"})
        self.assertEqual(state.data["threads"], {})
        self.assertNotIn("sessions", state.data)
        self.assertEqual(state.data["migratedFrom"]["droppedSessions"], 1)
        asyncio.run(state.save_if_dirty())
        self.assertTrue(self.path.exists())
        self.assertEqual(legacy.read_text(encoding="utf-8"), before)  # rollback keeps working
        # second boot reads v2, not the legacy file
        legacy.write_text(json.dumps({"seen": ["other"]}), encoding="utf-8")
        self.assertEqual(BridgeState.load(self.path, legacy_path=legacy, agent_id="agent-1").data["seen"], ["m1", "m2"])

    def test_refuses_another_agents_state(self) -> None:
        BridgeState.load(self.path, agent_id="agent-1").save_sync()
        with self.assertRaises(ValueError):
            BridgeState.load(self.path, agent_id="agent-2")

    def test_prune_keeps_generation_counter(self) -> None:
        state = BridgeState.load(self.path, agent_id="a")
        old = session("old", gen=4)
        old.last_turn_at = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        state.put_thread(old)
        state.put_thread(session("new"))
        self.assertEqual(state.prune_threads(30), ["old"])
        self.assertIsNone(state.get_thread("old"))
        self.assertEqual(state.generation_floor("old"), 4)
        self.assertIsNotNone(state.get_thread("new"))

    def test_drop_turn(self) -> None:
        state = BridgeState.load(self.path, agent_id="a")
        state.put_turn("emp-1", {"status": "settled"})
        state.drop_turn("emp-1")
        self.assertIsNone(state.get_turn("emp-1"))


if __name__ == "__main__":
    unittest.main()
