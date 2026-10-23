"""Latency and delivery behavior of bridge 0.9: the reply outbox (never re-run a finished turn),
failure classification, the per-turn delta (D6), acknowledge-first and the timing lines (5.8).

Deleted with 0.3: the static-block cache plan, the parallel pre-dispatch pool and the late
dispatch-status generation counter (one CLI process per turn no longer exists).
"""
import asyncio
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/bridge"))

from emperor_bridge.context import DELTA_MAX, build_delta, compose_api_text  # noqa: E402
from emperor_bridge.emperor_api import (ApiError, TransportError, classify, is_environment_failure,  # noqa: E402
                                        is_soft_failure)
from emperor_bridge.log import TimedLink, format_turn_delivery  # noqa: E402
from emperor_bridge.outbox import Outbox, build_entry  # noqa: E402


def run(coro):
    return asyncio.run(coro)


async def no_sleep(_s):
    return None


class OutboxHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.box = Outbox(Path(self.tmp.name) / "outbox", retry_base_s=15, retry_max_s=900, max_attempts=3,
                          sleep=no_sleep, logger=logging.getLogger("test"))
        self.sent, self.delivered, self.given_up = [], [], []

    def tearDown(self):
        self.tmp.cleanup()

    def entry(self, mid="m1", text="answer"):
        return build_entry(message_id=mid, thread_id="t1", agent_id="a1", text=text, idempotency_key=f"emp-{mid}",
                           ledger_finish={"run_id": "r1", "payload": {"status": "succeeded"}})

    def sender(self, failures):
        async def send(body, key):
            self.sent.append((dict(body), key))
            if failures:
                raise failures.pop(0)
            return "reply-1"
        return send

    async def on_delivered(self, entry, reply_id):
        self.delivered.append((entry["message_id"], reply_id))

    async def on_given_up(self, entry):
        self.given_up.append(entry["message_id"])


class TestOutboxDelivery(OutboxHarness):
    def test_deliver_returns_the_stored_id_and_forgets_the_entry(self):
        entry = self.box.put(self.entry())
        self.assertTrue(self.box.has_parked("m1"))
        reply = run(self.box.deliver(entry, self.sender([]), self.on_delivered))
        self.assertEqual(reply, "reply-1")
        self.assertFalse(self.box.has_parked("m1"))
        self.assertEqual(self.delivered, [("m1", "reply-1")])

    def test_key_is_the_submission_id_and_stable_across_retries(self):
        entry = self.box.put(self.entry())
        failures = [TransportError("down"), TransportError("down")]
        run(self.box.deliver(entry, self.sender(failures), self.on_delivered, attempts=3))
        self.assertEqual({key for _, key in self.sent}, {"emp-m1"})
        self.assertEqual(len(self.sent), 3)

    def test_legacy_entry_gets_a_key_pinned_before_the_post(self):
        entry = self.box.put({**self.entry(), "idempotency_key": None})
        with self.assertRaises(TransportError):
            run(self.box.deliver(entry, self.sender([TransportError("x")]), self.on_delivered, attempts=1))
        stored = json.loads(self.box.path_for("m1").read_text())
        self.assertTrue(stored["idempotency_key"])
        self.assertEqual(stored["idempotency_key"], self.sent[0][1])

    def test_empty_text_posts_nothing_but_completes(self):
        entry = self.box.put(self.entry(text=""))
        self.assertIsNone(run(self.box.deliver(entry, self.sender([]), self.on_delivered)))
        self.assertEqual(self.sent, [])
        self.assertEqual(self.delivered, [("m1", None)])


class TestOutboxRefusalsCount(OutboxHarness):
    def flush(self, failures):
        return run(self.box.flush(self.sender(failures), self.on_delivered, self.on_given_up))

    def test_soft_and_hard_classification(self):
        self.assertTrue(is_soft_failure(TransportError("x")))
        self.assertTrue(is_soft_failure(ApiError("x", 503)))
        self.assertFalse(is_soft_failure(ApiError("x", 429)))
        self.assertFalse(is_soft_failure(ApiError("x", 400)))

    def test_refusals_give_up_and_keep_the_text(self):
        self.box.put(self.entry())
        for _ in range(3):
            data = json.loads(self.box.path_for("m1").read_text())
            data["next_at"] = 0
            self.box.save(data)
            self.flush([ApiError("loop guard", 429)])
        self.assertEqual(self.given_up, ["m1"])
        self.assertTrue(self.box.path_for("m1").with_suffix(".failed").exists())

    def test_outages_never_spend_the_budget(self):
        self.box.put(self.entry())
        for _ in range(6):
            data = json.loads(self.box.path_for("m1").read_text())
            data["next_at"] = 0
            self.box.save(data)
            self.flush([ApiError("bad gateway", 502)])
        self.assertEqual(self.given_up, [])
        self.assertEqual(json.loads(self.box.path_for("m1").read_text()).get("hard_attempts"), None)

    def test_requeue_brings_a_failed_entry_back(self):
        self.box.put(self.entry())
        path = self.box.path_for("m1")
        path.rename(path.with_suffix(".failed"))
        found = self.box.find("m1")
        entry = self.box.requeue(found)
        self.assertTrue(self.box.path_for("m1").exists())
        self.assertEqual(entry["next_at"], 0.0)

    def test_legacy_outbox_is_imported_once_without_overwriting(self):
        legacy = Path(self.tmp.name) / "legacy-outbox"
        legacy.mkdir()
        (legacy / "m9.json").write_text(json.dumps(self.entry("m9")))
        self.assertEqual(self.box.import_legacy(legacy), 1)
        self.assertTrue(self.box.has_parked("m9"))
        self.assertEqual(self.box.import_legacy(legacy), 0)


class TestParkedReplyIsNeverReRun(unittest.TestCase):
    def test_message_with_a_parked_reply_is_not_dispatched(self):
        data = {}
        msg = {"id": "m1", "threadId": "t", "threadType": "direct", "targetAgentId": "a1", "senderType": "human",
               "deliveryState": "acting", "text": "hi"}
        verdict = classify(msg, agent_id="a1", agent_name="V", data=data, started_at=0, loop_guard_max_turns=3,
                           has_parked_reply=lambda m: m == "m1")
        self.assertEqual(verdict.action, "parked")
        self.assertIn("m1", data["seen"])

    def test_resolved_direct_message_is_skipped_and_its_retry_cleared(self):
        data = {"retries": {"m1": {"attempts": 1}}}
        msg = {"id": "m1", "threadType": "direct", "deliveryState": "resolved"}
        verdict = classify(msg, agent_id="a1", agent_name="V", data=data, started_at=0, loop_guard_max_turns=3,
                           has_parked_reply=lambda _m: False)
        self.assertEqual(verdict.action, "skip")
        self.assertNotIn("m1", data["retries"])


class TestEnvironmentClassification(unittest.TestCase):
    def test_environment_failures(self):
        for exc in (TransportError("dns"), ApiError("x", 503), ApiError("x", 429), ConnectionResetError()):
            self.assertTrue(is_environment_failure(exc), exc)

    def test_genuine_failures(self):
        for exc in (ApiError("bad", 400), ValueError("invalid_params"), RuntimeError("model said timed out")):
            self.assertFalse(is_environment_failure(exc), exc)


class TestDelta(unittest.TestCase):
    MSG = {"id": "12345678-aaaa", "senderType": "human", "senderName": "Jose", "createdAt": "2026-10-22T10:05:00Z",
           "text": "hello there"}

    def test_message_comes_first_and_the_delta_is_bounded(self):
        delta = build_delta(self.MSG, roster={}, tasks=None, open_count=0, ack_first=True)
        text, api_text = compose_api_text([self.MSG], delta)
        self.assertEqual(text, "hello there")
        self.assertTrue(api_text.startswith("hello there\n\n[emperor msg=12345678 from=Jose (human) at=10:05 UTC]"))
        self.assertLessEqual(len(delta), DELTA_MAX)

    def test_ack_first_only_for_humans_and_not_for_goal_steps(self):
        self.assertIn("[ack-first]", build_delta(self.MSG, roster={}, tasks=None, open_count=0, ack_first=True))
        agent = {**self.MSG, "senderType": "agent"}
        self.assertNotIn("[ack-first]", build_delta(agent, roster={}, tasks=None, open_count=0, ack_first=True))
        self.assertNotIn("[ack-first]", build_delta(self.MSG, roster={}, tasks=None, open_count=0, ack_first=False))

    def test_task_line_only_when_given_and_capped(self):
        tasks = ['abcd1234 "' + "x" * 300 + '" [in progress]'] * 3
        delta = build_delta(self.MSG, roster={}, tasks=tasks, open_count=7, ack_first=True)
        self.assertIn("[tasks changed: 7 open", delta)
        self.assertLessEqual(len(delta), DELTA_MAX)
        self.assertNotIn("tasks", build_delta(self.MSG, roster={}, tasks=None, open_count=7, ack_first=False))

    def test_coalesced_messages_are_all_in_the_text(self):
        first = {**self.MSG, "id": "a", "text": "one"}
        second = {**self.MSG, "id": "b", "text": "two"}
        delta = build_delta(second, roster={}, tasks=None, open_count=0, ack_first=False, coalesced=2)
        text, api_text = compose_api_text([first, second], delta, "")
        self.assertEqual(text, "one\n\ntwo")
        self.assertIn("+1 earlier]", api_text)

    def test_seed_follows_the_delta(self):
        _, api_text = compose_api_text([self.MSG], "[emperor msg=x]", "[earlier in this thread]\n- a: b")
        self.assertTrue(api_text.index("[emperor") < api_text.index("[earlier"))


class TestTiming(unittest.TestCase):
    def test_delivery_line_includes_every_known_phase(self):
        line = format_turn_delivery("m1", created_at=100.0, dispatched_at=101.5, delivered_at=104.0, outcome="completed",
                                    queue_ms=20, first_token_ms=400, api_calls=2, tool_calls=1, restart_path=False,
                                    parked=False)
        for part in ("turn.delivery msg=m1", "pickup=1.50s", "queue_ms=20", "first_token_ms=400", "total=2.50s",
                     "calls=2", "tools=1", "restart_path=0"):
            self.assertIn(part, line)

    def test_unknown_phases_are_omitted_not_guessed(self):
        line = format_turn_delivery("m1", created_at=None, dispatched_at=1, delivered_at=2, outcome="failed",
                                    queue_ms=None, first_token_ms=None, api_calls=None, tool_calls=0,
                                    restart_path=True, parked=True)
        self.assertNotIn("pickup", line)
        self.assertNotIn("calls=", line.replace("tools=", ""))
        self.assertIn("restart_path=1 parked=1", line)

    def test_rpc_spans_are_tagged_with_the_socket(self):
        class Channel:
            async def call(self, method, params=None, *, timeout=30.0):
                return {"ok": True}

        class Link:
            turns, maintenance, identity, connected = Channel(), Channel(), None, True

        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        logger = logging.getLogger("test.rpc")
        logger.addHandler(Capture())
        logger.setLevel(logging.INFO)
        link = TimedLink(Link(), logger)
        run(link.turns.call("prompt.submit", {}))
        run(link.maintenance.call("session.mutate", {}))
        self.assertRegex(records[0], r"^rpc method=prompt\.submit ws=turns ms=\d+\.\d status=ok$")
        self.assertIn("ws=maintenance", records[1])


if __name__ == "__main__":
    unittest.main()
