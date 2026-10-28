"""main.py: several AgentRuntimes in one process (D21), stable runtime ids, standby on a duplicate
runtime (D19) or sharedHostOk=false (D21), health.json, and the dispatch pipeline with a stubbed
TurnRunner (reply via the outbox with the submission id as Idempotency-Key, ledger finish with the
receipt usage, D15 retry, never-admitted turns deferred)."""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.config import AgentConfig, HostConfig  # noqa: E402
from emperor_bridge.interfaces import GatewayUnavailable, TurnOutcome, TurnResult, UsageLedger  # noqa: E402
from emperor_bridge.main import AgentRuntime  # noqa: E402
from emperor_bridge.scheduler import InboundMessage, TurnBatch  # noqa: E402


class FakeEmperor:
    """The EmperorClient surface the runtime uses, recording every call."""

    def __init__(self, token: str, register_answer: dict | None = None) -> None:
        self.token, self.agent_id = token, ""
        self.calls: list[tuple] = []
        self.sent: list[tuple[dict, str]] = []
        self.statuses: list[dict] = []
        self.register_answer = register_answer or {"serverCapabilities": ["run-events: 1"], "sharedHostOk": True}

    async def request(self, method, path, body=None, query=None, **kw):
        self.calls.append((method, path, body))
        if path.startswith("/agents/") and method == "GET":
            return {"agent": {"executionAllowed": True}}
        return {"ok": True}

    async def register(self, body):
        self.calls.append(("POST", "/runtime/register", body))
        return self.register_answer

    async def send_message(self, body, *, idempotency_key=None, transport_retry=True):
        self.sent.append((dict(body), idempotency_key))
        return "reply-1"

    async def chat_status(self, thread_id, **kw):
        self.statuses.append({"threadId": thread_id, **kw})

    async def post_run_events(self, run_id, events, run_header=None):
        return {"accepted": len(events)}

    async def ack_control_command(self, command_id):
        return None

    async def get_with_etag(self, path, query, etag):
        return 304, None, etag

    def patches(self):
        return [c for c in self.calls if c[0] == "PATCH"]


def result(outcome=TurnOutcome.COMPLETED, **kw) -> TurnResult:
    return TurnResult(**{**dict(outcome=outcome, final_text="the answer", usage=UsageLedger(input_tokens=10, output_tokens=2,
                                                                                         api_calls=1, model="m"),
                                exit_reason="text_response(finish_reason=stop)", duration_ms=50), **kw})


class Fleet:
    def __init__(self, tmp: str, profiles: dict[str, str], topology: str = "standalone") -> None:
        home = Path(tmp)
        for name, token in profiles.items():
            folder = home / ".hermes" / "profiles" / name
            folder.mkdir(parents=True, exist_ok=True)
            (folder / ".env").write_text(f"EMPEROR_CLAW_API_TOKEN={token}\nEMPEROR_CLAW_AGENT_ID=agent-{name}\n",
                                         encoding="utf-8")
        self.host = HostConfig.from_env({"HOME": tmp, "EMPEROR_CLAW_HERMES_GATEWAY": topology},
                                        profiles=",".join(profiles))

    def runtime(self, profile: str, **client_kw: Any) -> AgentRuntime:
        cfg = AgentConfig.from_profile(profile, self.host)
        rt = AgentRuntime(cfg, self.host)
        rt.client = FakeEmperor(cfg.api_token, **client_kw)
        return rt


def batch_for(*texts: str, thread: str = "t1", attempt: int = 0) -> TurnBatch:
    msgs = tuple(InboundMessage(f"m{i}", thread, raw={"id": f"m{i}", "threadId": thread, "threadType": "direct",
                                                      "senderType": "human", "senderName": "Jose", "text": t,
                                                      "createdAt": "2026-10-22T10:00:00Z"})
                 for i, t in enumerate(texts))
    return TurnBatch(thread, msgs, attempt)


class MultiAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_one_process_hosts_isolated_agents(self):
        fleet = Fleet(self.tmp.name, {"a": "tok-a", "b": "tok-b"})

        async def go():
            a, b = fleet.runtime("a"), fleet.runtime("b")
            await a.prepare()
            await b.prepare()
            return a, b

        a, b = asyncio.run(go())
        self.assertNotEqual(a.state.path, b.state.path)
        self.assertEqual((a.client.token, b.client.token), ("tok-a", "tok-b"))
        self.assertEqual((a.identity.agent_id, b.identity.agent_id), ("agent-a", "agent-b"))
        for rt in (a, b):
            health = json.loads(rt.cfg.health_path.read_text())
            self.assertEqual((health["agentId"], health["bridgeVersion"]), (rt.identity.agent_id, "0.17.0"))

    def test_runtime_id_is_stable_across_restarts(self):
        fleet = Fleet(self.tmp.name, {"a": "tok"})

        async def boot():
            rt = fleet.runtime("a")
            await rt.prepare()
            return rt.identity.runtime_id

        first, second = asyncio.run(boot()), asyncio.run(boot())
        self.assertEqual(first, second)
        self.assertIn("-a-", first)

    def test_duplicate_runtime_means_standby_and_health_reports_it(self):
        fleet = Fleet(self.tmp.name, {"a": "tok"})

        async def go():
            rt = fleet.runtime("a", register_answer={"duplicateRuntime": {"runtimeId": "other"}, "serverCapabilities": []})
            await rt.prepare()
            await rt.register()
            return rt

        rt = asyncio.run(go())
        self.assertTrue(rt.scheduler.paused)
        self.assertIn("duplicate runtime other", rt.standby_reason)
        health = json.loads(rt.cfg.health_path.read_text())
        self.assertEqual(health["duplicateRuntime"], {"runtimeId": "other"})
        body = [c[2] for c in rt.client.calls if c[1] == "/runtime/register"][0]
        self.assertEqual((body["bridgeVersion"], body["gatewayTopology"], body["agentId"]), ("0.17.0", "standalone", "agent-a"))

    def test_shared_host_refused_when_companies_differ(self):
        fleet = Fleet(self.tmp.name, {"a": "t1", "b": "t2"}, topology="shared")

        async def go():
            rt = fleet.runtime("a", register_answer={"sharedHostOk": False})
            await rt.prepare()
            await rt.register()
            return rt

        rt = asyncio.run(go())
        self.assertIn("sharedHostOk=false", rt.standby_reason)
        self.assertTrue(rt.scheduler.paused)


class DispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.fleet = Fleet(self.tmp.name, {"a": "tok"})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def dispatch(self, batch, outcome):
        async def go():
            rt = self.fleet.runtime("a")
            await rt.prepare()
            rt.context.set_capabilities(frozenset({"run-events: 1"}), "")  # as after register()
            seen = []

            async def fake_run(turn):
                seen.append(turn)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

            rt.runner.run = fake_run
            follow_up = await rt._dispatch_batch(batch)
            await asyncio.sleep(0.05)  # background status/ledger tasks
            return rt, seen, follow_up

        return asyncio.run(go())

    def test_completed_turn_is_delivered_once_and_ledgered(self):
        rt, turns, follow_up = self.dispatch(batch_for("first", "second"), result())
        self.assertIsNone(follow_up)
        turn = turns[0]
        self.assertTrue(turn.api_text.startswith("first\n\nsecond\n\n[emperor msg=m1"))
        self.assertEqual(turn.submission_id, "emp-m1")
        body, key = rt.client.sent[0]
        self.assertEqual((body["replyToMessageId"], body["alsoResolvesMessageIds"], key), ("m1", ["m0"], "emp-m1"))
        patch = rt.client.patches()[-1][2]
        self.assertEqual((patch["status"], patch["replyMessageId"], patch["apiCalls"]), ("succeeded", "reply-1", 1))
        self.assertIn("m1", rt.state.data["seen"])
        self.assertNotIn("m1", rt.state.data.get("retries", {}))
        self.assertFalse(rt.outbox.has_parked("m1"))
        self.assertEqual(rt.state.data["dispatches"], {})

    def test_restart_lost_tool_free_turn_is_retried_once(self):
        rt, _, follow_up = self.dispatch(batch_for("hi"), result(TurnOutcome.FAILED, retry_advised=True,
                                                                 error_code="runtime_restart"))
        self.assertIsNotNone(follow_up)
        self.assertEqual(follow_up.submission_id, "emp-m0-r1")
        self.assertEqual(rt.client.sent, [])

    def test_failed_turn_posts_one_notice_and_cancels_the_message(self):
        rt, _, _ = self.dispatch(batch_for("hi"), result(TurnOutcome.FAILED, final_text="", error_code="runtime_restart"))
        self.assertIn("runtime restarted", rt.client.sent[0][0]["text"])
        self.assertTrue(any(s.get("execution_state") == "cancelled" for s in rt.client.statuses))
        self.assertEqual(rt.client.patches()[-1][2]["status"], "failed")

    def test_stopped_turn_posts_nothing(self):
        rt, _, _ = self.dispatch(batch_for("hi"), result(TurnOutcome.CANCELLED, final_text=""))
        self.assertEqual(rt.client.sent, [])
        self.assertEqual(rt.client.patches()[-1][2]["status"], "cancelled")

    def test_never_admitted_turn_waits_without_spending_attempts(self):
        rt, _, follow_up = self.dispatch(batch_for("hi"), GatewayUnavailable("gateway restarting"))
        self.assertIsNone(follow_up)
        entry = rt.state.data["retries"]["m0"]
        self.assertEqual((entry["attempts"], entry["busyMisses"]), (0, 1))
        self.assertEqual(rt.client.sent, [])
        self.assertEqual(rt.state.data["dispatches"], {})


if __name__ == "__main__":
    unittest.main()
