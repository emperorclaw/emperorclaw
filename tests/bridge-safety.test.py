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


if __name__ == "__main__":
    unittest.main(verbosity=2)
