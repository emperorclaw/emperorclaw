import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/bridge"))
import emperor_hermes_bridge as bridge


class ProcessedDeliveryStateTests(unittest.TestCase):
    """A peer @mention in a shared room must never be skipped as "already
    resolved": the server stamps every agent post in a team/group room
    `deliveryState: "resolved"` by default, and the bridge previously dropped
    those before routing, so agents never answered each other."""

    def test_agent_group_mention_is_not_treated_as_processed(self):
        message = {
            "deliveryState": "resolved",
            "threadType": "group",
            "senderType": "agent",
            "text": "@Peer do the thing",
            "addressedToYou": True,
        }
        self.assertFalse(bridge.is_processed_delivery_state(message))

    def test_agent_team_message_is_not_treated_as_processed(self):
        message = {"deliveryState": "resolved", "threadType": "team", "senderType": "agent"}
        self.assertFalse(bridge.is_processed_delivery_state(message))

    def test_agent_pair_thread_message_is_not_treated_as_processed(self):
        message = {
            "deliveryState": "resolved",
            "threadType": "group",
            "isAgentPair": True,
            "targetAgentId": "peer",
            "senderType": "agent",
        }
        self.assertFalse(bridge.is_processed_delivery_state(message))

    def test_snake_case_thread_type_is_understood(self):
        message = {"delivery_state": "resolved", "thread_type": "group", "senderType": "agent"}
        self.assertFalse(bridge.is_processed_delivery_state(message))

    def test_queued_shared_message_is_not_treated_as_processed(self):
        message = {"deliveryState": "queued", "threadType": "group", "senderType": "human"}
        self.assertFalse(bridge.is_processed_delivery_state(message))

    def test_resolved_direct_message_is_still_treated_as_processed(self):
        message = {"deliveryState": "resolved", "threadType": "direct"}
        self.assertTrue(bridge.is_processed_delivery_state(message))

    def test_cancelled_direct_message_is_still_treated_as_processed(self):
        message = {"deliveryState": "cancelled", "threadType": "direct"}
        self.assertTrue(bridge.is_processed_delivery_state(message))

    def test_resolved_message_without_thread_type_is_treated_as_processed(self):
        self.assertTrue(bridge.is_processed_delivery_state({"deliveryState": "resolved"}))


class OrganizationContextTests(unittest.TestCase):
    """The per-turn org block is a fixed-shape, <=400 char reminder (leader +
    this agent's reporting line), not the full reporting graph. GET /organization
    is fetched once and cached for ten minutes; a failed fetch keeps the last
    successful block."""

    def setUp(self):
        bridge._organization_cache["info"] = None
        bridge._organization_cache["fetchedAt"] = 0.0

    def _block(self, info, agent_id):
        with patch.object(bridge, "api", return_value=info), patch.object(bridge, "AGENT_ID", agent_id):
            return bridge.format_organization_context()

    def test_compact_block_names_leader_and_reporting_line(self):
        info = {
            "configured": True,
            "leader": {"kind": "human", "id": "h1", "name": "Grace"},
            "reporting": [{"context": "Direct reporting", "reportsTo": {"kind": "agent", "id": "a1", "name": "Ada"}}],
            "teams": [],
        }
        block = self._block(info, "a2")
        self.assertEqual(
            block,
            "Org: leader Grace; you report to Ada\n"
            "Escalate cross-team conflicts to the leader; details: GET /organization.",
        )
        self.assertLessEqual(len(block), 400)

    def test_self_leader_reports_to_humans(self):
        info = {"configured": True, "leader": {"kind": "agent", "id": "a1", "name": "Ada"}, "reporting": [], "teams": []}
        block = self._block(info, "a1")
        self.assertIn("you lead the company; report to humans", block)
        self.assertLessEqual(len(block), 400)

    def test_not_configured_omits_block(self):
        self.assertEqual(self._block({"configured": False}, "a2"), "")

    def test_team_coordinator_is_the_reporting_line(self):
        info = {
            "configured": True,
            "leader": {"kind": "human", "id": "h1", "name": "Grace"},
            "reporting": [],
            "teams": [{"name": "Dev", "coordinator": {"kind": "agent", "id": "a1", "name": "Ada"}}],
        }
        self.assertIn("you report to Ada", self._block(info, "a2"))

    def test_self_coordinator_reports_to_the_leader(self):
        info = {
            "configured": True,
            "leader": {"kind": "human", "id": "h1", "name": "Grace"},
            "reporting": [],
            "teams": [{"name": "Dev", "coordinator": {"kind": "agent", "id": "a1", "name": "Ada"}}],
        }
        self.assertIn("you report to Grace", self._block(info, "a1"))

    def test_fetches_once_then_serves_from_cache(self):
        info = {"configured": True, "leader": {"kind": "human", "id": "h1", "name": "Grace"}, "reporting": [], "teams": []}
        with patch.object(bridge, "api", return_value=info) as api_mock, patch.object(bridge, "AGENT_ID", "a2"):
            bridge.format_organization_context()
            bridge.format_organization_context()
        api_mock.assert_called_once()

    def test_fetch_failure_keeps_last_cached_block(self):
        info = {
            "configured": True,
            "leader": {"kind": "human", "id": "h1", "name": "Grace"},
            "reporting": [{"context": "Direct reporting", "reportsTo": {"kind": "agent", "id": "a1", "name": "Ada"}}],
            "teams": [],
        }
        first = self._block(info, "a2")
        bridge._organization_cache["fetchedAt"] = 0.0  # force the cached value to look stale
        with patch.object(bridge, "api", side_effect=RuntimeError("network")), patch.object(bridge, "AGENT_ID", "a2"):
            second = bridge.format_organization_context()
        self.assertEqual(second, first)
        self.assertNotEqual(second, "")

    def test_block_stays_under_400_chars_with_long_names(self):
        info = {
            "configured": True,
            "leader": {"kind": "human", "id": "h1", "name": "L" * 200},
            "reporting": [{"context": "Direct reporting", "reportsTo": {"kind": "agent", "id": "a1", "name": "R" * 200}}],
            "teams": [],
        }
        self.assertLessEqual(len(self._block(info, "a2")), 400)


if __name__ == "__main__":
    unittest.main()
