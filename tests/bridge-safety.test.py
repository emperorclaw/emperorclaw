"""Bridge 0.9 safety rules ported from the 0.3 suite: routing, mentions, loop guard, cold start,
retry ledger, controls, budget gate, provider failures, reply shape, operating guide, rich replies,
group context and server routing.

Deleted with the behavior they covered (design 5.2): state.db reasoning sources, stream-json and
CLI output cleaning, subprocess timeouts/orphan reaping, the main-chat digest and session rotation.
"""
import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/bridge"))

from emperor_bridge import context as ctx  # noqa: E402
from emperor_bridge.emperor_api import (check_loop_guard, classify, environment_wait_exhausted, is_direct_thread,  # noqa: E402
                                        is_for_agent, mark_inflight, mentions_agent, retry_due, schedule_retry,
                                        split_control_commands)
from emperor_bridge.interfaces import TurnOutcome, TurnResult, UsageLedger  # noqa: E402
from emperor_bridge.ledger import BudgetGate, error_classification  # noqa: E402
from emperor_bridge.outbox import build_entry  # noqa: E402

AGENT = "agent-1"


def run(coro):
    return asyncio.run(coro)


def verdict(message, data=None, started_at=0.0, parked=False):
    return classify(message, agent_id=AGENT, agent_name="Viktor", data=data if data is not None else {},
                    started_at=started_at, loop_guard_max_turns=3, has_parked_reply=lambda _m: parked).action


class TestOrganizationReporting(unittest.TestCase):
    def test_reporting_is_bounded_and_names_leader(self):
        info = {"configured": True, "leader": {"kind": "human", "name": "Jose " * 40},
                "reporting": [{"reportsTo": {"name": "Architect"}}]}
        block = ctx.format_organization(info, AGENT)
        self.assertIn("you report to Architect", block)
        self.assertLess(len(block), 400)

    def test_self_leader_reports_to_humans(self):
        block = ctx.format_organization({"configured": True, "leader": {"kind": "agent", "id": AGENT, "name": "V"}}, AGENT)
        self.assertIn("you lead the company; report to humans", block)

    def test_old_server_or_unconfigured_chart_adds_nothing(self):
        self.assertEqual(ctx.format_organization(None, AGENT), "")
        self.assertEqual(ctx.format_organization({"configured": False}, AGENT), "")

    def test_team_coordinator_is_the_reporting_target(self):
        info = {"configured": True, "leader": {"name": "Lead"}, "teams": [{"coordinator": {"kind": "agent", "id": "x", "name": "Coord"}}]}
        self.assertIn("you report to Coord", ctx.format_organization(info, AGENT))


class TestRuntimeControls(unittest.TestCase):
    def test_stop_commands_are_split_from_kill_and_replace(self):
        stops, kills = split_control_commands({"commands": [
            {"id": "c1", "action": "stop", "messageId": "m1"}, {"id": "c2", "action": "kill"},
            {"id": "c3", "metadataJson": {"runtimeControl": {"action": "replace"}}}]})
        self.assertEqual([c["id"] for c in stops], ["c1"])
        self.assertEqual([c["metadataJson"]["runtimeControl"]["action"] for c in kills], ["kill", "replace"])

    def test_empty_or_malformed_payload_is_harmless(self):
        self.assertEqual(split_control_commands(None), ([], []))
        self.assertEqual(split_control_commands({"commands": None}), ([], []))


class TestRetryLedger(unittest.TestCase):
    def test_retry_is_durable_and_uses_bounded_exponential_backoff(self):
        data = {}
        self.assertEqual(schedule_retry(data, "m", base_s=15, max_s=300, now=1000), 1)
        self.assertEqual(data["retries"]["m"]["nextRetryAt"], 1015)
        self.assertFalse(retry_due(data, "m", now=1010))
        for _ in range(10):
            schedule_retry(data, "m", base_s=15, max_s=300, now=1000)
        self.assertEqual(data["retries"]["m"]["nextRetryAt"], 1300)

    def test_environment_wait_never_spends_the_attempt_budget(self):
        data = {}
        schedule_retry(data, "m", base_s=15, max_s=300, environment=True, now=0)
        schedule_retry(data, "m", base_s=15, max_s=300, environment=True, now=0)
        self.assertEqual(data["retries"]["m"]["attempts"], 0)
        self.assertEqual(data["retries"]["m"]["busyMisses"], 2)

    def test_environment_wait_has_a_ceiling_from_the_first_attempt(self):
        data = {}
        schedule_retry(data, "m", base_s=15, max_s=300, environment=True, now=100)
        schedule_retry(data, "m", base_s=15, max_s=300, environment=True, now=5000)
        self.assertFalse(environment_wait_exhausted(data, "m", 86400, now=86000))
        self.assertTrue(environment_wait_exhausted(data, "m", 86400, now=86500))

    def test_inflight_messages_stay_in_the_retry_ledger_for_resync(self):
        data = {}
        mark_inflight(data, "m", now=5)
        self.assertTrue(retry_due(data, "m"))
        self.assertIn("m", data["retries"])

    def test_seen_direct_prompt_still_active_server_side_is_recovered(self):
        data = {"seen": ["m"]}
        msg = {"id": "m", "threadId": "t", "threadType": "direct", "targetAgentId": AGENT, "deliveryState": "acting",
               "senderType": "human", "text": "hi"}
        self.assertEqual(verdict(msg, data), "dispatch")
        self.assertEqual(verdict({**msg, "targetAgentId": "other"}, {"seen": ["m"]}), "skip")


class TestRosterAliases(unittest.TestCase):
    def test_same_first_name_gets_distinct_aliases(self):
        roster = ctx.format_roster([{"id": "a", "name": "Viktor Builder"}, {"id": "b", "name": "Viktor QA"}], "a",
                                   with_ids=False)
        self.assertIn("@Viktor-Builder", roster)
        self.assertIn("@Viktor-QA", roster)
        self.assertNotIn("@Viktor ", roster)

    def test_roster_carries_ids_only_with_rich_replies(self):
        agents = [{"id": "a1", "name": "Ada"}]
        self.assertIn("id a1", ctx.format_roster(agents, "x", with_ids=True))
        self.assertNotIn("id a1", ctx.format_roster(agents, "x", with_ids=False))

    def test_empty_roster_points_at_the_tool(self):
        self.assertIn("GET /agents", ctx.format_roster([], AGENT, with_ids=False))


class TestColdStartGuard(unittest.TestCase):
    def test_agent_backlog_in_shared_thread_is_skipped(self):
        msg = {"id": "m", "threadId": "t", "threadType": "team", "senderType": "agent", "senderId": "x",
               "text": "@Viktor go", "createdAt": "2020-01-01T00:00:00Z"}
        self.assertEqual(verdict(msg, started_at=1e10), "skip")

    def test_live_agent_message_and_human_backlog_are_not_skipped(self):
        msg = {"id": "m", "threadId": "t", "threadType": "team", "senderType": "human", "text": "@Viktor go",
               "createdAt": "2020-01-01T00:00:00Z"}
        self.assertEqual(verdict(msg, started_at=1e10), "dispatch")


class TestLoopGuard(unittest.TestCase):
    def msg(self, sender):
        return {"id": "m", "threadId": "t", "threadType": "team", "senderType": sender}

    def test_three_agent_turns_pass_and_the_fourth_fails(self):
        data = {}
        self.assertEqual([check_loop_guard(self.msg("agent"), data, 3, now=1) for _ in range(4)], [True, True, True, False])

    def test_human_resets_counter(self):
        data = {}
        for _ in range(4):
            check_loop_guard(self.msg("agent"), data, 3, now=1)
        self.assertTrue(check_loop_guard(self.msg("human"), data, 3, now=1))
        self.assertTrue(check_loop_guard(self.msg("agent"), data, 3, now=1))

    def test_direct_threads_always_pass(self):
        data = {}
        self.assertTrue(all(check_loop_guard({"threadId": "t", "threadType": "direct", "senderType": "agent"}, data, 3)
                            for _ in range(10)))

    def test_classify_reports_the_trip_once_per_thread(self):
        data = {}
        base = {"threadId": "t", "threadType": "team", "senderType": "agent", "senderId": "x", "text": "@Viktor ok"}
        actions = [verdict({**base, "id": f"m{i}"}, data) for i in range(4)]
        self.assertEqual(actions, ["dispatch", "dispatch", "dispatch", "loop_guard"])


class TestMentions(unittest.TestCase):
    def test_exact_partial_and_unicode_mentions(self):
        self.assertTrue(mentions_agent("hey @Viktor please", "Viktor"))
        self.assertTrue(mentions_agent("@viktor-builder go", "Viktor Builder"))
        self.assertTrue(mentions_agent("hola @José", "José"))

    def test_partial_word_and_other_agents_do_not_match(self):
        self.assertFalse(mentions_agent("@Viktoria hi", "Viktor"))
        self.assertFalse(mentions_agent("@Ada hi", "Viktor"))
        self.assertFalse(mentions_agent("Viktor without at", "Viktor"))


class TestIsForAgent(unittest.TestCase):
    def test_target_and_own_message(self):
        self.assertTrue(is_for_agent({"targetAgentId": AGENT}, AGENT, "Viktor", {}))
        self.assertFalse(is_for_agent({"targetAgentId": "x"}, AGENT, "Viktor", {}))
        self.assertFalse(is_for_agent({"senderType": "agent", "senderId": AGENT, "targetAgentId": AGENT}, AGENT, "V", {}))

    def test_team_chat_needs_a_mention_and_groups_honor_human_at_all(self):
        self.assertFalse(is_for_agent({"threadType": "team", "text": "standup?"}, AGENT, "Viktor", {}))
        self.assertTrue(is_for_agent({"threadType": "group", "senderType": "human", "text": "@all report"}, AGENT, "V", {}))
        self.assertFalse(is_for_agent({"threadType": "group", "senderType": "agent", "text": "@all report"}, AGENT, "V", {}))

    def test_known_dm_of_another_agent_is_not_ours(self):
        data = {"directThreads": {"t": "other"}}
        self.assertFalse(is_for_agent({"threadId": "t", "text": "@Viktor hi"}, AGENT, "Viktor", data))

    def test_server_verdict_wins(self):
        self.assertTrue(is_for_agent({"threadType": "team", "text": "no mention", "addressedToYou": True}, AGENT, "V", {}))
        self.assertFalse(is_for_agent({"targetAgentId": AGENT, "addressedToYou": False}, AGENT, "V", {}))
        self.assertFalse(is_for_agent({"senderType": "agent", "senderId": AGENT, "addressedToYou": True}, AGENT, "V", {}))


class TestIsDirectThread(unittest.TestCase):
    def test_kinds(self):
        self.assertTrue(is_direct_thread({"threadType": "direct"}, AGENT, {}))
        self.assertFalse(is_direct_thread({"threadType": "team", "targetAgentId": AGENT}, AGENT, {}))
        self.assertFalse(is_direct_thread({"threadType": "group", "targetAgentId": AGENT}, AGENT, {}))
        self.assertTrue(is_direct_thread({"targetAgentId": AGENT}, AGENT, {}))
        self.assertTrue(is_direct_thread({"threadId": "t"}, AGENT, {"directThreads": {"t": AGENT}}))
        self.assertFalse(is_direct_thread({"threadId": "u"}, AGENT, {}))


class TestBudgetGate(unittest.TestCase):
    def gate(self, answer, clock):
        async def request(method, path, body=None, query=None, **_):
            if isinstance(answer, Exception):
                raise answer
            return answer
        return BudgetGate(request, AGENT, clock=clock)

    def test_denies_paused_and_explicitly_disallowed_agents(self):
        self.assertFalse(run(self.gate({"agent": {"executionAllowed": False}}, lambda: 100).allowed()))
        self.assertFalse(run(self.gate({"agent": {"executionAllowed": True, "budgetStatus": "paused"}}, lambda: 100).allowed()))
        self.assertTrue(run(self.gate({"agent": {"executionAllowed": True}}, lambda: 100).allowed()))

    def test_failed_check_fails_closed_after_five_minutes(self):
        now = [0.0]
        gate = self.gate(ConnectionError("down"), lambda: now[0])
        self.assertTrue(run(gate.allowed()))
        now[0] = 400.0
        self.assertFalse(run(gate.allowed()))


class TestProviderFailures(unittest.TestCase):
    def result(self, outcome, **kw):
        return TurnResult(outcome=outcome, final_text="", usage=UsageLedger(), **kw)

    def test_402_is_classified_with_a_fixed_reason(self):
        self.assertEqual(error_classification(self.result(TurnOutcome.FAILED, failure_reason="HTTP 402: Insufficient credits")),
                         "provider_credits_exhausted: HTTP 402")

    def test_other_failures_carry_only_a_code(self):
        self.assertEqual(error_classification(self.result(TurnOutcome.FAILED, error_code="hermes_failed",
                                                          failure_reason="secret tool output")), "hermes_failed")
        self.assertIsNone(error_classification(self.result(TurnOutcome.COMPLETED)))


class TestReplyShape(unittest.TestCase):
    def test_reply_carries_source_and_never_invents_direct(self):
        entry = build_entry(message_id="m", thread_id="t", agent_id=AGENT, text="hi", idempotency_key="emp-m")
        self.assertEqual(entry["body"]["replyToMessageId"], "m")
        self.assertNotIn("thread_type", entry["body"])
        self.assertIsNone(entry["body"]["targetAgentId"])

    def test_coalesced_reply_resolves_the_earlier_messages(self):
        entry = build_entry(message_id="m3", thread_id="t", agent_id=AGENT, text="x", idempotency_key="emp-m3",
                            also_resolves=["m1", "m2"])
        self.assertEqual(entry["body"]["alsoResolvesMessageIds"], ["m1", "m2"])


class TestOperatingGuide(unittest.TestCase):
    def test_missing_guide_returns_builtin_fallback(self):
        guide = ctx.load_operating_guide("/nope/guide.md", packaged=Path("/nope/packaged.md"))
        self.assertIn("Emperor minimum operating practices", guide)

    def test_env_override_takes_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "g.md"
            path.write_text("custom guide", encoding="utf-8")
            self.assertEqual(ctx.load_operating_guide(str(path)), "custom guide")

    def test_packaged_guide_is_found(self):
        self.assertIn("Emperor", ctx.load_operating_guide())

    def test_builtin_does_not_teach_mention_delegation(self):
        self.assertIn("a @mention requests attention, it does not assign work", ctx.BUILTIN_OPERATING_GUIDE)


class TestRichReplies(unittest.TestCase):
    def test_old_server_response_yields_no_capabilities(self):
        self.assertEqual(ctx.parse_server_capabilities({"runtimeNode": {}}), (frozenset(), ""))

    def test_new_server_response_is_parsed_and_guide_capped(self):
        caps, guide = ctx.parse_server_capabilities({"serverCapabilities": ["rich-blocks-v1", "runs: 1"],
                                                     "replyFormatGuide": "x" * 5000})
        self.assertIn("rich-blocks-v1", caps)
        self.assertEqual(len(guide), ctx.REPLY_GUIDE_MAX)


class TestGroupContext(unittest.TestCase):
    def test_group_context_lists_purpose_members_and_coordinator(self):
        detail = {"type": "group", "title": "Dev team", "description": "Ship the app", "members": [
            {"kind": "agent", "name": "Viktor"}, {"kind": "human", "name": "Jose", "role": "coordinator"}]}
        text = ctx.format_thread_context("t1", "group", detail, "Viktor")
        for needle in ("Dev team", "Group purpose: Ship the app", "Team coordinator: Jose (human)",
                       "Agent members: Viktor (you)", "Never write @all yourself"):
            self.assertIn(needle, text)

    def test_pair_thread_has_no_group_boilerplate(self):
        text = ctx.format_thread_context("t1", "group", {"description": "agent-pair"}, "V")
        self.assertNotIn("Group rules", text)

    def test_team_roles_are_scoped_and_bounded(self):
        details = {f"g{i}": {"type": "group", "title": f"Team {i}", "members": [{"kind": "agent", "id": AGENT}]}
                   for i in range(6)}
        roles = ctx.format_team_roles(details, AGENT, "Viktor")
        self.assertIn("Plus 2 other teams", roles)
        self.assertEqual(roles.count("you are member"), 4)


if __name__ == "__main__":
    unittest.main()
