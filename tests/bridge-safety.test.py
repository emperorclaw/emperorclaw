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
        state = bridge.load_state()
        self.assertEqual(state, {"seen": [], "lastSeenAt": None})


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
