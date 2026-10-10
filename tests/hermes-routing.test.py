import sys
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
