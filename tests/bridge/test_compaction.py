"""Post-reply compaction on the maintenance socket (D13), with recorded compress responses."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sessions import fixture_responses  # noqa: E402

from emperor_bridge.compaction import Compactor  # noqa: E402
from emperor_bridge.gateway.sessions import SessionManager  # noqa: E402
from emperor_bridge.interfaces import CompactionConfig, RpcError, ThreadSession  # noqa: E402
from emperor_bridge.state import BridgeState  # noqa: E402

COMPRESS_OK = fixture_responses("compress", "session.mutate")[0]["result"]
COMPRESS_BUSY = fixture_responses("compress", "session.mutate")[1]["error"]


class ScriptedChannel:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: list[tuple[str, dict]] = []
        self.answers: dict[str, list[Any]] = {}

    async def call(self, method: str, params: Optional[dict] = None, *, timeout: float = 30.0) -> Any:
        self.calls.append((method, dict(params or {}), timeout))
        queue = self.answers.get(method) or [{}]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeLink:
    def __init__(self) -> None:
        self.turns = ScriptedChannel("turns")
        self.maintenance = ScriptedChannel("maintenance")
        self.identity = None
        self.connected = True

    def add_event_listener(self, listener) -> None: ...
    def add_reconnect_listener(self, listener) -> None: ...
    def inject_events(self, events) -> None: ...
    def hold_session(self, session_id) -> None: ...
    def release_session(self, session_id) -> None: ...
    def seed_cursor(self, session_id, epoch, seq) -> None: ...


class Sink:
    def __init__(self) -> None:
        self.events = []

    def emit(self, run_id, event) -> None:
        self.events.append((run_id, event))


class CompactorTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.link = FakeLink()
        self.state = BridgeState.load(Path(self.tmp.name) / "s.json", agent_id="a")
        self.sessions = SessionManager(self.link, self.state, agent_id="a", profile_home=Path(self.tmp.name))
        self.session = ThreadSession(thread_id="t", generation=1, create_params={"request_id": "r"}, policy_hash="h",
                                     session_id="local-96d7", context_used=70000)
        self.busy = False
        self.sink = Sink()
        self.compactor = Compactor(self.link, self.sessions, self.sink, is_busy=lambda _t: self.busy,
                                   config=CompactionConfig(after_tokens=60000))
        self.link.maintenance.answers["session.resume"] = [{"revision": 4, "execution_generation": 4,
                                                            "running": False, "pending": []}]

    async def asyncTearDown(self) -> None:
        self.tmp.cleanup()

    async def test_below_threshold_or_disabled_does_nothing(self) -> None:
        self.session.context_used = 1000
        self.assertIsNone(await self.compactor.maybe_compact(self.session))
        off = Compactor(self.link, self.sessions, None, is_busy=lambda _t: False,
                        config=CompactionConfig(after_tokens=0))
        self.session.context_used = 999999
        self.assertIsNone(await off.maybe_compact(self.session))
        self.assertEqual(self.link.maintenance.calls, [])

    async def test_compress_on_maintenance_socket_with_fresh_expectations(self) -> None:
        self.link.maintenance.answers["session.mutate"] = [COMPRESS_OK]
        result = await self.compactor.maybe_compact(self.session, run_id="run-1")
        self.assertEqual(result.status, "compressed")
        self.assertEqual(result.message_count, 6)
        self.assertEqual(self.link.turns.calls, [])  # never on the turns socket
        method, params, timeout = self.link.maintenance.calls[-1]
        self.assertEqual(method, "session.mutate")
        self.assertEqual((params["expected_revision"], params["expected_generation"]), (4, 4))
        self.assertEqual(params["operation"], "compress")
        self.assertEqual(params["payload"], {"partial": True, "keep_last": 6})
        self.assertTrue(params["request_id"].startswith("compress-"))
        self.assertEqual(timeout, 660.0)
        self.assertEqual(self.session.revision, 5)
        self.assertIsNone(self.session.context_used)
        kinds = [e.kind for _, e in self.sink.events]
        self.assertEqual(kinds, ["compaction.start", "compaction.end"])
        self.assertEqual(self.sink.events[1][1].data["before"], 70000)

    async def test_busy_thread_is_retried_at_most_three_times(self) -> None:
        self.busy = True
        for _ in range(3):
            self.assertEqual((await self.compactor.maybe_compact(self.session)).status, "busy")
        self.session.context_used = None  # retries continue even without a fresh usage figure
        self.assertEqual((await self.compactor.maybe_compact(self.session)).status, "busy")  # 4th: give up
        self.assertIsNone(await self.compactor.maybe_compact(self.session))
        self.assertEqual(self.link.maintenance.calls, [])

    async def test_session_busy_from_gateway(self) -> None:
        self.link.maintenance.answers["session.mutate"] = [RpcError(COMPRESS_BUSY["code"], COMPRESS_BUSY["message"],
                                                                    COMPRESS_BUSY["data"]), COMPRESS_OK]
        self.assertEqual((await self.compactor.maybe_compact(self.session, run_id="r")).status, "busy")
        self.assertEqual((await self.compactor.maybe_compact(self.session, run_id="r")).status, "compressed")

    async def test_running_session_snapshot_counts_as_busy(self) -> None:
        self.link.maintenance.answers["session.resume"] = [{"revision": 6, "execution_generation": 7,
                                                            "running": True, "pending": [{"admission_id": "x"}]}]
        self.assertEqual((await self.compactor.maybe_compact(self.session)).status, "busy")
        self.assertNotIn("session.mutate", [c[0] for c in self.link.maintenance.calls])


if __name__ == "__main__":
    unittest.main()
