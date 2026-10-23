"""Routing and context selection in bridge 0.9: processed delivery states, the org-chart block and
its cache, full vs lean system prompt, the lean capability gate and the lean ETag cache."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/bridge"))

from emperor_bridge.context import ContextBuilder, format_organization  # noqa: E402
from emperor_bridge.emperor_api import is_processed_delivery_state  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class FakeClient:
    def __init__(self, routes=None, lean=None):
        self.routes = routes or {}
        self.calls = []
        self.lean = list(lean or [])

    async def request(self, method, path, body=None, query=None, **_):
        self.calls.append(path)
        value = self.routes.get(path)
        if isinstance(value, Exception):
            raise value
        return value

    async def get_with_etag(self, path, query, etag):
        self.calls.append(path)
        return self.lean.pop(0) if self.lean else (304, None, etag)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def builder(client, **kw):
    clock = kw.pop("clock", Clock())
    return ContextBuilder(client, agent_id="a1", agent_name="Viktor", agent_role="builder", instructions="Build things.",
                          clock=clock, **kw), clock


class ProcessedDeliveryStateTests(unittest.TestCase):
    def test_shared_rooms_are_never_processed_by_state(self):
        for kind in ("group", "team"):
            self.assertFalse(is_processed_delivery_state({"deliveryState": "resolved", "threadType": kind}))
        self.assertFalse(is_processed_delivery_state({"delivery_state": "resolved", "thread_type": "group"}))

    def test_direct_or_unknown_resolved_and_cancelled_are_processed(self):
        self.assertTrue(is_processed_delivery_state({"deliveryState": "resolved", "threadType": "direct"}))
        self.assertTrue(is_processed_delivery_state({"deliveryState": "cancelled", "threadType": "direct"}))
        self.assertTrue(is_processed_delivery_state({"deliveryState": "resolved"}))
        self.assertFalse(is_processed_delivery_state({"deliveryState": "queued", "threadType": "direct"}))


class OrganizationContextTests(unittest.TestCase):
    INFO = {"configured": True, "leader": {"kind": "human", "name": "Jose"}, "reporting": [{"reportsTo": {"name": "Ada"}}]}

    def test_block_names_leader_and_reporting_line_under_400_chars(self):
        block = format_organization(self.INFO, "a1")
        self.assertTrue(block.startswith("Org: leader Jose; you report to Ada"))
        long = {**self.INFO, "leader": {"name": "J" * 500}}
        self.assertLess(len(format_organization(long, "a1")), 400)

    def test_fetches_once_then_serves_from_cache_and_keeps_it_on_failure(self):
        client = FakeClient({"/organization": self.INFO, "/agents": {"agents": []}})
        ctx, clock = builder(client)
        run(ctx.refresh())
        run(ctx.refresh())
        self.assertEqual(client.calls.count("/organization"), 1)
        clock.now = 601
        client.routes["/organization"] = ConnectionError("down")
        run(ctx.refresh())
        self.assertIn("Org: leader Jose", ctx.system_prompt("t1", "direct")[0])


class SystemPromptTests(unittest.TestCase):
    def test_full_prompt_has_identity_rules_roster_brain_and_thread(self):
        client = FakeClient({"/agents": {"agents": [{"id": "a1", "name": "Viktor"}]},
                             "/resources/context": {"sources": [{"id": "s1", "name": "Doctrine", "content": "Be kind."}]},
                             "/agents/a1/memory": {"instructions": "Live instructions.", "entries": [{"summary": "likes tea"}]}})
        ctx, _ = builder(client)
        ctx.remember_threads({"t1": {"type": "direct", "title": "Jose DM"}})
        run(ctx.refresh())
        text, digest = ctx.system_prompt("t1", "direct")
        for needle in ("Agent name: Viktor", "Live instructions.", "likes tea", "Where to look in Emperor",
                       "Do NOT call emperor_send_message to reply", "Team roster", "source_id: s1",
                       "This session is Emperor thread t1 (direct: Jose DM)", "[ack-first]"):
            self.assertIn(needle, text)
        self.assertEqual(digest, ctx.system_prompt("t1", "direct")[1], "byte-stable for unchanged inputs")

    def test_identity_change_marks_the_policy_urgent(self):
        ctx, _ = builder(FakeClient({"/agents": {"agents": []}}))
        first = ctx.policy("t1", "direct")
        previous = {"client_env": dict(first.extra_client_env)}
        self.assertFalse(ctx.policy("t1", "direct", previous).urgent)
        ctx._env_instructions = "New instructions."
        self.assertTrue(ctx.policy("t1", "direct", previous).urgent)

    def test_policy_carries_toolsets_cwd_and_budget(self):
        ctx, _ = builder(FakeClient(), toolsets=("emperor-claw", "file"), cwd="/home/x", run_budget_s=600)
        policy = ctx.policy("t1", "group")
        self.assertEqual((policy.toolsets, policy.cwd, policy.run_budget_seconds, policy.thread_type),
                         (("emperor-claw", "file"), "/home/x", 600, "group"))


class LeanTests(unittest.TestCase):
    LEAN = {"kernel": "KERNEL", "alwaysBlock": "ALWAYS", "knowledgeIndex": "- note-1", "roster": "ROSTER"}

    def test_full_mode_is_never_lean(self):
        ctx, _ = builder(FakeClient(), context_mode="full")
        ctx.set_capabilities(frozenset({"lean-context: 1"}), "")
        self.assertFalse(ctx.lean_active)

    def test_lean_without_capability_falls_back_to_full(self):
        ctx, _ = builder(FakeClient(), context_mode="lean")
        self.assertFalse(ctx.lean_active)

    def test_lean_prompt_has_kernel_index_roster_and_one_formatting_line(self):
        client = FakeClient({"/agents": {"agents": []}}, lean=[(200, self.LEAN, '"e1"')])
        ctx, _ = builder(client, context_mode="lean")
        ctx.set_capabilities(frozenset({"lean-context: 1"}), "guide")
        run(ctx.refresh())
        text, _ = ctx.system_prompt("t1", "direct")
        for needle in ("KERNEL", "ALWAYS", "Company knowledge index", "ROSTER", "reply-formatting"):
            self.assertIn(needle, text)
        self.assertNotIn("Company Brain context resolved", text)
        self.assertNotIn("/resources/context", client.calls)

    def test_revalidation_304_keeps_the_cached_payload(self):
        client = FakeClient({"/agents": {"agents": []}}, lean=[(200, self.LEAN, '"e1"'), (304, None, '"e1"')])
        ctx, clock = builder(client, context_mode="lean")
        ctx.set_capabilities(frozenset({"lean-context: 1"}), "")
        run(ctx.refresh())
        clock.now = 700
        run(ctx.refresh())
        self.assertIn("KERNEL", ctx.system_prompt("t1", "direct")[0])
        self.assertEqual(client.calls.count("/context/lean"), 2)


if __name__ == "__main__":
    unittest.main()
