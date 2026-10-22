"""
Tests for the Hermes bridge run-ledger reporting (PR 3).

Covers:
- Capability gating (`runs: 1`): no ledger calls on an older server
- Status mapping (success / timeout / cancelled / blocked / failed)
- Payload shape for start and finish
- Best-effort behavior: ledger failures never raise and are retried once
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BRIDGE_DIR = Path(__file__).resolve().parent.parent / "integrations" / "hermes" / "emperor-claw" / "bridge"
sys.path.insert(0, str(BRIDGE_DIR))

os.environ.setdefault("EMPEROR_CLAW_API_TOKEN", "test-token")
os.environ.setdefault("EMPEROR_CLAW_API_URL", "http://localhost:3000/api/mcp")
os.environ.setdefault("EMPEROR_CLAW_AGENT_NAME", "TestAgent")
os.environ.setdefault("EMPEROR_CLAW_AGENT_ID", "test-agent-id")
os.environ.setdefault("EMPEROR_CLAW_AGENT_ROLE", "Tester")
os.environ.setdefault("EMPEROR_CLAW_RUNTIME_ID", "test-runtime-1")
os.environ.setdefault("EMPEROR_CLAW_HERMES_STATE_PATH", str(Path(tempfile.gettempdir()) / "test-run-ledger-state.json"))

import emperor_hermes_bridge as bridge
import emperor_goals

patch.object(emperor_goals, "process_commands", return_value=False).start()
patch.object(emperor_goals, "run_next", return_value=None).start()
patch.object(emperor_goals, "record_external_turn", return_value=None).start()


class TestCapabilityGating(unittest.TestCase):
    def setUp(self):
        self._saved = list(bridge._server_capabilities)

    def tearDown(self):
        bridge._server_capabilities = self._saved

    def test_older_server_without_capability_disables_reporting(self):
        bridge._server_capabilities = ["rich-blocks-v1"]
        self.assertFalse(bridge.server_supports_runs())

    def test_server_with_capability_enables_reporting(self):
        bridge._server_capabilities = ["rich-blocks-v1", "runs: 1"]
        self.assertTrue(bridge.server_supports_runs())

    def test_parse_keeps_the_runs_capability_token(self):
        caps, _ = bridge.parse_server_capabilities({"serverCapabilities": ["rich-blocks-v1", "runs: 1"]})
        self.assertIn("runs: 1", caps)
        bridge._server_capabilities = caps
        self.assertTrue(bridge.server_supports_runs())


class TestStatusMapping(unittest.TestCase):
    def test_clean_turn_succeeds(self):
        self.assertEqual(bridge.map_run_status(None), "succeeded")

    def test_idle_and_wall_clock_timeouts_map_to_timeout(self):
        self.assertEqual(bridge.map_run_status(bridge.HermesIdleTimeout(["hermes"], 900)), "timeout")
        self.assertEqual(bridge.map_run_status(subprocess.TimeoutExpired(["hermes"], 600)), "timeout")

    def test_operator_stop_maps_to_cancelled(self):
        self.assertEqual(bridge.map_run_status(bridge.TurnInterrupted("stopped")), "cancelled")

    def test_any_other_exception_maps_to_failed(self):
        self.assertEqual(bridge.map_run_status(RuntimeError("boom")), "failed")

    def test_timeout_only_uses_the_sanctioned_short_description(self):
        exc = subprocess.TimeoutExpired(["hermes", "-q", "private prompt"], 600)
        self.assertEqual(bridge.describe_processing_error(exc), "Hermes turn timed out after 600 seconds")


class TestPayloads(unittest.TestCase):
    def test_start_payload_shape(self):
        payload = bridge.build_run_start_payload(
            "run-1", {"id": "msg-1", "threadId": "thread-1", "taskId": "task-1"}, 1_700_000_000.0
        )
        self.assertEqual(payload["id"], "run-1")
        self.assertEqual(payload["agentId"], bridge.AGENT_ID)
        self.assertEqual(payload["runtimeId"], bridge.RUNTIME_ID)
        self.assertEqual(payload["runtimeKind"], "hermes")
        self.assertEqual(payload["bridgeVersion"], bridge.BRIDGE_VERSION)
        self.assertEqual(payload["triggerKind"], "message")
        self.assertEqual(payload["triggerMessageId"], "msg-1")
        self.assertEqual(payload["threadId"], "thread-1")
        self.assertEqual(payload["taskId"], "task-1")
        self.assertIn("startedAt", payload)

    def test_start_payload_omits_absent_optional_ids(self):
        payload = bridge.build_run_start_payload("run-2", {"id": "msg-2"}, 1_700_000_000.0)
        self.assertNotIn("threadId", payload)
        self.assertNotIn("taskId", payload)

    def test_finish_payload_shape(self):
        payload = bridge.build_run_finish_payload(
            "succeeded",
            1_000.0,
            ended_at=1_002.5,
            reply_message_id="reply-1",
            input_tokens=3,
            output_tokens=4,
            tool_calls=2,
        )
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["durationMs"], 2500)
        self.assertEqual(payload["replyMessageId"], "reply-1")
        self.assertEqual(payload["inputTokens"], 3)
        self.assertEqual(payload["outputTokens"], 4)
        self.assertEqual(payload["toolCalls"], 2)
        self.assertIn("endedAt", payload)

    def test_finish_payload_omits_unset_fields(self):
        payload = bridge.build_run_finish_payload("failed", 1_000.0, ended_at=1_001.0)
        for key in ("toolCalls", "replyMessageId", "error", "inputTokens", "outputTokens"):
            self.assertNotIn(key, payload)

    def test_token_estimate_matches_report_usage_scale(self):
        self.assertEqual(bridge.estimate_run_tokens(0), 0)
        self.assertEqual(bridge.estimate_run_tokens(8), 2)


class TestBestEffort(unittest.TestCase):
    def setUp(self):
        self._saved_breaker = bridge._ledger_breaker
        bridge._ledger_breaker = bridge.LedgerBreaker()
        bridge._pending_run_finish = None
        bridge._ledger_failure_logged = False

    def tearDown(self):
        bridge._ledger_breaker = self._saved_breaker
        bridge._pending_run_finish = None
        bridge._ledger_failure_logged = False

    def test_start_failure_is_swallowed_and_logged_once(self):
        with patch.object(bridge, "api", side_effect=RuntimeError("offline")):
            self.assertFalse(bridge.post_run_start({"id": "run-1"}))
            self.assertFalse(bridge.post_run_start({"id": "run-2"}))
        self.assertTrue(bridge._ledger_failure_logged)

    def test_finish_failure_queues_exactly_one_retry(self):
        calls = []

        def fake_api(method, path, body=None, query=None, timeout=30):
            calls.append((method, path))
            if len(calls) == 1:
                raise RuntimeError("offline")
            return {}

        with patch.object(bridge, "api", side_effect=fake_api):
            bridge.post_run_finish("run-9", {"status": "succeeded"})
            self.assertIsNotNone(bridge._pending_run_finish)
            bridge.retry_pending_run_finish()

        self.assertIsNone(bridge._pending_run_finish)
        self.assertEqual([path for _, path in calls], ["/agents/runs/run-9", "/agents/runs/run-9"])

    def test_failed_retry_is_dropped_not_retried_forever(self):
        with patch.object(bridge, "api", side_effect=RuntimeError("offline")) as api:
            bridge.post_run_finish("run-8", {"status": "failed"})
            self.assertIsNotNone(bridge._pending_run_finish)
            bridge.retry_pending_run_finish()
        self.assertIsNone(bridge._pending_run_finish)
        self.assertEqual(api.call_count, 2)

    def test_4xx_finish_is_never_retried(self):
        exc = bridge.ApiError("Emperor API PATCH /agents/runs/run-7 failed 422: bad", 422)
        with patch.object(bridge, "api", side_effect=exc) as api:
            bridge.post_run_finish("run-7", {"status": "failed"})
        self.assertIsNone(bridge._pending_run_finish)
        self.assertEqual(api.call_count, 1)

    def test_ledger_calls_use_the_short_timeout(self):
        seen = {}

        def fake_api(method, path, body=None, query=None, timeout=30):
            seen["timeout"] = timeout
            return {}

        with patch.object(bridge, "api", side_effect=fake_api):
            bridge.post_run_start({"id": "run-1"})
        self.assertEqual(seen["timeout"], bridge.LEDGER_TIMEOUT_SECONDS)


class TestLedgerBreaker(unittest.TestCase):
    def test_opens_after_three_failures_skips_while_open_and_closes_after_window(self):
        clock = [1_000_000.0]
        events = []
        breaker = bridge.LedgerBreaker(
            now=lambda: clock[0],
            # Redirect the transition logs so the test can assert they fire once.
        )
        # Spy on the transition logs.
        original_log = bridge.log
        bridge.log = lambda message: events.append(message)
        try:
            breaker.record_failure()
            breaker.record_failure()
            self.assertFalse(breaker.should_skip())
            self.assertEqual(events, [])
            breaker.record_failure()
            self.assertTrue(breaker.should_skip())
            self.assertEqual(len(events), 1)
            self.assertIn("open", events[0])
            # While open everything is skipped and nothing is re-logged.
            clock[0] += bridge.LEDGER_BREAKER_COOLDOWN_SECONDS - 1
            self.assertTrue(breaker.should_skip())
            self.assertEqual(len(events), 1)
            # The window elapsing closes once.
            clock[0] += 2
            self.assertFalse(breaker.should_skip())
            self.assertEqual(len(events), 2)
            self.assertIn("closed", events[1])
        finally:
            bridge.log = original_log

    def test_success_resets_the_consecutive_failure_count(self):
        clock = [0.0]
        breaker = bridge.LedgerBreaker(now=lambda: clock[0])
        breaker.record_failure()
        breaker.record_failure()
        breaker.record_success()
        breaker.record_failure()
        self.assertFalse(breaker.should_skip())

    def test_open_breaker_skips_every_ledger_call(self):
        clock = [0.0]
        breaker = bridge.LedgerBreaker(now=lambda: clock[0])
        for _ in range(bridge.LEDGER_BREAKER_THRESHOLD):
            breaker.record_failure()
        saved = bridge._ledger_breaker
        bridge._ledger_breaker = breaker
        calls = []
        try:
            with patch.object(bridge, "api", side_effect=lambda *a, **k: calls.append(a) or {}):
                self.assertFalse(bridge.post_run_start({"id": "run-1"}))
                bridge.post_run_finish("run-1", {"status": "succeeded"})
                bridge._pending_run_finish = {"id": "run-1", "payload": {}}
                bridge.retry_pending_run_finish()
                self.assertEqual(calls, [])
                self.assertIsNone(bridge._pending_run_finish)
        finally:
            bridge._ledger_breaker = saved


class TestLedgerIsInvisible(unittest.TestCase):
    """The GOLDEN RULE: a ledger fault must not change message handling."""

    def _dispatch(self, patch_count_tool_calls=None):
        from contextlib import ExitStack

        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z", "retries": {}}
        message = {"id": "msg-1", "text": "hello", "senderType": "human",
                   "targetAgentId": bridge.AGENT_ID, "threadType": "direct",
                   "deliveryState": "queued"}
        send_reply = Mock(return_value="stored-msg-1")
        update_status = Mock()

        saved_caps = list(bridge._server_capabilities)
        saved_breaker = bridge._ledger_breaker
        bridge._server_capabilities = ["runs: 1"]
        bridge._ledger_breaker = bridge.LedgerBreaker()
        bridge._pending_run_finish = None
        bridge._ledger_failure_logged = False
        try:
            with ExitStack() as stack:
                for name in ["ensure_runtime", "send_heartbeat", "save_state",
                             "report_token_usage", "post_reasoning_history"]:
                    stack.enter_context(patch.object(bridge, name))
                stack.enter_context(patch.object(bridge, "api", return_value={}))
                stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
                stack.enter_context(patch.object(bridge, "load_state", return_value=state))
                stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
                stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
                stack.enter_context(patch.object(bridge, "check_budget", return_value=True))
                stack.enter_context(patch.object(bridge, "check_loop_guard", return_value=True))
                stack.enter_context(patch.object(bridge, "run_hermes", return_value="the real answer"))
                stack.enter_context(patch.object(bridge, "send_reply", send_reply))
                stack.enter_context(patch.object(bridge, "update_chat_status", update_status))
                if patch_count_tool_calls is not None:
                    stack.enter_context(patch.object(bridge, "count_tool_calls", side_effect=patch_count_tool_calls))
                stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
                with self.assertRaises(KeyboardInterrupt):
                    bridge.main()
        finally:
            bridge._server_capabilities = saved_caps
            bridge._ledger_breaker = saved_breaker
            bridge._pending_run_finish = None
            bridge._ledger_failure_logged = False
        return state, send_reply, update_status

    def test_count_tool_calls_failure_does_not_requeue_or_resend_the_reply(self):
        state, send_reply, update_status = self._dispatch(
            patch_count_tool_calls=RuntimeError("cannot read agent.log")
        )
        # The reply is sent exactly once (no error reply, no re-send).
        self.assertEqual(send_reply.call_count, 1)
        # The turn still resolves; it is never requeued.
        resolved = [c for c in update_status.call_args_list if c.kwargs.get("execution_state") == "resolved"]
        queued = [c for c in update_status.call_args_list if c.kwargs.get("execution_state") == "queued"]
        self.assertEqual(len(resolved), 1)
        self.assertEqual(queued, [])
        # And the message is remembered seen, not left for retry.
        self.assertIn("msg-1", state.get("seen") or [])
        self.assertEqual(bridge.retry_entries(state), {})


class TestMainLoopLedger(unittest.TestCase):
    """Integration: start/finish wrap exactly one dispatched turn, gated."""

    def _dispatch_one(self, capabilities):
        from contextlib import ExitStack

        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}
        message = {"id": "msg-1", "text": "hello", "senderType": "human",
                   "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}
        calls = []

        def fake_api(method, path, body=None, query=None, timeout=30):
            calls.append((method, path, body))
            return {}

        saved_caps = list(bridge._server_capabilities)
        saved_breaker = bridge._ledger_breaker
        bridge._server_capabilities = capabilities
        bridge._ledger_breaker = bridge.LedgerBreaker()
        bridge._pending_run_finish = None
        bridge._ledger_failure_logged = False
        try:
            with ExitStack() as stack:
                for name in ["ensure_runtime", "send_heartbeat", "save_state",
                             "update_chat_status", "report_token_usage", "post_reasoning_history"]:
                    stack.enter_context(patch.object(bridge, name))
                stack.enter_context(patch.object(bridge, "api", side_effect=fake_api))
                stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
                stack.enter_context(patch.object(bridge, "load_state", return_value=state))
                stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
                stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
                stack.enter_context(patch.object(bridge, "check_budget", return_value=True))
                stack.enter_context(patch.object(bridge, "check_loop_guard", return_value=True))
                stack.enter_context(patch.object(bridge, "run_hermes", return_value="the real answer"))
                stack.enter_context(patch.object(bridge, "send_reply", return_value="stored-msg-1"))
                stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
                with self.assertRaises(KeyboardInterrupt):
                    bridge.main()
        finally:
            bridge._server_capabilities = saved_caps
            bridge._ledger_breaker = saved_breaker
            bridge._pending_run_finish = None
            bridge._ledger_failure_logged = False
        return calls

    def test_no_ledger_calls_without_the_capability(self):
        calls = self._dispatch_one([])
        ledger = [c for c in calls if "runs" in str(c[1])]
        self.assertEqual(ledger, [])

    def test_start_and_finish_wrap_the_turn_with_the_capability(self):
        calls = self._dispatch_one(["runs: 1"])
        starts = [c for c in calls if c[0] == "POST" and c[1] == "/agents/runs"]
        finishes = [c for c in calls if c[0] == "PATCH" and c[1].startswith("/agents/runs/")]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(finishes), 1)
        run_id = starts[0][2]["id"]
        self.assertEqual(finishes[0][1], f"/agents/runs/{run_id}")
        self.assertEqual(starts[0][2]["runtimeKind"], "hermes")
        self.assertEqual(finishes[0][2]["status"], "succeeded")
        self.assertEqual(finishes[0][2]["replyMessageId"], "stored-msg-1")


class TestLedgerPrivacyAndUsage(unittest.TestCase):
    def test_error_is_a_classification_never_exception_text(self):
        exc = RuntimeError("API credentials received: key=sk-live-123 secret reply text")
        self.assertEqual(bridge.ledger_error_message(exc), "RuntimeError")
        failed = subprocess.CalledProcessError(2, ["hermes", "chat", "-q", "prompt text"])
        self.assertEqual(bridge.ledger_error_message(failed), "Hermes exited with status 2")

    def test_sum_api_usage_reads_real_tokens_for_this_turn_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "agent.log"
            log.write_text(
                "2026-10-13 10:00:00,001 INFO [s1] agent.conversation_loop: API call #1: model=m provider=p in=1000 out=50 total=1050\n"
                "2026-10-13 10:05:00,001 INFO [s1] agent.conversation_loop: API call #1: model=m provider=p in=80000 out=300 total=80300\n"
                "2026-10-13 10:05:09,001 INFO [s1] agent.tool_executor: tool web_search completed (0.20s, 10 chars)\n"
                "2026-10-13 10:05:10,001 INFO [s1] agent.conversation_loop: API call #2: model=m provider=p in=81000 out=120 total=81120\n",
                encoding="utf-8",
            )
            since = __import__("time").mktime(__import__("time").strptime("2026-10-13 10:04:00", "%Y-%m-%d %H:%M:%S"))
            with patch.object(bridge, "_agent_log_path", return_value=log):
                self.assertEqual(bridge.sum_api_usage(since, session_id="s1"), (161000, 420))
                self.assertIsNone(bridge.sum_api_usage(since + 3600, session_id="s1"))
                self.assertIsNone(bridge.sum_api_usage(since), "no session id: no attribution")


if __name__ == "__main__":
    unittest.main()
