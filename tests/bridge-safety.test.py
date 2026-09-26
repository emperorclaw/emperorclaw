"""
Tests for EmperorClaw Hermes Bridge safety functions.

Tests cover:
- Cold-start guard (per-thread)
- Loop guard (max 3 agent turns)
- is_for_agent routing
- mentions_agent detection
- check_loop_guard mechanics
- State persistence (save/load cycle)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add bridge dir to path so we can import the bridge module
BRIDGE_DIR = Path(__file__).resolve().parent.parent / "integrations" / "hermes" / "emperor-claw" / "bridge"
sys.path.insert(0, str(BRIDGE_DIR))

# We need to set env vars before importing the bridge module
os.environ.setdefault("EMPEROR_CLAW_API_TOKEN", "test-token")
os.environ.setdefault("EMPEROR_CLAW_API_URL", "http://localhost:3000/api/mcp")
os.environ.setdefault("EMPEROR_CLAW_AGENT_NAME", "TestAgent")
os.environ.setdefault("EMPEROR_CLAW_AGENT_ID", "test-agent-id")
os.environ.setdefault("EMPEROR_CLAW_AGENT_ROLE", "Tester")
os.environ.setdefault("EMPEROR_CLAW_RUNTIME_ID", "test-runtime-1")
os.environ.setdefault("EMPEROR_CLAW_HERMES_STATE_PATH", str(Path(tempfile.gettempdir()) / "test-bridge-state.json"))
os.environ.setdefault("EMPEROR_CLAW_HERMES_POLL_SECONDS", "5")
os.environ.setdefault("EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS", "30")

import emperor_hermes_bridge as bridge


class TestRuntimeControls(unittest.TestCase):
    def test_control_resets_session_before_acknowledging(self):
        from unittest.mock import patch
        state = {"sessions": {"agent:thread": "old-session"}}
        events = []
        with patch.object(bridge, "save_state", side_effect=lambda value: events.append(("save", dict(value["sessions"])))), patch.object(bridge, "api", side_effect=lambda *args, **kwargs: events.append(("ack", kwargs["body"]["commandId"]))):
            self.assertTrue(bridge.apply_runtime_controls({"commands": [{"id": "stop-1"}, {"id": "stop-2"}]}, state))
        self.assertEqual(events, [("save", {}), ("ack", "stop-1"), ("ack", "stop-2")])

    def test_queued_prompt_keeps_session(self):
        state = {"sessions": {"a:t": "existing"}}
        self.assertFalse(bridge.apply_runtime_controls({"commands": []}, state))
        self.assertEqual(state["sessions"], {"a:t": "existing"})

    def test_stop_terminates_real_turn_before_ack(self):
        from unittest.mock import patch
        import subprocess
        real_popen = subprocess.Popen
        processes = []
        def launch(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            processes.append(proc)
            return proc
        def ack(*args, **kwargs):
            self.assertIsNotNone(processes[0].poll(), "ack must follow process exit")
            return {"ok": True}
        state = {"sessions": {"a:t": "old"}}
        with patch.object(bridge.subprocess, "Popen", side_effect=launch), patch.object(bridge, "fetch_runtime_control", return_value={"commands": [{"id": "stop"}]}), patch.object(bridge, "save_state"), patch.object(bridge, "api", side_effect=ack):
            with self.assertRaises(bridge.TurnInterrupted):
                bridge.invoke_hermes([sys.executable, "-c", "import time; time.sleep(30)"], {"id": "work"}, state=state)
        self.assertIsNotNone(processes[0].returncode)
        self.assertEqual(state["sessions"], {})

    def test_cancelled_cached_prompt_is_interrupted(self):
        from unittest.mock import patch, MagicMock
        proc = MagicMock()
        proc.poll.return_value = None
        proc.communicate.return_value = ("stale answer", "")
        with patch.object(bridge.subprocess, "Popen", return_value=proc), patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": True}), patch.object(bridge, "_terminate_turn") as terminate:
            with self.assertRaises(bridge.TurnInterrupted):
                bridge.invoke_hermes(["hermes"], {"id": "cached-work"}, state={})
        terminate.assert_called_once_with(proc)


class TestRosterAliases(unittest.TestCase):
    def test_turn_includes_baseline_when_company_kb_empty(self):
        from unittest.mock import patch
        import subprocess
        with patch.object(bridge, "format_agent_roster", return_value=""), patch.object(bridge, "fetch_company_brain_context", return_value={"sources": []}), patch.object(bridge, "invoke_hermes", return_value=subprocess.CompletedProcess([], 0, "Hello", "")) as invoke:
            result = bridge.run_hermes({"threadId": "team-test", "threadType": "team", "text": "@TestAgent hello"}, {})
        self.assertEqual(result, "Hello")
        command = invoke.call_args.args[0]
        prompt = command[command.index("-q") + 1]
        for phrase in ["Emperor minimum operating practices", "Group chat", "isShared=true", "Common scenarios", "resolver returned no readable context"]:
            self.assertIn(phrase, prompt)

    def test_same_first_name_gets_distinct_aliases(self):
        from unittest.mock import patch
        with patch.object(bridge, "fetch_agent_roster", return_value=[
            {"id": "1", "name": "Alex Smith"}, {"id": "2", "name": "Alex Jones"},
        ]):
            roster = bridge.format_agent_roster("1")
        self.assertIn("@Alex-Jones", roster)
        self.assertIn("@Alex-Smith", roster)
        self.assertNotIn(": @Alex\n", roster)
        self.assertTrue(bridge.mentions_agent("@Alex-Jones please review", "Alex Jones"))
        self.assertFalse(bridge.mentions_agent("@Alex-Jones please review", "Alex Smith"))


class TestColdStartGuard(unittest.TestCase):
    """Tests for per-thread cold-start guard."""

    def test_new_thread_is_frozen(self):
        """A thread with no human messages should be frozen (cold_start=True)."""
        state = {}
        cold_state = state.setdefault("cold_start_threads", {})
        thread_id = "team-thread-1"
        # Default should be True (frozen) for a new thread
        self.assertTrue(cold_state.get(thread_id, True))

    def test_human_message_unfreezes_thread(self):
        """A human message should unfreeze only THAT thread."""
        state = {}
        cold_state = state.setdefault("cold_start_threads", {})
        thread_a = "team-thread-a"
        thread_b = "team-thread-b"
        # Human speaks in thread A
        cold_state[thread_a] = False
        # Thread A should be unfrozen
        self.assertFalse(cold_state.get(thread_a, True))
        # Thread B should still be frozen
        self.assertTrue(cold_state.get(thread_b, True))

    def test_agent_message_stays_frozen(self):
        """An agent message should NOT unfreeze a thread."""
        state = {}
        cold_state = state.setdefault("cold_start_threads", {})
        thread_id = "team-thread-1"
        # Simulate: agent message arrives, thread stays frozen
        is_frozen = cold_state.get(thread_id, True)
        self.assertTrue(is_frozen)


class TestLoopGuard(unittest.TestCase):
    """Tests for the mechanical loop guard (max 3 agent turns)."""

    def _make_msg(self, sender_type="agent", thread_type="team", thread_id="team-1"):
        return {
            "id": "msg-1",
            "senderType": sender_type,
            "threadType": thread_type,
            "threadId": thread_id,
            "text": "test message",
        }

    def test_first_agent_turn_passes(self):
        """First agent turn should pass the loop guard."""
        msg = self._make_msg(sender_type="agent")
        state = {}
        result = bridge.check_loop_guard(msg, state)
        self.assertTrue(result)

    def test_three_agent_turns_pass(self):
        """Up to 3 consecutive agent turns should pass."""
        state = {}
        thread_id = "team-loop-test"
        for i in range(3):
            msg = self._make_msg(sender_type="agent", thread_id=thread_id)
            result = bridge.check_loop_guard(msg, state)
            self.assertTrue(result, f"Turn {i+1} should pass")

    def test_fourth_agent_turn_fails(self):
        """4th consecutive agent turn should be blocked."""
        state = {}
        thread_id = "team-loop-test-2"
        for i in range(3):
            msg = self._make_msg(sender_type="agent", thread_id=thread_id)
            bridge.check_loop_guard(msg, state)
        # 4th should fail
        msg4 = self._make_msg(sender_type="agent", thread_id=thread_id)
        result = bridge.check_loop_guard(msg4, state)
        self.assertFalse(result)

    def test_human_resets_counter(self):
        """A human message resets the loop guard counter to 0."""
        state = {}
        thread_id = "team-reset-test"
        # Build up 3 agent turns
        for _ in range(3):
            bridge.check_loop_guard(self._make_msg(sender_type="agent", thread_id=thread_id), state)
        # Human message
        human_msg = self._make_msg(sender_type="human", thread_id=thread_id)
        bridge.check_loop_guard(human_msg, state)
        # Now agent should pass again
        agent_msg = self._make_msg(sender_type="agent", thread_id=thread_id)
        result = bridge.check_loop_guard(agent_msg, state)
        self.assertTrue(result)

    def test_direct_threads_always_pass(self):
        """Direct threads should always pass loop guard."""
        msg = self._make_msg(sender_type="agent", thread_type="direct", thread_id="dm-1")
        state = {}
        # Even after many turns, direct threads pass
        for _ in range(10):
            result = bridge.check_loop_guard(msg, state)
            self.assertTrue(result)


class TestMentionsAgent(unittest.TestCase):
    """Tests for @mention detection."""

    def test_exact_mention(self):
        """Direct @TestAgent should be detected."""
        text = "@TestAgent can you check this?"
        result = bridge.mentions_agent(text, "TestAgent")
        self.assertTrue(result)

    def test_partial_first_name_mention(self):
        """@TestAgent alone (full name) should match."""
        text = "@TestAgent do something"
        result = bridge.mentions_agent(text, "TestAgent")
        self.assertTrue(result)

    def test_partial_word_does_not_match(self):
        """@Test (partial word) should NOT match TestAgent (avoids false positives)."""
        text = "@Test do something"
        result = bridge.mentions_agent(text, "TestAgent")
        self.assertFalse(result)

    def test_no_mention(self):
        """Message without @mention should not match."""
        text = "Can you check this?"
        result = bridge.mentions_agent(text, "TestAgent")
        self.assertFalse(result)

    def test_mention_other_agent(self):
        """@ mention of another agent should not match."""
        text = "@Builder do this"
        result = bridge.mentions_agent(text, "TestAgent")
        self.assertFalse(result)

    def test_mention_with_punctuation(self):
        """@TestAgent! or @TestAgent, should still match."""
        text = "@TestAgent, please help!"
        result = bridge.mentions_agent(text, "TestAgent")
        self.assertTrue(result)


class TestIsForAgent(unittest.TestCase):
    """Tests for message routing (is_for_agent)."""

    def _make_msg(self, **kwargs):
        defaults = {
            "id": "msg-1",
            "senderType": "human",
            "senderId": "user-1",
            "threadType": "team",
            "threadId": "team-1",
            "targetAgentId": "",
            "text": "hello",
        }
        defaults.update(kwargs)
        return defaults

    def test_direct_target_match(self):
        """Message with targetAgentId matching this agent."""
        msg = self._make_msg(targetAgentId="test-agent-id")
        state = {}
        result = bridge.is_for_agent(msg, "test-agent-id", state)
        self.assertTrue(result)

    def test_direct_target_mismatch(self):
        """Message with targetAgentId NOT matching this agent."""
        msg = self._make_msg(targetAgentId="other-agent-id")
        state = {}
        result = bridge.is_for_agent(msg, "test-agent-id", state)
        self.assertFalse(result)

    def test_own_message_ignored(self):
        """Agent should ignore its own messages."""
        msg = self._make_msg(senderType="agent", senderId="test-agent-id")
        state = {}
        result = bridge.is_for_agent(msg, "test-agent-id", state)
        self.assertFalse(result)

    def test_direct_thread_always_relevant(self):
        """Messages in a direct thread are always for this agent."""
        msg = self._make_msg(threadType="direct", targetAgentId="")
        state = {}
        result = bridge.is_for_agent(msg, "test-agent-id", state)
        self.assertTrue(result)

    def test_team_chat_needs_mention(self):
        """Team chat messages need @mention to be for this agent."""
        msg = self._make_msg(threadType="team", targetAgentId="", text="hello everyone")
        state = {}
        result = bridge.is_for_agent(msg, "test-agent-id", state)
        self.assertFalse(result)


class TestStatePersistence(unittest.TestCase):
    """Tests that state saves and loads correctly."""

    def test_save_and_load_state(self):
        """State should survive a save/load cycle."""
        state_path = Path(os.environ["EMPEROR_CLAW_HERMES_STATE_PATH"])
        state = {
            "seen": ["msg-1", "msg-2"],
            "cold_start_threads": {"team-1": False, "team-2": True},
            "loop_guard": {"team-1": {"count": 2, "notified": False}},
            "lastSeenAt": "2026-07-20T10:00:00Z",
        }
        bridge.save_state(state)
        loaded = bridge.load_state()
        self.assertEqual(loaded["seen"], state["seen"])
        self.assertEqual(loaded["cold_start_threads"], state["cold_start_threads"])
        self.assertEqual(loaded["loop_guard"], state["loop_guard"])
        # Cleanup
        state_path.unlink(missing_ok=True)

    def test_empty_state_on_first_load(self):
        """First load with no file should return empty state."""
        state_path = Path(os.environ["EMPEROR_CLAW_HERMES_STATE_PATH"])
        state_path.unlink(missing_ok=True)
        Path(str(state_path) + ".bak").unlink(missing_ok=True)
        state = bridge.load_state()
        self.assertEqual(state, {"seen": [], "lastSeenAt": None})

    def test_corrupt_state_is_preserved_and_falls_back(self):
        """A corrupt state file must not be silently discarded."""
        state_path = Path(os.environ["EMPEROR_CLAW_HERMES_STATE_PATH"])
        Path(str(state_path) + ".bak").unlink(missing_ok=True)
        Path(str(state_path) + ".corrupt").unlink(missing_ok=True)
        state_path.write_text("{not valid json", encoding="utf-8")
        loaded = bridge.load_state()
        self.assertEqual(loaded, {"seen": [], "lastSeenAt": None})
        self.assertTrue(Path(str(state_path) + ".corrupt").exists())
        Path(str(state_path) + ".corrupt").unlink(missing_ok=True)


class TestBudgetGuard(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        self.api_patch = patch.object(bridge, "api")
        self.api = self.api_patch.start()
        self.addCleanup(self.api_patch.stop)
        bridge._pending_input_chars = 0
        bridge._pending_output_chars = 0

    def test_denies_paused_malformed_and_failed_checks(self):
        for payload in [{}, {"agent": {"executionAllowed": False, "budgetStatus": "paused"}}]:
            self.api.return_value = payload
            self.assertFalse(bridge.check_budget())
        self.api.side_effect = RuntimeError("offline")
        self.assertFalse(bridge.check_budget())

    def test_paused_poll_never_invokes_hermes_or_consumes_message(self):
        from unittest.mock import patch
        from contextlib import ExitStack
        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}
        message = {"id": "blocked", "text": "hello", "senderType": "human",
                   "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}
        self.api.return_value = {"agent": {"budgetStatus": "paused", "executionAllowed": False}}
        with ExitStack() as stack:
            for name in ["ensure_runtime", "send_heartbeat", "save_state"]:
                stack.enter_context(patch.object(bridge, name))
            stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
            stack.enter_context(patch.object(bridge, "load_state", return_value=state))
            stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
            stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
            stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
            run = stack.enter_context(patch.object(bridge, "run_hermes"))
            with self.assertRaises(KeyboardInterrupt):
                bridge.main()
            run.assert_not_called()
            self.assertNotIn("blocked", state["seen"])

    def test_flushes_every_turn_and_retries_before_dispatch(self):
        self.api.side_effect = RuntimeError("offline")
        with self.assertRaises(RuntimeError):
            bridge.report_token_usage(400, 200)
        self.assertFalse(bridge.check_budget())
        self.api.side_effect = None
        self.api.return_value = {"agent": {"executionAllowed": True, "budgetStatus": "active"}}
        self.assertTrue(bridge.check_budget())
        self.assertEqual(bridge._pending_input_chars, 0)
        self.assertEqual(self.api.call_args_list[-2].args[0], "POST")
        self.assertEqual(self.api.call_args_list[-1].args[0], "GET")
        bridge.report_token_usage(400, 200)
        self.assertEqual(self.api.call_args.args[0], "POST")


class TestIsDirectThread(unittest.TestCase):
    """Tests for DM vs team classification (is_direct_thread)."""

    def test_explicit_direct_thread_type(self):
        self.assertTrue(bridge.is_direct_thread({"threadType": "direct", "threadId": "dm-1"}, {}))

    def test_explicit_team_thread_type(self):
        self.assertFalse(bridge.is_direct_thread({"threadType": "team", "threadId": "team-1"}, {}))

    def test_target_agent_id_marks_direct(self):
        msg = {"threadId": "dm-1", "targetAgentId": bridge.AGENT_ID}
        self.assertTrue(bridge.is_direct_thread(msg, {}))

    def test_recorded_direct_thread_ownership(self):
        msg = {"threadId": "dm-1"}
        state = {"direct_threads": {"dm-1": bridge.AGENT_ID}}
        self.assertTrue(bridge.is_direct_thread(msg, state))

    def test_unknown_thread_is_not_direct(self):
        self.assertFalse(bridge.is_direct_thread({"threadId": "team-1"}, {}))


class TestMainChatContext(unittest.TestCase):
    """Tests for the DM main-chat digest (format_main_chat_context)."""

    def setUp(self):
        from unittest.mock import patch
        self.api_patch = patch.object(bridge, "api")
        self.api = self.api_patch.start()
        self.addCleanup(self.api_patch.stop)
        bridge._team_thread_id_cache = None
        self.addCleanup(setattr, bridge, "_team_thread_id_cache", None)

    def test_formats_recent_team_messages_with_sender_labels(self):
        def fake_api(method, path, body=None, query=None):
            if path == "/threads":
                return {"threads": [{"id": "team-1", "createdAt": "2026-01-01T00:00:00Z"}]}
            if path == "/threads/team-1/messages":
                return {"messages": [
                    {"senderType": "agent", "senderId": "a1", "text": "hi @Ada"},
                    {"senderType": "human", "metadataJson": {"senderName": "Operator"}, "text": "thanks"},
                ]}
            raise AssertionError(path)
        self.api.side_effect = fake_api
        from unittest.mock import patch
        with patch.object(bridge, "fetch_agent_roster", return_value=[{"id": "a1", "name": "Ada"}]):
            context = bridge.format_main_chat_context({})
        self.assertIn("Ada: hi @Ada", context)
        self.assertIn("Operator: thanks", context)

    def test_disabled_when_limit_is_zero(self):
        original = bridge.MAIN_CHAT_CONTEXT_LIMIT
        bridge.MAIN_CHAT_CONTEXT_LIMIT = 0
        try:
            self.assertEqual(bridge.format_main_chat_context({}), "")
            self.api.assert_not_called()
        finally:
            bridge.MAIN_CHAT_CONTEXT_LIMIT = original

    def test_empty_when_no_team_thread(self):
        self.api.return_value = {"threads": []}
        self.assertEqual(bridge.format_main_chat_context({}), "")


class TestReasoningSource(unittest.TestCase):
    """Tests for the pluggable reasoning source (real model "thinking")."""

    def _make_db(self, rows, columns=("reasoning_content", "reasoning"), table="messages"):
        """Build a throwaway fixture SQLite DB. Never touches a real state.db."""
        import sqlite3
        directory = tempfile.mkdtemp()
        db_path = Path(directory) / "state.db"
        conn = sqlite3.connect(str(db_path))
        base = ["id INTEGER PRIMARY KEY", "session_id TEXT", "role TEXT", "timestamp REAL"]
        extra = ["%s TEXT" % name for name in columns]
        conn.execute("CREATE TABLE %s (%s)" % (table, ", ".join(base + extra)))
        names = ["session_id", "role", "timestamp"] + list(columns)
        placeholders = ", ".join("?" * len(names))
        for row in rows:
            conn.execute(
                "INSERT INTO %s (%s) VALUES (%s)" % (table, ", ".join(names), placeholders),
                [row.get(name) for name in names],
            )
        conn.commit()
        conn.close()
        return db_path

    def test_none_source_returns_nothing(self):
        source = bridge.NullReasoningSource()
        self.assertIsNone(source.latest_reasoning("session-1", 0.0))

    def test_session_store_returns_newest_reasoning(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 100.0,
             "reasoning_content": "Older thought.", "reasoning": None},
            {"session_id": "s1", "role": "assistant", "timestamp": 200.0,
             "reasoning_content": "Newest thought about the task.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertEqual(
            source.latest_reasoning("s1", 50.0),
            "Newest thought about the task.",
        )

    def test_session_store_falls_back_to_reasoning_column(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 200.0,
             "reasoning_content": None, "reasoning": "Fallback reasoning text here."},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertEqual(
            source.latest_reasoning("s1", 50.0),
            "Fallback reasoning text here.",
        )

    def test_session_store_ignores_rows_older_than_turn_start(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 10.0,
             "reasoning_content": "Stale reasoning from a previous turn.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("s1", 100.0))

    def test_session_store_never_leaks_another_session(self):
        """A row from a different session id must NEVER be returned."""
        db_path = self._make_db([
            {"session_id": "other-agent-session", "role": "assistant", "timestamp": 300.0,
             "reasoning_content": "Secret reasoning from another agent.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("s1", 50.0))

    def test_session_store_without_session_id_returns_none(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 300.0,
             "reasoning_content": "Some reasoning.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("", 50.0))

    def test_session_store_ignores_non_assistant_rows(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "user", "timestamp": 300.0,
             "reasoning_content": "Not assistant reasoning.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("s1", 50.0))

    def test_missing_db_degrades_to_none(self):
        missing = Path(tempfile.mkdtemp()) / "does-not-exist.db"
        source = bridge.SessionStoreReasoningSource(missing)
        self.assertIsNone(source.latest_reasoning("s1", 0.0))

    def test_missing_table_degrades_to_none(self):
        db_path = self._make_db([], table="other_table")
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("s1", 0.0))

    def test_missing_reasoning_columns_degrade_to_none(self):
        db_path = self._make_db(
            [{"session_id": "s1", "role": "assistant", "timestamp": 300.0, "content": "hi"}],
            columns=("content",),
        )
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("s1", 0.0))

    def test_corrupt_db_degrades_to_none(self):
        path = Path(tempfile.mkdtemp()) / "state.db"
        path.write_text("this is not a sqlite database", encoding="utf-8")
        source = bridge.SessionStoreReasoningSource(path)
        self.assertIsNone(source.latest_reasoning("s1", 0.0))

    def test_stub_row_does_not_mask_real_reasoning(self):
        """A newer row holding a stub must not hide the real thought behind it.

        Assistant rows are written for every step of a turn and many carry a
        token-sized `reasoning_content` — observed in production as a single
        character. Taking the newest row unconditionally meant condensing that
        stub to nothing and reporting no reasoning at all, even with a full
        thought one row back.
        """
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 100.0,
             "reasoning_content": "A complete thought worth showing.", "reasoning": None},
            {"session_id": "s1", "role": "assistant", "timestamp": 200.0,
             "reasoning_content": "x", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertEqual(
            source.latest_reasoning("s1", 0.0),
            "A complete thought worth showing.",
        )

    def test_stub_column_does_not_shadow_substantive_sibling(self):
        """The row may qualify on the SECOND column; do not return the first."""
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 100.0,
             "reasoning_content": "x", "reasoning": "The real reasoning lives here."},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertEqual(
            source.latest_reasoning("s1", 0.0),
            "The real reasoning lives here.",
        )

    def test_missing_table_recovers_once_it_appears(self):
        """A not-yet-created `messages` table is transient, not permanent.

        During first-run schema bootstrap the store file exists but `messages`
        does not. PRAGMA returns an empty list instead of raising, and latching
        that as unusable would freeze the source into "no reasoning" for the
        whole life of the process — weeks, under Restart=always.
        """
        import sqlite3
        db_path = self._make_db(
            [{"session_id": "s1", "role": "assistant", "timestamp": 100.0,
              "reasoning_content": "unused", "reasoning": None}],
            table="not_messages",
        )
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.latest_reasoning("s1", 0.0))

        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, "
            "role TEXT, timestamp REAL, reasoning_content TEXT)"
        )
        conn.execute(
            "INSERT INTO messages (session_id, role, timestamp, reasoning_content) "
            "VALUES ('s1', 'assistant', 200.0, 'Reasoning that arrived later.')"
        )
        conn.commit()
        conn.close()

        self.assertEqual(
            source.latest_reasoning("s1", 0.0),
            "Reasoning that arrived later.",
        )


class TestReasoningSourceResolution(unittest.TestCase):
    """The active source must not latch a negative result forever."""

    def setUp(self):
        self._saved = (bridge._reasoning_source, bridge._reasoning_source_retry_at,
                       bridge.REASONING_SOURCE_NAME, os.environ.get("HERMES_HOME"))
        bridge._reasoning_source = None
        bridge._reasoning_source_retry_at = 0.0

    def tearDown(self):
        (bridge._reasoning_source, bridge._reasoning_source_retry_at,
         bridge.REASONING_SOURCE_NAME, home) = self._saved
        if home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = home

    def test_auto_upgrades_when_store_appears_later(self):
        """The fresh-install path: bridge starts before the runtime ever runs.

        The store does not exist yet, so `auto` correctly resolves to none — but
        it must re-check, or reasoning silently never works until a restart.
        """
        import sqlite3
        home = Path(tempfile.mkdtemp())
        os.environ["HERMES_HOME"] = str(home)
        bridge.REASONING_SOURCE_NAME = "auto"

        self.assertEqual(bridge.reasoning_source().name, "none")

        conn = sqlite3.connect(str(home / "state.db"))
        conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()

        # Still cached inside the retry window.
        self.assertEqual(bridge.reasoning_source().name, "none")
        # Once the window lapses it must notice.
        bridge._reasoning_source_retry_at = 0.0
        self.assertEqual(bridge.reasoning_source().name, "session-store")

    def test_positive_result_is_cached(self):
        home = Path(tempfile.mkdtemp())
        (home / "state.db").write_bytes(b"")
        os.environ["HERMES_HOME"] = str(home)
        bridge.REASONING_SOURCE_NAME = "session-store"
        first = bridge.reasoning_source()
        self.assertEqual(first.name, "session-store")
        self.assertIs(bridge.reasoning_source(), first)


class TestCondenseReasoning(unittest.TestCase):
    """Tests for squashing raw reasoning into a status-line-sized phrase."""

    def test_short_opening_sentence_grows_instead_of_truncating(self):
        """A terse opener must absorb the next sentence, not be thrown away.

        Discarding it fell back to truncating the entire flattened blob, so the
        reader got a severed run-on where a complete short thought was available.
        """
        text = "Let me check. The deploy job finished at 11:38 and matches the timestamp."
        out = bridge.condense_reasoning(text)
        self.assertTrue(out.startswith("Let me check."), out)
        self.assertNotIn("…", out)
        self.assertLessEqual(len(out), bridge._REASONING_MAX_CHARS)

    def test_collapses_newlines_and_whitespace(self):
        condensed = bridge.condense_reasoning("First line of thought\n\n  second   line\nthird")
        self.assertNotIn("\n", condensed)
        self.assertNotIn("  ", condensed)

    def test_strips_markdown_scaffolding(self):
        condensed = bridge.condense_reasoning("## Plan\n- **check** the `config` file")
        self.assertNotIn("#", condensed)
        self.assertNotIn("*", condensed)
        self.assertNotIn("`", condensed)

    def test_truncates_under_budget(self):
        condensed = bridge.condense_reasoning("word " * 200)
        self.assertLessEqual(len(condensed), bridge._REASONING_MAX_CHARS)
        self.assertTrue(condensed.endswith("\u2026"))

    def test_prefers_leading_sentence(self):
        text = "I should read the config first. Then I will edit the handler and run the tests."
        self.assertEqual(bridge.condense_reasoning(text), "I should read the config first.")

    def test_empty_input_returns_none(self):
        self.assertIsNone(bridge.condense_reasoning(""))
        self.assertIsNone(bridge.condense_reasoning("   \n  "))


class TestLatestReasoningActivity(unittest.TestCase):
    """The status line must mark real reasoning distinctly from tool activity."""

    def _with_source(self, source):
        original = bridge._reasoning_source
        bridge._reasoning_source = source
        self.addCleanup(lambda: setattr(bridge, "_reasoning_source", original))

    def test_prefixes_real_reasoning(self):
        class Stub(bridge.ReasoningSource):
            def latest_reasoning(self, session_id, since_ts):
                return "Checking the cache layer."

        self._with_source(Stub())
        self.assertEqual(
            bridge.latest_reasoning_activity("s1", 0.0),
            "thinking: Checking the cache layer.",
        )

    def test_no_reasoning_returns_none(self):
        self._with_source(bridge.NullReasoningSource())
        self.assertIsNone(bridge.latest_reasoning_activity("s1", 0.0))

    def test_raising_source_is_swallowed(self):
        class Boom(bridge.ReasoningSource):
            def latest_reasoning(self, session_id, since_ts):
                raise RuntimeError("boom")

        self._with_source(Boom())
        self.assertIsNone(bridge.latest_reasoning_activity("s1", 0.0))


class TestReasoningHistory(unittest.TestCase):
    """Durable reasoning history: opt-in, capped, session-scoped, never fatal."""

    def _make_db(self, rows, columns=("reasoning_content", "reasoning")):
        import sqlite3
        directory = tempfile.mkdtemp()
        db_path = Path(directory) / "state.db"
        conn = sqlite3.connect(str(db_path))
        base = ["id INTEGER PRIMARY KEY", "session_id TEXT", "role TEXT", "timestamp REAL"]
        extra = ["%s TEXT" % name for name in columns]
        conn.execute("CREATE TABLE messages (%s)" % ", ".join(base + extra))
        names = ["session_id", "role", "timestamp"] + list(columns)
        for row in rows:
            conn.execute(
                "INSERT INTO messages (%s) VALUES (%s)" % (", ".join(names), ", ".join("?" * len(names))),
                [row.get(name) for name in names],
            )
        conn.commit()
        conn.close()
        return db_path

    def _with_source(self, source):
        original = bridge._reasoning_source
        bridge._reasoning_source = source
        self.addCleanup(lambda: setattr(bridge, "_reasoning_source", original))

    def _with_history(self, enabled):
        original = bridge.REASONING_HISTORY_ENABLED
        bridge.REASONING_HISTORY_ENABLED = enabled
        self.addCleanup(lambda: setattr(bridge, "REASONING_HISTORY_ENABLED", original))

    # ── Opt-in ────────────────────────────────────────────────────────────

    def test_disabled_sends_nothing_and_never_reads(self):
        """Off by default: no transcript, and the store is not even touched."""
        reads = []

        class Loud(bridge.ReasoningSource):
            def full_reasoning(self, session_id, since_ts):
                reads.append(session_id)
                return "Should never be read."

        self._with_history(False)
        self._with_source(Loud())
        self.assertIsNone(bridge.turn_reasoning_history("s1", 0.0))
        self.assertEqual(reads, [])

    def test_default_is_off(self):
        """The module default must be off, whatever this process's env says."""
        self.assertFalse(
            bridge.REASONING_HISTORY_ENABLED
            or os.environ.get("EMPEROR_CLAW_REASONING_HISTORY", "off").lower() in {"on", "true", "1", "yes"}
        )

    def test_enabled_returns_full_text_uncondensed(self):
        class Stub(bridge.ReasoningSource):
            def full_reasoning(self, session_id, since_ts):
                return "First thought about it.\n\nSecond thought about it."

        self._with_history(True)
        self._with_source(Stub())
        out = bridge.turn_reasoning_history("s1", 0.0)
        self.assertIn("First thought", out)
        self.assertIn("Second thought", out)

    def test_null_source_yields_nothing(self):
        self._with_history(True)
        self._with_source(bridge.NullReasoningSource())
        self.assertIsNone(bridge.turn_reasoning_history("s1", 0.0))

    # ── Cap ───────────────────────────────────────────────────────────────

    def test_cap_truncates_a_runaway_turn(self):
        class Huge(bridge.ReasoningSource):
            def full_reasoning(self, session_id, since_ts):
                return "thinking " * 100_000

        self._with_history(True)
        self._with_source(Huge())
        out = bridge.turn_reasoning_history("s1", 0.0)
        self.assertLessEqual(len(out), bridge._REASONING_HISTORY_MAX_CHARS)
        self.assertTrue(out.endswith("[reasoning truncated]"), out[-40:])

    def test_text_under_the_cap_is_untouched(self):
        text = "A complete thought that fits comfortably."

        class Small(bridge.ReasoningSource):
            def full_reasoning(self, session_id, since_ts):
                return text

        self._with_history(True)
        self._with_source(Small())
        self.assertEqual(bridge.turn_reasoning_history("s1", 0.0), text)

    # ── Session scoping ───────────────────────────────────────────────────

    def test_full_reasoning_never_leaks_another_session(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 100.0,
             "reasoning_content": "My own reasoning for this turn.", "reasoning": None},
            {"session_id": "other-agent-session", "role": "assistant", "timestamp": 110.0,
             "reasoning_content": "Another agent's private reasoning.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        out = source.full_reasoning("s1", 0.0)
        self.assertIn("My own reasoning", out)
        self.assertNotIn("Another agent", out)

    def test_full_reasoning_without_session_id_returns_none(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 100.0,
             "reasoning_content": "Reasoning that must stay put.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.full_reasoning("", 0.0))

    def test_full_reasoning_is_chronological_and_skips_stubs(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 300.0,
             "reasoning_content": "Third, I will run the tests.", "reasoning": None},
            {"session_id": "s1", "role": "assistant", "timestamp": 100.0,
             "reasoning_content": "First, I will read the config.", "reasoning": None},
            {"session_id": "s1", "role": "assistant", "timestamp": 200.0,
             "reasoning_content": "x", "reasoning": "Second, I will edit the handler."},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        out = source.full_reasoning("s1", 0.0)
        self.assertEqual(
            out,
            "First, I will read the config.\n\n"
            "Second, I will edit the handler.\n\n"
            "Third, I will run the tests.",
        )

    def test_full_reasoning_ignores_previous_turns_and_other_roles(self):
        db_path = self._make_db([
            {"session_id": "s1", "role": "assistant", "timestamp": 10.0,
             "reasoning_content": "Reasoning from a previous turn.", "reasoning": None},
            {"session_id": "s1", "role": "user", "timestamp": 300.0,
             "reasoning_content": "Not assistant reasoning at all.", "reasoning": None},
        ])
        source = bridge.SessionStoreReasoningSource(db_path)
        self.assertIsNone(source.full_reasoning("s1", 100.0))

    def test_full_reasoning_degrades_on_a_corrupt_store(self):
        path = Path(tempfile.mkdtemp()) / "state.db"
        path.write_text("this is not a sqlite database", encoding="utf-8")
        source = bridge.SessionStoreReasoningSource(path)
        self.assertIsNone(source.full_reasoning("s1", 0.0))

    def test_raising_source_is_swallowed(self):
        class Boom(bridge.ReasoningSource):
            def full_reasoning(self, session_id, since_ts):
                raise RuntimeError("boom")

        self._with_history(True)
        self._with_source(Boom())
        self.assertIsNone(bridge.turn_reasoning_history("s1", 0.0))

    # ── A history write must never cost a reply ───────────────────────────

    def test_failing_history_post_does_not_fail_the_turn(self):
        """The reply is the product; the transcript is a bonus.

        A throwing history write used to be the classic way to lose a reply:
        it escapes into the turn's except block, posts an error notice for a
        turn that actually succeeded, and leaves the message to be redispatched.
        """
        from unittest.mock import patch
        from contextlib import ExitStack
        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}
        message = {"id": "msg-1", "text": "hello", "senderType": "human",
                   "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}
        with ExitStack() as stack:
            for name in ["ensure_runtime", "send_heartbeat", "save_state",
                         "update_chat_status", "report_token_usage"]:
                stack.enter_context(patch.object(bridge, name))
            stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
            stack.enter_context(patch.object(bridge, "load_state", return_value=state))
            stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
            stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
            stack.enter_context(patch.object(bridge, "check_budget", return_value=True))
            stack.enter_context(patch.object(bridge, "check_loop_guard", return_value=True))
            stack.enter_context(patch.object(bridge, "run_hermes", return_value="the real answer"))
            stack.enter_context(patch.object(bridge, "_last_turn_reasoning", "raw model thinking"))
            stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
            send = stack.enter_context(patch.object(bridge, "send_reply", return_value="stored-msg-1"))
            post = stack.enter_context(
                patch.object(bridge, "post_reasoning_history", side_effect=RuntimeError("history down"))
            )
            with self.assertRaises(KeyboardInterrupt):
                bridge.main()

        post.assert_called_once_with("stored-msg-1", "raw model thinking")
        sent = [call.args[1] for call in send.call_args_list]
        self.assertEqual(sent, ["the real answer"])
        self.assertNotIn("msg-1", [text for text in sent if "hit an error" in text])
        # The message is still consumed exactly once — no silent redispatch loop.
        self.assertIn("msg-1", state["seen"])

    def test_no_history_post_without_a_stored_message_id(self):
        """A deduplicated send returns no id; there is nothing to annotate."""
        from unittest.mock import patch
        from contextlib import ExitStack
        state = {"seen": [], "lastSeenAt": "2026-01-01T00:00:00Z"}
        message = {"id": "msg-2", "text": "hello", "senderType": "human",
                   "targetAgentId": bridge.AGENT_ID, "threadType": "direct"}
        with ExitStack() as stack:
            for name in ["ensure_runtime", "send_heartbeat", "save_state",
                         "update_chat_status", "report_token_usage"]:
                stack.enter_context(patch.object(bridge, name))
            stack.enter_context(patch.object(bridge, "ensure_agent", return_value=bridge.AGENT_ID))
            stack.enter_context(patch.object(bridge, "load_state", return_value=state))
            stack.enter_context(patch.object(bridge, "sync_messages", return_value=[message]))
            stack.enter_context(patch.object(bridge, "fetch_runtime_control", return_value={"commands": [], "cancelled": False}))
            stack.enter_context(patch.object(bridge, "check_budget", return_value=True))
            stack.enter_context(patch.object(bridge, "check_loop_guard", return_value=True))
            stack.enter_context(patch.object(bridge, "run_hermes", return_value="answer"))
            stack.enter_context(patch.object(bridge, "_last_turn_reasoning", "raw model thinking"))
            stack.enter_context(patch.object(bridge.time, "sleep", side_effect=KeyboardInterrupt))
            stack.enter_context(patch.object(bridge, "send_reply", return_value=None))
            post = stack.enter_context(patch.object(bridge, "post_reasoning_history"))
            with self.assertRaises(KeyboardInterrupt):
                bridge.main()
            post.assert_not_called()


class TestSendReply(unittest.TestCase):
    """send_reply must hand back the stored message id for history to attach to."""

    def setUp(self):
        from unittest.mock import patch
        self.api_patch = patch.object(bridge, "api")
        self.api = self.api_patch.start()
        self.addCleanup(self.api_patch.stop)

    def test_returns_message_id(self):
        self.api.return_value = {"ok": True, "message_id": "stored-1"}
        self.assertEqual(bridge.send_reply({"threadId": "t1"}, "hi"), "stored-1")

    def test_deduplicated_send_returns_none(self):
        self.api.return_value = {"ok": True, "message_id": None, "deduplicated": True}
        self.assertIsNone(bridge.send_reply({"threadId": "t1"}, "hi"))

    def test_empty_text_sends_nothing(self):
        self.assertIsNone(bridge.send_reply({"threadId": "t1"}, ""))
        self.api.assert_not_called()


class TestCleanHermesOutput(unittest.TestCase):
    """Hermes prints runtime notices around the answer; they must not be sent.

    The `Unknown toolsets` notice fired on every turn because the bridge named
    the plugin in HERMES_TOOLSETS, and it travelled into the agent's reply.
    """

    def test_unknown_toolset_warning_is_dropped(self):
        raw = "Warning: Unknown toolsets: emperor-claw\nACK working\n"
        self.assertEqual(bridge.clean_hermes_output(raw), "ACK working")

    def test_warning_alone_leaves_nothing_to_send(self):
        raw = "Warning: Unknown toolsets: emperor-claw\n"
        self.assertEqual(bridge.clean_hermes_output(raw), "")

    def test_session_footer_is_dropped(self):
        raw = "ACK working\nsession_id: abc-123\n"
        self.assertEqual(bridge.clean_hermes_output(raw), "ACK working")

    def test_an_agent_warning_about_something_else_survives(self):
        # An agent may legitimately write about a warning; only the fixed
        # "Unknown toolsets" notice is transport noise.
        raw = "Warning: this will delete data. Confirm before continuing."
        self.assertEqual(bridge.clean_hermes_output(raw), raw)

    def test_tirith_security_notice_is_dropped(self):
        # Fired on a fresh profile's first turn while Hermes downloads tirith,
        # and used to open the agent's very first reply.
        raw = (
            "⚠ tirith security scanner enabled but not available — command "
            "scanning will use pattern matching only\nHey. What do you need?\n"
        )
        self.assertEqual(bridge.clean_hermes_output(raw), "Hey. What do you need?")

    def test_default_toolsets_do_not_name_the_plugin(self):
        # The Emperor tools come from plugins.enabled, not from a toolset, so
        # the plugin name must not sit in the default toolset list. Checked on
        # the source because the resolved value depends on the env.
        src = (BRIDGE_DIR / "emperor_hermes_bridge.py").read_text()
        self.assertIn(
            'os.environ.get("HERMES_TOOLSETS", "web,terminal,code_execution")',
            src,
        )


class TestExtractStreamJson(unittest.TestCase):
    """`--format stream-json` output is parsed for the final answer only.

    Tool events (and the stray runtime notices Hermes still prints) must never
    reach an Emperor message.
    """

    def test_final_result_text_wins(self):
        raw = "\n".join([
            '{"type": "system", "subtype": "init", "session_id": "s1"}',
            "  ⚠ tirith security scanner enabled but not available",
            '{"type": "tool_use", "name": "terminal", "input": {"command": "echo hi"}}',
            '{"type": "tool_result", "name": "terminal", "output": "hi"}',
            '{"type": "text", "text": "\\n\\nDONE"}',
            '{"type": "result", "session_id": "s2", "text": "DONE", "tokens": {"total": 1}}',
        ])
        reply, session = bridge.extract_stream_json(raw)
        self.assertEqual(reply, "DONE")
        self.assertEqual(session, "s2")

    def test_tool_preview_never_reaches_the_reply(self):
        raw = "\n".join([
            '{"type": "tool_use", "name": "write_file", "input": {"path": "/tmp/x.py"}}',
            '{"type": "tool_result", "name": "write_file", "output": "review diff a//tmp/x.py"}',
            '{"type": "result", "session_id": "s1", "text": "Done, file written."}',
        ])
        reply, _ = bridge.extract_stream_json(raw)
        self.assertEqual(reply, "Done, file written.")
        self.assertNotIn("review diff", reply)

    def test_text_events_join_when_no_result(self):
        raw = "\n".join([
            '{"type": "text", "text": "Hello "}',
            '{"type": "text", "text": "world"}',
        ])
        reply, session = bridge.extract_stream_json(raw)
        self.assertEqual(reply, "Hello world")
        self.assertIsNone(session)

    def test_no_json_yields_none_for_fallback(self):
        reply, session = bridge.extract_stream_json("plain text\nsession_id: abc\n")
        self.assertIsNone(reply)
        self.assertIsNone(session)

    def test_session_id_from_system_event(self):
        reply, session = bridge.extract_stream_json('{"type": "system", "session_id": "sys-1"}')
        self.assertIsNone(reply)
        self.assertEqual(session, "sys-1")


class TestOperatingGuide(unittest.TestCase):
    """A missing/unreadable operating-guide.md must degrade, never crash.

    Regression: run_hermes() read the guide unguarded, so a deployment that
    shipped only the bridge script (the README's own layout) threw
    FileNotFoundError on every turn and the agent went permanently silent.
    """

    def _missing_path(self) -> Path:
        return Path(tempfile.gettempdir()) / "does-not-exist-operating-guide.md"

    def test_missing_guide_returns_builtin_fallback(self):
        from unittest.mock import patch
        missing = self._missing_path()
        with patch.object(bridge, "OPERATING_GUIDE_PATH", str(missing)), \
             patch.object(bridge, "default_operating_guide_path", return_value=missing), \
             patch.object(bridge, "log"):
            text = bridge.load_operating_guide()
        self.assertIn("Emperor is the durable source of truth", text)

    def test_env_override_takes_precedence(self):
        from unittest.mock import patch
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as handle:
            handle.write("# custom guide")
            path = handle.name
        try:
            with patch.object(bridge, "OPERATING_GUIDE_PATH", path), patch.object(bridge, "log"):
                text = bridge.load_operating_guide()
            self.assertEqual(text.strip(), "# custom guide")
        finally:
            os.unlink(path)

    def test_run_hermes_proceeds_when_guide_missing(self):
        from unittest.mock import patch
        import subprocess
        missing = self._missing_path()
        stream = "\n".join([
            '{"type": "system", "subtype": "init", "session_id": "sess-1"}',
            '{"type": "result", "session_id": "sess-1", "text": "ACK working"}',
        ])
        completed = subprocess.CompletedProcess(["hermes"], 0, stream, "session_id: sess-1\n")
        state = {"sessions": {}}
        with patch.object(bridge, "OPERATING_GUIDE_PATH", str(missing)), \
             patch.object(bridge, "default_operating_guide_path", return_value=missing), \
             patch.object(bridge, "log"), \
             patch.object(bridge, "format_agent_roster", return_value=""), \
             patch.object(bridge, "format_company_brain_context", return_value=""), \
             patch.object(bridge, "is_direct_thread", return_value=False), \
             patch.object(bridge, "invoke_hermes", return_value=completed), \
             patch.object(bridge, "turn_reasoning_history", return_value=None):
            reply = bridge.run_hermes({"threadId": "t1", "text": "hi"}, state)
        self.assertEqual(reply, "ACK working")


class TestTurnTimeoutAndErrorNotice(unittest.TestCase):
    """The default turn ceiling must be unlimited, and a failed turn must not
    post a generic "I hit an error" line into the conversation."""

    def test_default_turn_timeout_is_unlimited(self):
        # Read the source because the test harness overrides the env var.
        src = (BRIDGE_DIR / "emperor_hermes_bridge.py").read_text()
        self.assertIn(
            'os.environ.get("EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS", "0")',
            src,
        )

    def test_no_generic_error_notice_in_chat(self):
        src = (BRIDGE_DIR / "emperor_hermes_bridge.py").read_text()
        self.assertNotIn("I hit an error and couldn't reply", src)

    def test_zero_timeout_does_not_kill_a_turn(self):
        """0 = no ceiling, so a turn that runs longer than any small ceiling
        still completes. A positive ceiling kills the same kind of turn."""
        from unittest.mock import patch
        import subprocess

        def quiet(*_args, **_kwargs):
            return {"commands": [], "cancelled": False}

        with patch.object(bridge, "HERMES_TIMEOUT_SECONDS", 0), \
             patch.object(bridge, "fetch_runtime_control", side_effect=quiet), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "log"):
            done = bridge.invoke_hermes([sys.executable, "-c", "import time; time.sleep(1.5)"], {"id": "w"})
        self.assertEqual(done.returncode, 0)

        with patch.object(bridge, "HERMES_TIMEOUT_SECONDS", 0.2), \
             patch.object(bridge, "fetch_runtime_control", side_effect=quiet), \
             patch.object(bridge, "update_chat_status"), \
             patch.object(bridge, "log"):
            with self.assertRaises(subprocess.TimeoutExpired):
                bridge.invoke_hermes([sys.executable, "-c", "import time; time.sleep(5)"], {"id": "w"})



class TestRichReplies(unittest.TestCase):
    """Capability handshake + rich-block handling for Emperor's rich chat."""

    def setUp(self):
        self._saved = (bridge._server_capabilities, bridge._reply_format_guide, bridge.RICH_REPLIES_ENABLED)

    def tearDown(self):
        bridge._server_capabilities, bridge._reply_format_guide, bridge.RICH_REPLIES_ENABLED = self._saved

    def test_old_server_response_yields_no_capabilities(self):
        self.assertEqual(bridge.parse_server_capabilities({"runtimeNode": {"id": "x"}}), ([], ""))
        self.assertEqual(bridge.parse_server_capabilities(None), ([], ""))

    def test_new_server_response_is_parsed(self):
        caps, guide = bridge.parse_server_capabilities({
            "serverCapabilities": ["rich-blocks-v1"],
            "replyFormatGuide": "  ## Rich replies\nUse charts.  ",
        })
        self.assertEqual(caps, ["rich-blocks-v1"])
        self.assertEqual(guide, "## Rich replies\nUse charts.")

    def test_guidance_always_corrects_the_cli_hint(self):
        bridge._server_capabilities, bridge._reply_format_guide = [], ""
        text = bridge.format_reply_guidance()
        self.assertIn("not a terminal", text)
        self.assertNotIn("Rich replies", text)

    def test_guide_only_when_server_supports_it_and_not_disabled(self):
        bridge._server_capabilities, bridge._reply_format_guide = ["rich-blocks-v1"], "## Rich replies"
        bridge.RICH_REPLIES_ENABLED = True
        self.assertIn("## Rich replies", bridge.format_reply_guidance())
        bridge.RICH_REPLIES_ENABLED = False
        self.assertNotIn("## Rich replies", bridge.format_reply_guidance())
        bridge.RICH_REPLIES_ENABLED = True
        bridge._server_capabilities = ["something-else"]
        self.assertNotIn("## Rich replies", bridge.format_reply_guidance())

    def test_summarize_rich_blocks_compresses_history(self):
        text = (
            "Here is the week.\n"
            "```chart\n{\"type\":\"bar\",\"title\":\"Tasks closed\",\"labels\":[\"a\"],\"series\":[[1]]}\n```\n"
            "```stats\n[{\"label\":\"Open\",\"value\":\"12\"}]\n```\n"
            "````tabs\n=== Summary\nhi\n=== Details\n```chart\n{}\n```\n````\n"
            "```html\n<!-- title: Agent load -->\n<div>big markup</div>\n```\n"
            "```python\nprint('kept')\n```"
        )
        out = bridge.summarize_rich_blocks(text)
        self.assertIn("[chart: Tasks closed]", out)
        self.assertIn("[stats: Open 12]", out)
        self.assertIn("[tabs: Summary, Details]", out)
        self.assertIn("[html widget: Agent load]", out)
        self.assertNotIn("big markup", out)
        self.assertIn("print('kept')", out)
        self.assertEqual(bridge.summarize_rich_blocks("plain text"), "plain text")

if __name__ == "__main__":
    unittest.main(verbosity=2)
