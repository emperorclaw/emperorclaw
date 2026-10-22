"""
Tests for Hermes bridge reliability on a flaky network and per-turn latency.

Covers:
- A1: a transport failure while Hermes runs never abandons the live turn
- A2: environment waits never spend the poison-prompt attempt budget
- A3: environment failures never cancel a human message; a real give-up is
      announced in the thread (humans only)
- Outbox: delivery goes through send_reply, keeps the stored id for the run
  ledger, and never gives up on transport errors
- B1: the static block is reused for resumed sessions and refreshed lazily
- B2: independent pre-dispatch calls run concurrently with sequential semantics
- B3: one timing line per turn
- C2: the "acknowledge first" reminder rides only on human-originated turns
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from contextlib import ExitStack
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
os.environ.setdefault("EMPEROR_CLAW_HERMES_STATE_PATH", str(Path(tempfile.gettempdir()) / "test-latency-state.json"))

import emperor_hermes_bridge as bridge
import emperor_goals

patch.object(emperor_goals, "process_commands", return_value=False).start()
patch.object(emperor_goals, "run_next", return_value=None).start()
patch.object(emperor_goals, "record_external_turn", return_value=None).start()

NETWORK_DOWN = urllib.error.URLError(socket.gaierror(-3, "Temporary failure in name resolution"))


class TestTransportFailureKeepsTheTurn(unittest.TestCase):
    """A1: the 2026-10 failure chain started with the bridge walking away from
    a live Hermes process because a status ping failed."""

    def test_network_down_during_turn_keeps_waiting_for_hermes(self):
        with patch.object(bridge, "api", side_effect=NETWORK_DOWN), \
             patch.object(bridge, "HERMES_TIMEOUT_SECONDS", 0), \
             patch.object(bridge, "HERMES_IDLE_TIMEOUT_SECONDS", 0), \
             patch.object(bridge, "log"):
            done = bridge.invoke_hermes(
                [sys.executable, "-c", "import time; time.sleep(1.2); print('the answer')"],
                {"id": "m1", "threadId": "t1"},
                state={},
            )
        self.assertEqual(done.returncode, 0)
        self.assertIn("the answer", done.stdout)

    def test_abnormal_exit_never_leaves_hermes_running(self):
        real_sleep = time.sleep
        real_popen = subprocess.Popen
        procs = []

        def launch(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            procs.append(proc)
            return proc

        def sleep(seconds):
            if seconds == 0.5:
                raise KeyboardInterrupt
            real_sleep(seconds)

        with patch.object(bridge.subprocess, "Popen", side_effect=launch), \
             patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "HERMES_TIMEOUT_GRACE_SECONDS", 1), \
             patch.object(bridge, "log"), \
             patch.object(bridge.time, "sleep", side_effect=sleep):
            with self.assertRaises(KeyboardInterrupt):
                bridge.invoke_hermes([sys.executable, "-c", "import time; time.sleep(30)"], {"id": "m1"}, state={})
        procs[0].wait(timeout=10)
        self.assertIsNotNone(procs[0].returncode)

    def test_turn_env_carries_the_triggering_message(self):
        captured = {}
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            captured.update(kwargs["env"])
            return real_popen(*args, **kwargs)

        with patch.object(bridge.subprocess, "Popen", side_effect=launch), \
             patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "log"):
            bridge.invoke_hermes([sys.executable, "-c", "pass"], {"id": "m9", "threadId": "t9", "threadType": "direct"}, state={})
        self.assertEqual(captured["EMPEROR_CLAW_TURN_MESSAGE_ID"], "m9")
        self.assertEqual(captured["EMPEROR_CLAW_TURN_THREAD_ID"], "t9")
        self.assertEqual(captured["EMPEROR_CLAW_TURN_THREAD_TYPE"], "direct")
        self.assertIn("spawnedAt", bridge._turn_timing)


class TestFailureClassification(unittest.TestCase):
    def test_environment_failures(self):
        for exc in (
            bridge.SessionBusy("SESSION_NOT_OWNED"),
            NETWORK_DOWN,
            ConnectionResetError("reset by peer"),
            bridge.ApiError("Emperor API GET /x failed 502: bad gateway", 502),
            bridge.ApiError("Emperor API GET /x failed 429: slow down", 429),
            RuntimeError("hermes-refusal-reason: SESSION_NOT_OWNED"),
            RuntimeError("Temporary failure in name resolution"),
        ):
            self.assertTrue(bridge.is_environment_failure(exc), exc)

    def test_genuine_hermes_failures(self):
        for exc in (
            RuntimeError("model said no"),
            bridge.HermesIdleTimeout(["hermes"], 900),
            subprocess.TimeoutExpired(["hermes"], 600),  # its text says "timed out"
            subprocess.CalledProcessError(1, ["hermes"]),
            bridge.ApiError("Emperor API POST /x failed 400: bad", 400),
        ):
            self.assertFalse(bridge.is_environment_failure(exc), exc)

    def test_busy_wait_does_not_spend_attempts(self):
        state = {"retries": {"m1": {"attempts": bridge.MAX_RETRY_ATTEMPTS - 1, "nextRetryAt": 0}}}
        self.assertEqual(bridge.schedule_retry(state, "m1", now=100, busy=True), 1)
        self.assertEqual(bridge.schedule_retry(state, "m1", now=200, busy=True), 2)
        entry = state["retries"]["m1"]
        self.assertEqual(entry["attempts"], bridge.MAX_RETRY_ATTEMPTS - 1)
        self.assertEqual(entry["busyMisses"], 2)
        self.assertEqual(bridge.schedule_retry(state, "m1", now=300), bridge.MAX_RETRY_ATTEMPTS)


class MainLoopHarness(unittest.TestCase):
    def setUp(self):
        self._outbox = tempfile.TemporaryDirectory()
        self.addCleanup(self._outbox.cleanup)
        bridge._turn_timing.clear()

    def _main(self, message, *, state=None, run_hermes=None, send_reply=None, api=None, capabilities=None):
        state = state if state is not None else {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}
        status = Mock()
        send = send_reply or Mock(return_value="stored-1")
        saved_caps = list(bridge._server_capabilities)
        bridge._server_capabilities = capabilities or []
        bridge._ledger_breaker = bridge.LedgerBreaker()
        bridge._pending_run_finish = None
        try:
            with ExitStack() as stack:
                for name in ["ensure_runtime", "send_heartbeat", "save_state", "report_token_usage",
                             "post_reasoning_history", "reap_orphan_turns", "log"]:
                    stack.enter_context(patch.object(bridge, name))
                stack.enter_context(patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)))
                stack.enter_context(patch.object(bridge, "api", api or Mock(return_value={})))
                stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
                stack.enter_context(patch.object(bridge, "load_state", return_value=state))
                stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
                stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
                stack.enter_context(patch.object(bridge, "check_budget", return_value=True))
                stack.enter_context(patch.object(bridge, "check_loop_guard", return_value=True))
                stack.enter_context(patch.object(bridge, "run_hermes", run_hermes or Mock(return_value="the answer")))
                stack.enter_context(patch.object(bridge, "send_reply", send))
                stack.enter_context(patch.object(bridge, "update_chat_status", status))
                stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
                with self.assertRaises(KeyboardInterrupt):
                    bridge.main()
        finally:
            bridge._server_capabilities = saved_caps
            bridge._pending_run_finish = None
        return state, status, send


class TestNoHumanMessageLostToTheEnvironment(MainLoopHarness):
    """A2/A3 at the dispatch loop."""

    def _human(self, sender="human"):
        return {"id": "m1", "text": "hello", "senderType": sender, "threadId": "t1",
                "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}

    def _exhausted_state(self):
        return {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z",
                "retries": {"m1": {"attempts": bridge.MAX_RETRY_ATTEMPTS - 1, "nextRetryAt": 0}}}

    def _cancels(self, status):
        return [c for c in status.call_args_list if c.kwargs.get("execution_state") == "cancelled"]

    def test_environment_failure_on_the_last_attempt_never_cancels(self):
        for exc in (bridge.SessionBusy("SESSION_NOT_OWNED"), NETWORK_DOWN, bridge.ApiError("x failed 503", 503)):
            state, status, send = self._main(self._human(), state=self._exhausted_state(),
                                             run_hermes=Mock(side_effect=exc))
            self.assertEqual(self._cancels(status), [], exc)
            send.assert_not_called()
            entry = state["retries"]["m1"]
            self.assertEqual(entry["attempts"], bridge.MAX_RETRY_ATTEMPTS - 1)
            self.assertEqual(entry["busyMisses"], 1)
            self.assertNotIn("m1", state["seen"])

    def test_genuine_failure_gives_up_visibly_in_the_thread(self):
        state, status, send = self._main(self._human(), state=self._exhausted_state(),
                                         run_hermes=Mock(side_effect=RuntimeError("model crashed")))
        self.assertEqual(len(self._cancels(status)), 1)
        send.assert_called_once()
        notice = send.call_args.args[1]
        self.assertIn(f"after {bridge.MAX_RETRY_ATTEMPTS} attempts", notice)
        self.assertNotIn("model crashed", notice, "exception text never reaches the chat")
        self.assertIs(send.call_args.kwargs.get("transport_retry"), False)
        self.assertIn("m1", state["seen"])

    def test_agent_message_gives_up_without_a_notice(self):
        _, status, send = self._main(self._human(sender="agent"), state=self._exhausted_state(),
                                     run_hermes=Mock(side_effect=RuntimeError("model crashed")))
        self.assertEqual(len(self._cancels(status)), 1)
        send.assert_not_called()

    def test_dispatch_bookkeeping_failure_does_not_stop_the_turn(self):
        # The read receipt/typing/heartbeat all fail: the turn still runs and
        # the reply still lands.
        status = Mock(side_effect=NETWORK_DOWN)
        with patch.object(bridge, "update_chat_status", status):
            run = Mock(return_value="the answer")
            state, _, send = self._main(self._human(), run_hermes=run)
        run.assert_called_once()
        self.assertEqual([c.args[1] for c in send.call_args_list], ["the answer"])
        self.assertIn("m1", state["seen"])


class TestOutboxDelivery(MainLoopHarness):
    def _message(self):
        return {"id": "m1", "text": "hello", "senderType": "human", "threadId": "t1",
                "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}

    def test_deliver_reply_returns_the_stored_id_and_resolves_once(self):
        entry = bridge.outbox_entry(self._message(), "the answer")
        with patch.object(bridge, "send_reply", return_value="stored-1") as send, \
             patch.object(bridge, "update_chat_status") as status, \
             patch.object(bridge, "save_state"), \
             patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)), \
             patch.object(bridge, "log"):
            reply_id = bridge.deliver_reply(entry, {"seen": []})
        self.assertEqual(reply_id, "stored-1")
        target = send.call_args.args[0]
        self.assertEqual((target["id"], target["threadId"], target["threadType"]), ("m1", "t1", "direct"))
        resolved = [c for c in status.call_args_list if c.kwargs.get("execution_state") == "resolved"]
        self.assertEqual(len(resolved), 1)

    def test_parked_reply_finishes_the_run_with_the_stored_id_on_delivery(self):
        calls = []

        def fake_api(method, path, body=None, query=None, timeout=30, **_):
            calls.append((method, path, body))
            return {}

        failing = Mock(side_effect=NETWORK_DOWN)
        with patch.object(bridge, "OUTBOX_RETRY_BASE_SECONDS", 0):
            self._main(self._message(), send_reply=failing, api=Mock(side_effect=fake_api), capabilities=["runs: 1"])
        finishes = [c for c in calls if c[0] == "PATCH"]
        self.assertEqual(finishes, [], "the finish waits for the reply")
        parked = json.loads(next(Path(self._outbox.name).glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(parked["ledger_finish"]["payload"]["status"], "succeeded")

        with patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)), \
             patch.object(bridge, "send_reply", return_value="stored-late"), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "save_state"), \
             patch.object(bridge, "log"), \
             patch.object(bridge, "api", side_effect=fake_api):
            bridge._ledger_breaker = bridge.LedgerBreaker()
            parked["next_at"] = 0
            bridge._outbox_save(parked)
            self.assertEqual(bridge.flush_outbox({"seen": []}), 1)
        finishes = [c for c in calls if c[0] == "PATCH"]
        self.assertEqual(len(finishes), 1)
        self.assertEqual(finishes[0][2]["replyMessageId"], "stored-late")

    def test_outbox_never_gives_up_on_transport_errors(self):
        entry = bridge.outbox_entry(self._message(), "the answer")
        entry["attempts"] = bridge.OUTBOX_MAX_ATTEMPTS + 5
        with patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)), \
             patch.object(bridge, "send_reply", side_effect=NETWORK_DOWN), \
             patch.object(bridge, "update_chat_status") as status, \
             patch.object(bridge, "log"):
            bridge._outbox_save(entry)
            self.assertEqual(bridge.flush_outbox({"seen": []}), 0)
        self.assertEqual(list(Path(self._outbox.name).glob("*.failed")), [])
        status.assert_not_called()


class TestStaticBlockCache(unittest.TestCase):
    """B1: a resumed session reuses its primed hash instead of refetching."""

    def setUp(self):
        bridge._static_block_cache.clear()
        bridge._static_block_invalidated_at = 0.0

    def _run(self, state, build):
        stream = '{"type": "result", "session_id": "sess-1", "text": "ACK"}'
        completed = subprocess.CompletedProcess(["hermes"], 0, stream, "")
        with patch.object(bridge, "build_static_block", build), \
             patch.object(bridge, "build_dynamic_block", return_value="DYNAMIC"), \
             patch.object(bridge, "is_direct_thread", return_value=False), \
             patch.object(bridge, "turn_reasoning_history", return_value=None), \
             patch.object(bridge, "schedule_static_refresh") as refresh, \
             patch.object(bridge, "invoke_hermes", return_value=completed) as invoke:
            bridge.run_hermes({"threadId": "t1", "threadType": "team", "text": "hi"}, state)
        cmd = invoke.call_args.args[0]
        return cmd[cmd.index("-q") + 1], refresh

    def test_resumed_turn_does_not_rebuild(self):
        build = Mock(return_value="STATIC")
        state = {}
        prompt, _ = self._run(state, build)
        self.assertIn("STATIC", prompt)
        prompt, refresh = self._run(state, build)
        self.assertEqual(build.call_count, 1, "a resumed turn only needs the primed hash")
        self.assertEqual(prompt, "DYNAMIC")
        refresh.assert_not_called()

    def test_after_restart_reuses_hash_and_refreshes_in_background(self):
        build = Mock(return_value="STATIC")
        state = {}
        self._run(state, build)
        bridge._static_block_cache.clear()  # a restart forgets the block, not the hash
        prompt, refresh = self._run(state, build)
        self.assertEqual(build.call_count, 1)
        self.assertEqual(prompt, "DYNAMIC")
        refresh.assert_called_once()

    def test_changed_block_found_by_refresh_reprimes(self):
        build = Mock(return_value="STATIC")
        state = {}
        self._run(state, build)
        bridge._remember_static_block("TestAgent:t1", "STATIC-V2")
        prompt, _ = self._run(state, build)
        self.assertIn("STATIC-V2", prompt)
        self.assertEqual(state["primed"]["TestAgent:t1"]["staticHash"],
                         bridge.hashlib.sha256(b"STATIC-V2").hexdigest())

    def test_invalidation_forces_a_synchronous_rebuild(self):
        build = Mock(side_effect=["STATIC", "STATIC-NEW"])
        state = {}
        self._run(state, build)
        bridge.invalidate_static_block()
        prompt, _ = self._run(state, build)
        self.assertEqual(build.call_count, 2)
        self.assertIn("STATIC-NEW", prompt)

    def test_plan_is_pure_and_bounded_by_the_window(self):
        cached = {"hash": "h", "builtAt": 1000.0}
        plan = lambda **kw: bridge.plan_static_block(  # noqa: E731
            kw.get("primed", "h"), kw.get("cached", cached), now=kw.get("now", 1100.0),
            refresh_seconds=kw.get("window", 600.0), invalidated_at=kw.get("inv", 0.0), process_started_at=500.0,
        )
        self.assertEqual(plan(), "reuse")
        self.assertEqual(plan(now=1700.0), "refresh")
        self.assertEqual(plan(cached=None), "refresh")
        self.assertEqual(plan(cached={"hash": "other", "builtAt": 1000.0}), "changed")
        self.assertEqual(plan(inv=1050.0), "build")
        self.assertEqual(plan(primed=""), "build")
        self.assertEqual(plan(window=0.0), "build")


class TestParallelPredispatch(unittest.TestCase):
    """B2: overlap independent calls, keep sequential error semantics."""

    def test_calls_overlap(self):
        started = time.time()
        results = bridge.run_parallel({name: (lambda n=name: (time.sleep(0.3), n)[1]) for name in "abc"})
        self.assertEqual(results, {"a": "a", "b": "b", "c": "c"})
        self.assertLess(time.time() - started, 0.8)

    def test_first_failure_is_reraised_after_all_finish(self):
        done = []

        def slow():
            time.sleep(0.2)
            done.append("slow")
            return 1

        with self.assertRaises(ValueError):
            bridge.run_parallel({"bad": Mock(side_effect=ValueError("x")), "slow": slow})
        self.assertEqual(done, ["slow"])

    def test_budget_denial_still_blocks_dispatch(self):
        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}
        message = {"id": "blocked", "text": "hi", "senderType": "human",
                   "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}
        with ExitStack() as stack:
            for name in ["ensure_runtime", "send_heartbeat", "save_state", "log", "reap_orphan_turns", "api"]:
                stack.enter_context(patch.object(bridge, name))
            stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
            stack.enter_context(patch.object(bridge, "load_state", return_value=state))
            stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
            stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
            stack.enter_context(patch.object(bridge, "check_budget", return_value=False))
            stack.enter_context(patch.object(bridge, "flush_outbox", return_value=0))
            stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
            run = stack.enter_context(patch.object(bridge, "run_hermes"))
            with self.assertRaises(KeyboardInterrupt):
                bridge.main()
        run.assert_not_called()
        self.assertNotIn("blocked", state["seen"])


class TestTurnTiming(unittest.TestCase):
    """B3: one measurable line per turn."""

    def test_format_includes_every_known_phase(self):
        line = bridge.format_turn_timing(
            "m1", created_at=100.0, dispatched_at=102.5, spawned_at=104.0,
            first_call_at=114.0, finished_at=160.0, calls=12,
        )
        self.assertEqual(
            line,
            "turn m1 timing: pickup=2.5s predispatch=1.5s first_model_call=10.0s total=57.5s calls=12",
        )

    def test_unknown_phases_are_omitted_not_guessed(self):
        line = bridge.format_turn_timing(
            "m1", created_at=None, dispatched_at=10.0, spawned_at=None,
            first_call_at=None, finished_at=12.0, calls=None,
        )
        self.assertEqual(line, "turn m1 timing: total=2.0s")

    def test_model_call_stats_reads_this_turn_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_log = Path(tmp) / "agent.log"
            agent_log.write_text(
                "2026-10-13 10:00:00,001 INFO [s1] agent.conversation_loop: API call #7: model=m in=1 out=1\n"
                "2026-10-13 10:05:12,001 INFO [s1] agent.conversation_loop: API call #1: model=m in=1 out=1\n"
                "2026-10-13 10:05:16,001 INFO [s1] agent.tool_executor: tool terminal completed (0.20s, 10 chars)\n"
                "2026-10-13 10:05:20,001 INFO [s1] agent.conversation_loop: API call #2: model=m in=1 out=1\n",
                encoding="utf-8",
            )
            spawned = time.mktime(time.strptime("2026-10-13 10:05:02", "%Y-%m-%d %H:%M:%S")) + 0.4
            with patch.object(bridge, "_agent_log_path", return_value=agent_log):
                first, calls = bridge.model_call_stats(spawned)
        self.assertEqual(calls, 2)
        self.assertAlmostEqual(first - spawned, 9.6, places=1)

    def test_parse_iso_timestamp(self):
        self.assertEqual(bridge.parse_iso_timestamp("1970-01-01T00:01:40Z"), 100.0)
        self.assertIsNone(bridge.parse_iso_timestamp("not a date"))
        self.assertIsNone(bridge.parse_iso_timestamp(None))


class TestAcknowledgeFirst(unittest.TestCase):
    """C2: the reminder is for humans waiting on an answer, nobody else."""

    def _dynamic(self, message):
        with patch.object(bridge, "format_my_open_tasks", return_value=""), \
             patch.object(bridge, "format_organization_context", return_value=""), \
             patch.object(bridge, "format_main_chat_context", return_value=""), \
             patch.object(bridge, "format_my_team_roles", return_value=""):
            return bridge.build_dynamic_block(message, {})

    def test_reminder_is_short(self):
        self.assertLessEqual(len(bridge.ACK_FIRST_REMINDER), 200)

    def test_human_message_carries_the_reminder(self):
        block = self._dynamic({"threadId": "t1", "threadType": "direct", "senderType": "human", "text": "do it"})
        self.assertIn(bridge.ACK_FIRST_REMINDER, block)
        self.assertTrue(block.endswith("Latest message: do it"))

    def test_agent_and_system_messages_do_not(self):
        for sender in ("agent", "system", ""):
            block = self._dynamic({"threadId": "t1", "threadType": "team", "senderType": sender, "text": "x"})
            self.assertNotIn("Acknowledge first", block, sender)

    def test_operating_guide_states_the_rule(self):
        guide = (BRIDGE_DIR.parent / "operating-guide.md").read_text(encoding="utf-8")
        self.assertIn("Acknowledge first", guide)
        self.assertIn("never send more than one acknowledgement per request", guide)


class TestParkedReplyIsNeverReRun(MainLoopHarness):
    """Review fix 1: a reply parked in the outbox is delivered, never re-run."""

    def _message(self):
        return {"id": "m1", "text": "hello", "senderType": "human", "threadId": "t1",
                "targetAgentId": bridge.AGENT_ID, "threadType": "direct", "deliveryState": "acting"}

    def _park(self, *, due):
        entry = bridge.outbox_entry(self._message(), "the answer")
        entry["next_at"] = 0.0 if due else time.time() + 3600
        with patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)):
            bridge._outbox_save(entry)
        return entry

    def test_seen_message_with_a_parked_reply_is_not_recovered(self):
        self._park(due=False)
        run = Mock(return_value="second answer")
        state = {"seen": ["m1"], "lastSeenAt": "2026-01-01T00:00:00Z"}
        self._main(self._message(), state=state, run_hermes=run)
        run.assert_not_called()
        self.assertTrue(any(Path(self._outbox.name).glob("*.json")), "the parked reply stays for the outbox")

    def test_unseen_message_with_a_parked_reply_is_not_dispatched(self):
        self._park(due=False)
        run = Mock(return_value="second answer")
        self._main(self._message(), run_hermes=run)
        run.assert_not_called()

    def test_outbox_is_flushed_before_the_sync(self):
        self._park(due=True)
        order = []
        send = Mock(side_effect=lambda *a, **k: order.append("send") or "stored-1")
        real_sync = Mock(side_effect=lambda state: order.append("sync") or [])
        with ExitStack() as stack:
            for name in ["ensure_runtime", "send_heartbeat", "save_state", "report_token_usage",
                         "reap_orphan_turns", "log", "update_chat_status"]:
                stack.enter_context(patch.object(bridge, name))
            stack.enter_context(patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)))
            stack.enter_context(patch.object(bridge, "api", Mock(return_value={})))
            stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
            stack.enter_context(patch.object(bridge, "load_state", return_value={"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}))
            stack.enter_context(patch.object(bridge, "sync_messages", real_sync))
            stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
            stack.enter_context(patch.object(bridge, "send_reply", send))
            stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
            with self.assertRaises(KeyboardInterrupt):
                bridge.main()
        self.assertEqual(order[:2], ["send", "sync"])


class TestEnvironmentClassificationAndCeiling(MainLoopHarness):
    """Review fix 2: classify on the bridge's own signals, and bound the wait."""

    def test_reply_text_never_makes_an_environment_failure(self):
        exc = bridge.HermesTurnFailed("The request timed out: connection refused, ssl: handshake", stderr="")
        self.assertFalse(bridge.is_environment_failure(exc))

    def test_hermes_stderr_still_classifies(self):
        self.assertTrue(bridge.is_environment_failure(
            bridge.HermesTurnFailed("whatever", stderr="Temporary failure in name resolution")))
        self.assertTrue(bridge.is_environment_failure(
            bridge.HermesTurnFailed("whatever", stderr="hermes-refusal-reason: SESSION_NOT_OWNED")))

    def test_failed_turn_raises_typed_error_with_stderr_only(self):
        completed = subprocess.CompletedProcess(["hermes"], 1, "I timed out talking to the API", "boom")
        with patch.object(bridge, "build_static_block", return_value="S"), \
             patch.object(bridge, "build_dynamic_block", return_value="D"), \
             patch.object(bridge, "is_direct_thread", return_value=False), \
             patch.object(bridge, "invoke_hermes", return_value=completed):
            with self.assertRaises(bridge.HermesTurnFailed) as caught:
                bridge.run_hermes({"id": "m1", "threadId": "t1", "text": "hi"}, {})
        self.assertEqual(caught.exception.stderr, "boom")
        self.assertFalse(bridge.is_environment_failure(caught.exception))

    def _human(self):
        return {"id": "m1", "text": "hello", "senderType": "human", "threadId": "t1",
                "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}

    def test_environment_wait_gives_up_after_the_ceiling(self):
        first = time.time() - bridge.MAX_ENVIRONMENT_WAIT_SECONDS - 5
        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z",
                 "retries": {"m1": {"attempts": 0, "busyMisses": 40, "busy": True,
                                    "nextRetryAt": 0, "firstAttemptAt": first}}}
        state, status, send = self._main(self._human(), state=state,
                                         run_hermes=Mock(side_effect=bridge.SessionBusy("SESSION_NOT_OWNED")))
        cancelled = [c for c in status.call_args_list if c.kwargs.get("execution_state") == "cancelled"]
        self.assertEqual(len(cancelled), 1)
        self.assertEqual(cancelled[0].kwargs["reason"], bridge.ENVIRONMENT_WAIT_REASON)
        send.assert_called_once()
        self.assertIn(bridge.ENVIRONMENT_WAIT_REASON, send.call_args.args[1])
        self.assertNotIn("m1", state["retries"])
        self.assertIn("m1", state["seen"])

    def test_first_attempt_is_recorded_once(self):
        state = {}
        bridge.schedule_retry(state, "m1", now=100, busy=True, first_attempt_at=90)
        bridge.schedule_retry(state, "m1", now=200, busy=True, first_attempt_at=190)
        self.assertEqual(state["retries"]["m1"]["firstAttemptAt"], 90)
        self.assertFalse(bridge.environment_wait_exhausted(state, "m1", now=90 + bridge.MAX_ENVIRONMENT_WAIT_SECONDS - 1))
        self.assertTrue(bridge.environment_wait_exhausted(state, "m1", now=90 + bridge.MAX_ENVIRONMENT_WAIT_SECONDS))


class TestOutboxRefusalsCount(MainLoopHarness):
    """Review fix 3: a 4xx (429 included) spends the outbox budget."""

    def _entry(self):
        return bridge.outbox_entry({"id": "m1", "threadId": "t1", "threadType": "team"}, "the answer")

    def _flush_once(self, exc, entry):
        with patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)), \
             patch.object(bridge, "send_reply", side_effect=exc), \
             patch.object(bridge, "update_chat_status") as status, \
             patch.object(bridge, "log"):
            entry["next_at"] = 0
            bridge._outbox_save(entry)
            bridge.flush_outbox({"seen": []})
        return status

    def test_soft_and_hard_classification(self):
        self.assertFalse(bridge.outbox_failure_is_soft(bridge.ApiError("x failed 429: Loop guard", 429)))
        self.assertFalse(bridge.outbox_failure_is_soft(bridge.ApiError("x failed 404", 404)))
        self.assertTrue(bridge.outbox_failure_is_soft(bridge.ApiError("x failed 503", 503)))
        self.assertTrue(bridge.outbox_failure_is_soft(NETWORK_DOWN))
        self.assertFalse(bridge.outbox_failure_is_soft(RuntimeError("Emperor API timed out")))

    def test_loop_guard_429_gives_up_and_keeps_the_text(self):
        entry = self._entry()
        entry["hard_attempts"] = bridge.OUTBOX_MAX_ATTEMPTS - 1
        status = self._flush_once(bridge.ApiError("Emperor API POST /messages/send failed 429: Loop guard", 429), entry)
        failed = list(Path(self._outbox.name).glob("*.failed"))
        self.assertEqual(len(failed), 1)
        self.assertEqual(json.loads(failed[0].read_text(encoding="utf-8"))["body"]["text"], "the answer")
        self.assertEqual([c.kwargs.get("execution_state") for c in status.call_args_list], ["failed"])

    def test_5xx_does_not_spend_the_budget(self):
        entry = self._entry()
        entry["hard_attempts"] = bridge.OUTBOX_MAX_ATTEMPTS - 1
        self._flush_once(bridge.ApiError("x failed 502", 502), entry)
        self.assertEqual(list(Path(self._outbox.name).glob("*.failed")), [])
        parked = json.loads(next(Path(self._outbox.name).glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(parked["hard_attempts"], bridge.OUTBOX_MAX_ATTEMPTS - 1)


class TestOutboxIdempotencyKey(MainLoopHarness):
    """Review fix 7: every retry of one reply carries the same key."""

    def test_key_is_stable_across_retries_and_persisted(self):
        entry = bridge.outbox_entry({"id": "m1", "threadId": "t1"}, "the answer")
        key = entry["idempotency_key"]
        self.assertTrue(key)
        calls = []

        def send(target, text, **kwargs):
            calls.append(kwargs.get("idempotency_key"))
            if len(calls) == 1:
                raise NETWORK_DOWN
            return "stored-1"

        with patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)), \
             patch.object(bridge, "send_reply", side_effect=send), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "save_state"), \
             patch.object(bridge, "log"):
            bridge._outbox_save(entry)
            bridge.flush_outbox({"seen": []})
            parked = json.loads(next(Path(self._outbox.name).glob("*.json")).read_text(encoding="utf-8"))
            self.assertEqual(parked["idempotency_key"], key)
            parked["next_at"] = 0
            bridge._outbox_save(parked)
            self.assertEqual(bridge.flush_outbox({"seen": []}), 1)
        self.assertEqual(calls, [key, key])

    def test_legacy_entry_gets_a_key_pinned_before_the_post(self):
        entry = bridge.outbox_entry({"id": "m1", "threadId": "t1"}, "the answer")
        entry.pop("idempotency_key")
        seen_keys = []
        with patch.object(bridge, "OUTBOX_DIR", Path(self._outbox.name)), \
             patch.object(bridge, "send_reply", side_effect=lambda t, x, **k: seen_keys.append(k["idempotency_key"]) or "s"), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "save_state"), \
             patch.object(bridge, "log"):
            bridge.deliver_reply(entry, {"seen": []}, attempts=1)
        self.assertEqual(seen_keys, [entry["idempotency_key"]])

    def test_api_sends_the_given_key(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(req, timeout):
            captured.update({k.lower(): v for k, v in req.header_items()})
            return Response()

        with patch.object(bridge.urllib.request, "urlopen", side_effect=fake_urlopen):
            bridge.api("POST", "/messages/send", body={}, idempotency_key="key-123456")
        self.assertEqual(captured["idempotency-key"], "key-123456")


class TestGoalTurnsAndAckKnob(unittest.TestCase):
    """Review fixes 5 and 10."""

    def test_goal_turn_exports_no_trigger_message_id(self):
        captured = {}
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            captured.update(kwargs["env"])
            return real_popen(*args, **kwargs)

        with patch.dict(os.environ, {"EMPEROR_CLAW_TURN_MESSAGE_ID": "stale"}), \
             patch.object(bridge.subprocess, "Popen", side_effect=launch), \
             patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "log"):
            bridge.invoke_hermes([sys.executable, "-c", "pass"],
                                 {"id": "cmd-1", "threadId": "t9", "goalTurn": True, "senderType": "human"}, state={})
        self.assertNotIn("EMPEROR_CLAW_TURN_MESSAGE_ID", captured)
        self.assertEqual(captured["EMPEROR_CLAW_TURN_THREAD_ID"], "t9")

    def test_goal_turn_gets_no_reminder(self):
        self.assertEqual(bridge.ack_first_reminder({"senderType": "human", "goalTurn": True}), "")
        self.assertEqual(bridge.ack_first_reminder({"senderType": "human"}), bridge.ACK_FIRST_REMINDER)

    def test_ack_first_knob_turns_the_reminder_off(self):
        with patch.object(bridge, "ACK_FIRST_ENABLED", False):
            self.assertEqual(bridge.ack_first_reminder({"senderType": "human"}), "")


class TestLateDispatchStatus(unittest.TestCase):
    """Review fix 9: a late "acting" never outlives the turn's final status."""

    def test_status_task_that_runs_after_the_turn_sends_nothing(self):
        captured = []
        with patch.object(bridge, "submit_background", side_effect=lambda fn: captured.append(fn) or Mock()), \
             patch.object(bridge, "update_chat_status") as status:
            bridge.announce_dispatch({"id": "m1", "threadId": "t1"}, run_id="r", started_at=0.0, ledger_enabled=False)
            bridge.end_dispatch_status()
            captured[0]()  # the status task, finally scheduled
        status.assert_not_called()

    def test_pending_status_is_followed_by_the_final_status(self):
        import threading
        release = threading.Event()
        future = bridge.submit_background(lambda: release.wait(5))
        with patch.object(bridge, "log"):
            pending = bridge.join_dispatch([future], timeout=0.05)
        self.assertEqual(pending, [future])
        with patch.object(bridge, "update_chat_status") as status:
            bridge.resend_final_status_after(pending, {"id": "m1", "threadId": "t1"},
                                             {"typing": False, "execution_state": "resolved"})
            status.assert_not_called()
            release.set()
            future.result(timeout=5)
            deadline = time.time() + 5
            while not status.called and time.time() < deadline:
                time.sleep(0.01)
        status.assert_called_once_with({"id": "m1", "threadId": "t1"}, typing=False, execution_state="resolved")


if __name__ == "__main__":
    unittest.main()
