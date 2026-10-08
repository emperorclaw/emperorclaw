"""
Tests for the EmperorClaw Hermes Bridge priority queue.

Covers:
- message_priority classification (P0 human DM / approval, P1 task wake,
  P2 pair thread, P3 room mention)
- coalescing: multiple messages from one thread become one turn
- ordering: a human DM jumps ahead of a backlog of room mentions
- anti-starvation: age boosts priority so rooms are never starved
- plan_dispatch preserves every addressed message (unchanged ack semantics)
"""
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent.parent / "integrations" / "hermes" / "emperor-claw" / "bridge"
sys.path.insert(0, str(BRIDGE_DIR))

os.environ.setdefault("EMPEROR_CLAW_API_TOKEN", "test-token")
os.environ.setdefault("EMPEROR_CLAW_API_URL", "http://localhost:3000/api/mcp")
os.environ.setdefault("EMPEROR_CLAW_AGENT_NAME", "TestAgent")
os.environ.setdefault("EMPEROR_CLAW_AGENT_ID", "test-agent-id")

import emperor_hermes_bridge as bridge

AGENT_ID = "test-agent-id"


def ts(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


class TestMessagePriority(unittest.TestCase):
    def test_human_dm_is_p0(self):
        msg = {"senderType": "human", "threadType": "direct", "threadId": "dm-1", "text": "hi"}
        self.assertEqual(bridge.message_priority(msg, AGENT_ID), bridge.PRIORITY_HUMAN_DM)

    def test_route_reason_direct_is_p0(self):
        msg = {"routeReason": "direct", "text": "hi"}
        self.assertEqual(bridge.message_priority(msg, AGENT_ID), bridge.PRIORITY_HUMAN_DM)

    def test_approval_decision_is_p0(self):
        msg = {
            "senderType": "system", "threadType": "direct", "targetAgentId": AGENT_ID,
            "metadataJson": {"approvalDecision": "approved", "approvalId": "a1"}, "text": "Approval granted",
        }
        self.assertEqual(bridge.message_priority(msg, AGENT_ID), bridge.PRIORITY_HUMAN_DM)

    def test_task_wake_is_p1(self):
        msg = {
            "senderType": "system", "threadType": "direct", "targetAgentId": AGENT_ID,
            "metadataJson": {"taskAssigned": True, "taskIds": ["t1"]}, "text": "task assigned",
        }
        self.assertEqual(bridge.message_priority(msg, AGENT_ID), bridge.PRIORITY_TASK_WAKE)

    def test_route_reason_task_assigned_is_p1(self):
        self.assertEqual(bridge.message_priority({"routeReason": "task_assigned"}, AGENT_ID), bridge.PRIORITY_TASK_WAKE)

    def test_pair_thread_is_p2(self):
        self.assertEqual(bridge.message_priority({"routeReason": "agent_pair"}, AGENT_ID), bridge.PRIORITY_PAIR_THREAD)
        self.assertEqual(bridge.message_priority({"isAgentPair": True, "senderType": "agent", "senderId": "other"}, AGENT_ID), bridge.PRIORITY_PAIR_THREAD)

    def test_room_mention_is_p3(self):
        msg = {"senderType": "human", "threadType": "team", "threadId": "team-1", "text": "@TestAgent please look"}
        self.assertEqual(bridge.message_priority(msg, AGENT_ID), bridge.PRIORITY_ROOM)

    def test_unknown_fields_default_to_p3(self):
        # Old servers send no verdict and no richer fields → P3, not dropped.
        msg = {"senderType": "agent", "senderId": "other", "threadId": "g1", "text": "hey"}
        self.assertEqual(bridge.message_priority(msg, AGENT_ID), bridge.PRIORITY_ROOM)


class TestAgeBoost(unittest.TestCase):
    def test_no_age_means_no_boost(self):
        msg = {"createdAt": "2026-01-01T00:00:00Z"}
        now = ts("2026-01-01T00:00:00Z")
        self.assertEqual(bridge.message_age_boost(msg, now), 0)

    def test_boost_after_one_window(self):
        msg = {"createdAt": "2026-01-01T00:00:00Z"}
        now = ts("2026-01-01T00:00:00Z") + bridge.PRIORITY_BOOST_MINUTES * 60
        self.assertEqual(bridge.message_age_boost(msg, now), 1)

    def test_effective_priority_clamps_at_p0(self):
        # A very old P0 DM stays P0 (a room can never outrank a human DM).
        msg = {"senderType": "human", "threadType": "direct", "createdAt": "2026-01-01T00:00:00Z"}
        now = ts("2026-01-01T00:00:00Z") + 100 * bridge.PRIORITY_BOOST_MINUTES * 60
        self.assertEqual(bridge.effective_priority(msg, AGENT_ID, now), bridge.PRIORITY_HUMAN_DM)

    def test_room_promoted_by_age(self):
        msg = {"senderType": "human", "threadType": "team", "text": "@TestAgent", "createdAt": "2026-01-01T00:00:00Z"}
        now = ts("2026-01-01T00:00:00Z") + 2 * bridge.PRIORITY_BOOST_MINUTES * 60
        # P3 boosted two levels → P1.
        self.assertEqual(bridge.effective_priority(msg, AGENT_ID, now), bridge.PRIORITY_TASK_WAKE)


class TestPlanDispatch(unittest.TestCase):
    def test_dm_jumps_ahead_of_room_backlog(self):
        now = ts("2026-01-01T00:10:00Z")
        room = [{"id": f"r{i}", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": f"@TestAgent n{i}", "createdAt": "2026-01-01T00:09:5%sZ" % i} for i in range(3)]
        dm = {"id": "dm", "senderType": "human", "threadType": "direct", "threadId": "dm-1", "text": "urgent", "createdAt": "2026-01-01T00:09:58Z"}
        groups = bridge.plan_dispatch(room + [dm], AGENT_ID, now=now)
        first = groups[0]
        self.assertEqual([m["id"] for m in first], ["dm"])

    def test_coalescing_produces_one_turn_per_thread(self):
        now = ts("2026-01-01T00:10:00Z")
        messages = [
            {"id": "a1", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": "one", "createdAt": "2026-01-01T00:01:00Z"},
            {"id": "a2", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": "two", "createdAt": "2026-01-01T00:02:00Z"},
            {"id": "a3", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": "three", "createdAt": "2026-01-01T00:03:00Z"},
        ]
        groups = bridge.plan_dispatch(messages, AGENT_ID, now=now)
        self.assertEqual(len(groups), 1)
        # Oldest → newest, so the newest is the focus (last element).
        self.assertEqual([m["id"] for m in groups[0]], ["a1", "a2", "a3"])

    def test_starvation_boost_promotes_old_room_over_fresh_pair(self):
        now = ts("2026-01-01T00:10:00Z")
        old_room = {"id": "old", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": "@TestAgent", "createdAt": "2026-01-01T00:00:00Z"}
        fresh_pair = {"id": "pair", "routeReason": "agent_pair", "threadId": "pair-1", "createdAt": "2026-01-01T00:09:00Z"}
        # old room waited 10 minutes → P3 boosted 2 levels → P1; fresh pair is P2.
        groups = bridge.plan_dispatch([fresh_pair, old_room], AGENT_ID, now=now)
        self.assertEqual([m["id"] for m in groups[0]], ["old"])

    def test_preserves_every_message(self):
        now = ts("2026-01-01T00:10:00Z")
        messages = [
            {"id": "dm", "senderType": "human", "threadType": "direct", "threadId": "dm-1", "text": "hi", "createdAt": "2026-01-01T00:09:00Z"},
            {"id": "m1", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": "@TestAgent", "createdAt": "2026-01-01T00:08:00Z"},
            {"id": "m2", "senderType": "human", "threadType": "group", "threadId": "g1", "text": "@TestAgent", "createdAt": "2026-01-01T00:07:00Z"},
        ]
        groups = bridge.plan_dispatch(messages, AGENT_ID, now=now)
        all_ids = [m["id"] for g in groups for m in g]
        self.assertCountEqual(all_ids, ["dm", "m1", "m2"])

    def test_dm_with_backlog_still_wins_over_boosted_room(self):
        now = ts("2026-01-01T00:10:00Z")
        dm = {"id": "dm", "senderType": "human", "threadType": "direct", "threadId": "dm-1", "text": "hi", "createdAt": "2026-01-01T00:09:00Z"}
        room = {"id": "room", "senderType": "human", "threadType": "team", "threadId": "team-1", "text": "@TestAgent", "createdAt": "2026-01-01T00:00:00Z"}
        groups = bridge.plan_dispatch([room, dm], AGENT_ID, now=now)
        self.assertEqual([m["id"] for m in groups[0]], ["dm"])


class TestEarlierMessagesFormatting(unittest.TestCase):
    def test_lists_earlier_messages_oldest_first(self):
        block = bridge.format_earlier_messages([
            {"text": "first request"},
            {"text": "second request"},
        ])
        self.assertIn("Earlier messages in this thread", block)
        self.assertLess(block.index("first request"), block.index("second request"))

    def test_empty_returns_nothing(self):
        self.assertEqual(bridge.format_earlier_messages([]), "")

    def test_long_messages_are_truncated(self):
        block = bridge.format_earlier_messages([{"text": "x" * 500}])
        content = block.splitlines()[-1]
        self.assertTrue(content.startswith("- "))
        self.assertLessEqual(len(content) - 2, bridge.MAX_EARLIER_MESSAGE_CHARS)


class TestCoalescedTurn(unittest.TestCase):
    def test_dynamic_block_includes_earlier_and_latest(self):
        from unittest.mock import patch
        with patch.object(bridge, "format_main_chat_context", return_value=""), patch.object(bridge, "format_group_context", return_value=""), patch.object(bridge, "format_my_open_tasks", return_value=""):
            block = bridge.build_dynamic_block(
                {"threadId": "t1", "text": "the latest"},
                {},
                earlier=[{"text": "the earlier"}],
            )
        self.assertIn("the earlier", block)
        self.assertIn("the latest", block)
        self.assertLess(block.index("the earlier"), block.index("the latest"))


if __name__ == "__main__":
    unittest.main()
