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


class FullStaticBlockSnapshotTests(unittest.TestCase):
    """Full mode must stay byte-identical to the pre-lean static block."""

    def _build(self):
        with patch.object(bridge, "CONTEXT_MODE", "full"), \
                patch.object(bridge, "format_agent_roster", return_value="ROSTER"), \
                patch.object(bridge, "format_company_brain_context", return_value="BRAIN"), \
                patch.object(bridge, "refresh_live_profile"), \
                patch.object(bridge, "current_instructions", return_value="INSTR"), \
                patch.object(bridge, "format_memory_context", return_value="MEM\n\n"), \
                patch.object(bridge, "load_operating_guide", return_value="GUIDE"), \
                patch.object(bridge, "format_reply_guidance", return_value="FORMAT"):
            return bridge.build_static_block({}, {})

    def test_full_block_matches_the_known_snapshot(self):
        expected = (
            "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
            f"Agent name: {bridge.AGENT_NAME}\n"
            f"Agent role: {bridge.AGENT_ROLE}\n"
            "Role instructions:\nINSTR\n\n"
            "MEM\n\n"
            "GUIDE\n\n"
            "Reply to the latest message. Do not recap old context unless asked.\n"
            "Use Emperor tools only when the request needs durable state, exact chat history, or a real state change.\n"
            "For reusable knowledge, create or update a normal Company Brain note with top-level status: active for established knowledge; use status: draft only when explicitly uncertain.\n"
            "When writing Knowledge & Rules, use Obsidian-style markdown notes: frontmatter with scope/type/status/owner/tags, one reusable rule per note, explicit [[wikilinks]], and Evidence/Related sections when useful.\n"
            "Do not fake folders in note titles; Emperor places notes by company/customer/project/agent scope.\n"
            "Do not mention projects, tasks, resources, or Storage unless they are relevant to the user's request.\n"
            "Emperor is the source of truth. If local memory and Emperor disagree, prefer Emperor and surface the mismatch.\n\n"
            "FORMAT\n\n"
            "Where to look in Emperor:\n"
            "- Past chat/history: emperor_list_threads, then emperor_get_thread_messages.\n"
            "- Team roster: emperor_request GET /agents.\n"
            "- Projects/tasks: use emperor_get_task_overview first for status questions; use emperor_get_task only for a selected task.\n"
            "- Task progress/history: emperor_request GET /tasks/{id}/notes.\n"
            "- Company Brain / Knowledge & Rules: emperor_request GET /resources/context for resolved context, POST /resources for established knowledge (active) or uncertain proposals (draft), with top-level status, GET /resources for lookup.\n"
            "- Storage/files: emperor_request GET /artifacts for lookup; emperor_create_folder + emperor_upload_artifact for uploads.\n"
            "- External APIs are not Emperor; use terminal/curl or a dedicated plugin if available.\n\n"
            "Storage rules:\n"
            "- Storage is an Emperor abstraction; do not ask for or mention backing blob-provider keys.\n"
            "- For uploads, create/find the folder first, pass folderId to emperor_upload_artifact, then verify and report artifact id/path.\n"
            "- Do not upload randomly into the Storage root. Use customer/project/month/type folders when possible.\n"
            "- If upload fails, report an Emperor Storage upload failure with the tool error.\n\n"
            "Messaging model:\n"
            "- Direct threads are private one-human-to-one-agent conversations. Reply normally in direct threads.\n"
            "- Your answer is delivered to the current thread automatically. Do NOT call emperor_send_message to reply to the message you are answering — that posts a duplicate. Use emperor_send_message only to message a DIFFERENT thread (a sibling handoff in team chat).\n"
            "- Team chat is the shared visible coordination thread for humans and all agents.\n"
            "- Group chats are members-only team channels (e.g. a development team): the same @mention rules apply, and only their members receive them. Find yours with emperor_list_groups. A human's @all in a group is addressed to you; never write @all yourself.\n"
            "- ONLY respond to a team chat message if your @name appears in it. If your name is absent, the message is for someone else — stay silent.\n"
            "- To ask a sibling to do something: post in team chat with @SiblingName and one concrete request (use the roster below for the exact @name).\n"
            "- When a sibling @mentions you with a request, complete the work then reply with the answer and @mention them ONCE so it routes back. That reply CLOSES the request.\n"
            "- If you receive a reply that answers a request YOU made, do not reply again — no 'thanks', no acknowledgment, no follow-up @mention. A closing reply ends the exchange; only reply if you have a genuinely new, different request.\n"
            "- Never @mention the same agent twice in a row without a new human message or a materially new question in between — that is what causes infinite back-and-forth.\n"
            "- Informational updates (status, FYI, task done with no one waiting) go to team chat with NO @mention.\n"
            "- Safety net: if you and a sibling exchange more than a few consecutive messages in team chat with no human input, the bridge will automatically pause your replies in that thread until a human sends a new message. Don't rely on this — follow the rules above so it never triggers.\n\n"
            "ROSTER\n\n"
            "BRAIN\n\n"
        )
        self.assertEqual(self._build(), expected)


LEAN_PAYLOAD = {
    "version": 1,
    "kernel": "KERNEL",
    "knowledgeIndex": "note-a — summary — id-a",
    "alwaysBlock": "ALWAYS",
    "roster": "@Ada — developer",
    "alwaysOverBudget": False,
    "alwaysUsedChars": 6,
}


class LeanStaticBlockTests(unittest.TestCase):
    """Lean mode sends the kernel + index + roster and drops the operating
    guide, the static rules, the rich-reply guide, and the brain bodies."""

    def test_lean_block_contains_kernel_index_roster_and_one_formatting_line(self):
        with patch.object(bridge, "refresh_live_profile"), \
                patch.object(bridge, "current_instructions", return_value="INSTR"), \
                patch.object(bridge, "format_memory_context", return_value="MEM\n\n"), \
                patch.object(bridge, "load_operating_guide", side_effect=AssertionError("lean must not load the operating guide")):
            block = bridge.build_lean_static_block(LEAN_PAYLOAD)
        for needle in [
            "KERNEL",
            "ALWAYS",
            "note-a — summary — id-a",
            "@Ada — developer",
            "Company knowledge index — load a note with emperor_get_knowledge_note, search with emperor_search_knowledge",
            "Formatting: plain markdown; for rich blocks load manual section reply-formatting",
        ]:
            self.assertIn(needle, block)
        for excluded in [
            "Where to look in Emperor",
            "Storage rules:",
            "Messaging model:",
            "Company Brain",
            "Reply to the latest message",
            "Shared Knowledge & Rules",
        ]:
            self.assertNotIn(excluded, block)

    def test_lean_dispatch_uses_the_cached_payload_and_skips_the_full_path(self):
        with patch.object(bridge, "CONTEXT_MODE", "lean"), \
                patch.object(bridge, "_server_capabilities", [bridge.LEAN_CONTEXT_CAPABILITY]), \
                patch.object(bridge, "fetch_lean_context", return_value=LEAN_PAYLOAD) as fetch, \
                patch.object(bridge, "build_lean_static_block", return_value="LEAN") as lean_build, \
                patch.object(bridge, "build_full_static_block", side_effect=AssertionError("must not build full")):
            self.assertEqual(bridge.build_static_block({}, {}), "LEAN")
        fetch.assert_called_once()
        lean_build.assert_called_once_with(LEAN_PAYLOAD)


class LeanCapabilityGateTests(unittest.TestCase):
    def setUp(self):
        self._saved_caps = list(bridge._server_capabilities)
        self._saved_mode = bridge.CONTEXT_MODE
        self._saved_logged = bridge._lean_gate_logged

    def tearDown(self):
        bridge._server_capabilities = self._saved_caps
        bridge.CONTEXT_MODE = self._saved_mode
        bridge._lean_gate_logged = self._saved_logged

    def test_full_mode_is_never_active(self):
        bridge.CONTEXT_MODE = "full"
        bridge._server_capabilities = [bridge.LEAN_CONTEXT_CAPABILITY]
        self.assertFalse(bridge.lean_context_active())

    def test_lean_without_capability_falls_back_to_full(self):
        bridge.CONTEXT_MODE = "lean"
        bridge._server_capabilities = []
        bridge._lean_gate_logged = False
        self.assertFalse(bridge.lean_context_active())
        self.assertTrue(bridge._lean_gate_logged)

    def test_lean_with_capability_is_active(self):
        bridge.CONTEXT_MODE = "lean"
        bridge._server_capabilities = [bridge.LEAN_CONTEXT_CAPABILITY]
        self.assertTrue(bridge.lean_context_active())


class LeanCacheTests(unittest.TestCase):
    def setUp(self):
        self._saved_cache = dict(bridge._lean_cache)
        self._saved_agent = bridge.AGENT_ID
        self._saved_failure_logged = bridge._lean_failure_logged
        bridge._lean_cache.update({"agentId": "", "etag": "", "payload": None, "checkedAt": 0.0})
        bridge.AGENT_ID = "agent-1"

    def tearDown(self):
        bridge._lean_cache.clear()
        bridge._lean_cache.update(self._saved_cache)
        bridge.AGENT_ID = self._saved_agent
        bridge._lean_failure_logged = self._saved_failure_logged

    def test_fetch_once_then_served_from_cache(self):
        with patch.object(bridge, "_get_with_etag", return_value=(200, LEAN_PAYLOAD, '"v1"')) as get:
            first = bridge.fetch_lean_context()
            second = bridge.fetch_lean_context()
        get.assert_called_once()
        self.assertEqual(first, LEAN_PAYLOAD)
        self.assertIs(second, first)

    def test_revalidation_304_keeps_the_cached_payload(self):
        with patch.object(bridge, "_get_with_etag", return_value=(200, LEAN_PAYLOAD, '"v1"')):
            bridge.fetch_lean_context()
        bridge._lean_cache["checkedAt"] = 0.0  # force the cached value to look stale
        with patch.object(bridge, "_get_with_etag", return_value=(304, None, '"v1"')) as get:
            payload = bridge.fetch_lean_context()
        self.assertEqual(payload, LEAN_PAYLOAD)
        self.assertEqual(get.call_args.kwargs["etag"], '"v1"')

    def test_failed_fetch_returns_the_last_cached_payload(self):
        with patch.object(bridge, "_get_with_etag", return_value=(200, LEAN_PAYLOAD, '"v1"')):
            bridge.fetch_lean_context()
        bridge._lean_cache["checkedAt"] = 0.0
        with patch.object(bridge, "_get_with_etag", side_effect=RuntimeError("network")):
            self.assertEqual(bridge.fetch_lean_context(), LEAN_PAYLOAD)

    def test_failed_fetch_with_no_cache_returns_none(self):
        with patch.object(bridge, "_get_with_etag", side_effect=RuntimeError("network")):
            self.assertIsNone(bridge.fetch_lean_context())

    def test_dispatch_falls_back_to_full_when_no_cached_payload(self):
        with patch.object(bridge, "CONTEXT_MODE", "lean"), \
                patch.object(bridge, "_server_capabilities", [bridge.LEAN_CONTEXT_CAPABILITY]), \
                patch.object(bridge, "fetch_lean_context", return_value=None), \
                patch.object(bridge, "build_full_static_block", return_value="FULL"):
            self.assertEqual(bridge.build_static_block({}, {}), "FULL")


if __name__ == "__main__":
    unittest.main()
