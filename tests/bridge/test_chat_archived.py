"""A reply into an archived chat (multi-chat P0: `409 chat_archived`) is final: the outbox drops it
with a log line, never retries it and settles the run; other refusals keep their retry budget."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.emperor_api import ApiError, is_chat_archived  # noqa: E402
from emperor_bridge.outbox import Outbox, ReplyDesk, build_entry  # noqa: E402

ARCHIVED_BODY = '{"error":"This chat is archived","code":"chat_archived"}'


def archived() -> ApiError:
    return ApiError(f"Emperor API POST /messages/send failed 409: {ARCHIVED_BODY}", 409, ARCHIVED_BODY)


async def no_sleep(_s):
    return None


class Ledger:
    def __init__(self):
        self.finished: list[tuple[str, dict]] = []

    async def finish(self, run_id, payload):
        self.finished.append((run_id, dict(payload)))


class Client:
    def __init__(self, failures):
        self.failures = list(failures)
        self.sent: list[dict] = []
        self.statuses: list[dict] = []

    async def send_message(self, body, idempotency_key=None, **_kw):
        self.sent.append(dict(body))
        if self.failures:
            raise self.failures.pop(0)
        return "reply-1"

    async def chat_status(self, thread_id, **kwargs):
        self.statuses.append({"threadId": thread_id, **kwargs})


class ChatArchivedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.box = Outbox(Path(self.tmp.name) / "outbox", max_attempts=3, sleep=no_sleep,
                          logger=logging.getLogger("test"))

    def tearDown(self):
        self.tmp.cleanup()

    def desk(self, client, ledger):
        return ReplyDesk(client=client, outbox=self.box, ledger=ledger, data={}, save=no_sleep, agent_id="a1",
                         retry=None, llm_model="m", drop_goal_step=lambda: None, spawn=lambda _c: None,
                         logger=logging.getLogger("test"))

    def entry(self, mid="m1"):
        return build_entry(message_id=mid, thread_id="t-archived", agent_id="a1", text="answer",
                           idempotency_key=f"emp-{mid}", ledger_finish={"run_id": "r1", "payload": {"status": "succeeded"}})

    def test_classification(self):
        self.assertTrue(is_chat_archived(archived()))
        self.assertFalse(is_chat_archived(ApiError("conflict", 409, '{"error":"run-id conflict"}')))
        self.assertFalse(is_chat_archived(ApiError("x", 404, ARCHIVED_BODY)))
        self.assertFalse(is_chat_archived(ValueError("chat_archived")))

    def test_inline_delivery_drops_without_retrying_and_settles_the_run(self):
        client, ledger = Client([archived(), archived(), archived()]), Ledger()
        desk = self.desk(client, ledger)
        entry = self.box.put(self.entry())
        reply = asyncio.run(self.box.deliver(entry, desk.send, desk.on_delivered, attempts=3,
                                             on_dropped=desk.on_dropped))
        self.assertIsNone(reply)
        self.assertEqual(len(client.sent), 1, "one POST, no retry")
        self.assertFalse(self.box.has_parked("m1"), "nothing left to flush")
        self.assertFalse(self.box.path_for("m1").with_suffix(".failed").exists(), "nothing for redeliver either")
        self.assertEqual(ledger.finished, [("r1", {"status": "succeeded"})], "the run is settled as it ended")
        self.assertEqual(client.statuses[-1]["execution_state"], "cancelled")
        self.assertEqual(client.statuses[-1]["reason"], "chat_archived")

    def test_flush_drops_a_parked_reply_once(self):
        client, ledger = Client([archived()]), Ledger()
        desk = self.desk(client, ledger)
        given_up: list[str] = []

        async def on_given_up(entry):
            given_up.append(entry["message_id"])
        self.box.put(self.entry())
        asyncio.run(self.box.flush(desk.send, desk.on_delivered, on_given_up, on_dropped=desk.on_dropped))
        asyncio.run(self.box.flush(desk.send, desk.on_delivered, on_given_up, on_dropped=desk.on_dropped))
        self.assertEqual(len(client.sent), 1, "the second flush finds nothing to send")
        self.assertEqual(given_up, [], "a drop is not a give-up")
        self.assertEqual(len(ledger.finished), 1)

    def test_other_refusals_still_spend_the_budget(self):
        client, ledger = Client([ApiError("forbidden", 403, '{"error":"Access denied"}')]), Ledger()
        desk = self.desk(client, ledger)

        async def on_given_up(_entry):
            return None
        self.box.put(self.entry())
        asyncio.run(self.box.flush(desk.send, desk.on_delivered, on_given_up, on_dropped=desk.on_dropped))
        stored = json.loads(self.box.path_for("m1").read_text())
        self.assertEqual(stored["hard_attempts"], 1, "kept and retried later, as before")
        self.assertEqual(ledger.finished, [])


if __name__ == "__main__":
    unittest.main()
