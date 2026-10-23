"""Run ledger of bridge 0.9: capability gating, status mapping, payloads from the receipt usage
(D16, run-usage 2), best-effort reporting with one retry, the circuit breaker and privacy.

Deleted with 0.3: agent.log usage scraping and the chars/4 token estimate.
"""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/bridge"))

from emperor_bridge.emperor_api import ApiError  # noqa: E402
from emperor_bridge.interfaces import SessionPolicy, Turn, TurnOutcome, TurnResult, UsageLedger  # noqa: E402
from emperor_bridge.ledger import (LedgerBreaker, RunLedger, finish_payload, flush_usage, start_payload,  # noqa: E402
                                   usage_report)

POLICY = SessionPolicy(system_prompt="x")


def run(coro):
    return asyncio.run(coro)


def turn(**kw):
    base = dict(thread_id="t1", trigger_id="m1", text="hi", api_text="hi", policy=POLICY, message_ids=("m0", "m1"))
    return Turn(**{**base, **kw})


def result(outcome=TurnOutcome.COMPLETED, **kw):
    usage = UsageLedger(input_tokens=1200, output_tokens=80, cache_read_tokens=1000, cache_write_tokens=5,
                        reasoning_tokens=7, api_calls=2, model="deepseek-chat", provider="deepseek",
                        cost_status="estimated", estimated_cost_usd=0.0123)
    return TurnResult(**{**dict(outcome=outcome, final_text="ok", usage=usage, exit_reason="text_response(finish_reason=stop)",
                                duration_ms=1500, queue_ms=20, first_token_ms=300, tool_calls=3), **kw})


class Recorder:
    def __init__(self, fail=None):
        self.calls, self.fail = [], list(fail or [])

    async def __call__(self, method, path, body=None, query=None, **kw):
        self.calls.append((method, path, body, kw))
        if self.fail:
            raise self.fail.pop(0)
        return {"ok": True}


class TestCapabilityGating(unittest.TestCase):
    def test_older_server_without_capability_disables_reporting(self):
        rec = Recorder()
        ledger = RunLedger(rec, capabilities=lambda: frozenset())
        self.assertFalse(ledger.enabled)
        self.assertFalse(run(ledger.finish("r", {"status": "succeeded"})))
        self.assertEqual(rec.calls, [])

    def test_run_events_server_needs_no_start_post(self):
        ledger = RunLedger(Recorder(), capabilities=lambda: frozenset({"run-events: 1", "runs: 1"}))
        self.assertTrue(ledger.enabled)
        self.assertFalse(ledger.needs_start_post)

    def test_runs_only_server_gets_the_start_post(self):
        rec = Recorder()
        ledger = RunLedger(rec, capabilities=lambda: frozenset({"runs: 1"}))
        self.assertTrue(run(ledger.start({"id": "r"})))
        self.assertEqual(rec.calls[0][:2], ("POST", "/agents/runs"))


class TestStatusMapping(unittest.TestCase):
    def test_outcomes_map_to_finish_statuses(self):
        self.assertEqual({o: o.ledger_status for o in TurnOutcome},
                         {TurnOutcome.COMPLETED: "succeeded", TurnOutcome.CANCELLED: "cancelled",
                          TurnOutcome.FAILED: "failed", TurnOutcome.TIMEOUT: "timeout"})

    def test_cancel_and_success_carry_no_error(self):
        self.assertNotIn("error", finish_payload(result(TurnOutcome.CANCELLED)))
        self.assertNotIn("error", finish_payload(result()))
        self.assertEqual(finish_payload(result(TurnOutcome.TIMEOUT, error_code="idle_timeout"))["error"], "idle_timeout")


class TestPayloads(unittest.TestCase):
    def test_start_payload_shape(self):
        payload = start_payload(turn(), agent_id="a1", runtime_id="rt", bridge_version="0.9.0", started_at=0)
        self.assertEqual(payload["id"], turn().run_id)
        self.assertEqual(payload["triggerMessageId"], "m1")
        self.assertEqual(payload["triggerKind"], "message")
        self.assertEqual(payload["runtimeKind"], "hermes")
        self.assertEqual(payload["startedAt"], "1970-01-01T00:00:00.000Z")

    def test_objective_start_has_no_trigger_message(self):
        payload = start_payload(turn(trigger_kind="objective", message_ids=()), agent_id="a", runtime_id="r",
                                bridge_version="0.9.0", started_at=0)
        self.assertEqual(payload["triggerKind"], "objective")
        self.assertNotIn("triggerMessageId", payload)

    def test_finish_payload_uses_the_receipt_usage(self):
        payload = finish_payload(result(), reply_message_id="rep", events_dropped=4, compactions=1)
        expected = {"status": "succeeded", "inputTokens": 1200, "outputTokens": 80, "cacheReadTokens": 1000,
                    "cacheWriteTokens": 5, "reasoningTokens": 7, "apiCalls": 2, "model": "deepseek-chat",
                    "provider": "deepseek", "costCents": 1, "toolCalls": 3, "queueMs": 20, "firstTokenMs": 300,
                    "durationMs": 1500, "replyMessageId": "rep", "eventsDropped": 4, "compactions": 1,
                    "exitReason": "text_response(finish_reason=stop)"}
        for key, value in expected.items():
            self.assertEqual(payload[key], value, key)

    def test_unknown_cost_is_left_to_the_server_and_unset_fields_are_omitted(self):
        bare = TurnResult(outcome=TurnOutcome.FAILED, final_text="", usage=UsageLedger(cost_status="unknown",
                                                                                         estimated_cost_usd=1.0))
        payload = finish_payload(bare)
        self.assertNotIn("costCents", payload)
        self.assertNotIn("inputTokens", payload)
        self.assertNotIn("eventsDropped", payload)

    def test_exit_reason_is_capped(self):
        self.assertEqual(len(finish_payload(result(exit_reason="x" * 500))["exitReason"]), 120)


class TestBestEffort(unittest.TestCase):
    def ledger(self, rec):
        return RunLedger(rec, capabilities=lambda: frozenset({"run-events: 1"}))

    def test_finish_failure_queues_exactly_one_retry(self):
        rec = Recorder([TimeoutError("slow")])
        ledger = self.ledger(rec)
        self.assertFalse(run(ledger.finish("r1", {"status": "succeeded"})))
        run(ledger.retry_pending())
        run(ledger.retry_pending())
        self.assertEqual([c[:2] for c in rec.calls], [("PATCH", "/agents/runs/r1")] * 2)

    def test_failed_retry_is_dropped_not_retried_forever(self):
        rec = Recorder([TimeoutError("a"), TimeoutError("b")])
        ledger = self.ledger(rec)
        run(ledger.finish("r1", {}))
        run(ledger.retry_pending())
        run(ledger.retry_pending())
        self.assertEqual(len(rec.calls), 2)

    def test_4xx_finish_is_never_retried(self):
        rec = Recorder([ApiError("bad", 400)])
        ledger = self.ledger(rec)
        run(ledger.finish("r1", {}))
        run(ledger.retry_pending())
        self.assertEqual(len(rec.calls), 1)

    def test_ledger_calls_use_the_short_timeout(self):
        rec = Recorder()
        run(self.ledger(rec).finish("r1", {}))
        self.assertEqual(rec.calls[0][3]["timeout"], 5)


class TestLedgerBreaker(unittest.TestCase):
    def test_opens_after_three_failures_and_closes_after_the_window(self):
        now = [0.0]
        breaker = LedgerBreaker(now=lambda: now[0])
        for _ in range(3):
            breaker.record_failure()
        self.assertTrue(breaker.should_skip())
        now[0] = 301
        self.assertFalse(breaker.should_skip())
        self.assertFalse(breaker.open)

    def test_success_resets_the_count(self):
        breaker = LedgerBreaker(now=lambda: 0)
        breaker.record_failure()
        breaker.record_failure()
        breaker.record_success()
        breaker.record_failure()
        self.assertFalse(breaker.should_skip())

    def test_open_breaker_skips_every_call(self):
        rec = Recorder([TimeoutError()] * 3)
        ledger = RunLedger(rec, capabilities=lambda: frozenset({"run-events: 1"}))
        for i in range(5):
            run(ledger.finish(f"r{i}", {}))
        self.assertEqual(len(rec.calls), 3)


class TestUsageAndPrivacy(unittest.TestCase):
    def test_error_is_a_classification_never_model_text(self):
        failed = result(TurnOutcome.FAILED, error_code="hermes_failed", failure_reason="sk-secret leaked output")
        self.assertEqual(finish_payload(failed)["error"], "hermes_failed")

    def test_usage_report_from_the_receipt(self):
        body = usage_report("a1", result())
        self.assertEqual(body, {"agentId": "a1", "inputTokens": 1200, "outputTokens": 80, "model": "deepseek-chat",
                                "costCents": 1})
        self.assertIsNone(usage_report("a1", TurnResult(outcome=TurnOutcome.FAILED, final_text="", usage=UsageLedger())))

    def test_usage_flush_keeps_reports_during_an_outage(self):
        pending = [{"a": 1}, {"b": 2}]
        self.assertEqual(run(flush_usage(Recorder([ConnectionError()]), pending)), 0)
        self.assertEqual(len(pending), 2)
        self.assertEqual(run(flush_usage(Recorder([ApiError("no", 400)]), pending)), 1)
        self.assertEqual(pending, [])


if __name__ == "__main__":
    unittest.main()
