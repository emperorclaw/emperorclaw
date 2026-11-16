"""Context building (D6, 5.6): delta <= 400 chars after the message, task-change line only when the
open-task set changed, continuity seed capped at 6000 chars, system prompt carries the stable thread
context and the rules the deleted plugin hook used to inject (D22)."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.context import (ATTACHMENTS_MAX, DELTA_MAX, SEED_MAX, ContextBuilder,  # noqa: E402
                                    attachment_lines, build_delta, compose_api_text, format_seed,
                                    message_attachments, task_lines)


def run(coro):
    return asyncio.run(coro)


class FakeClient:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    async def request(self, method, path, body=None, query=None, **_):
        self.calls.append(path)
        value = self.routes.get(path)
        if isinstance(value, Exception):
            raise value
        return value

    async def get_with_etag(self, path, query, etag):
        return 304, None, etag


def builder(routes, **kw):
    now = [0.0]
    ctx = ContextBuilder(FakeClient(routes), agent_id="a1", agent_name="Viktor", agent_role="builder",
                         instructions="", clock=lambda: now[0], **kw)
    return ctx, now


class DeltaSizeTests(unittest.TestCase):
    def test_delta_is_bounded_for_hostile_inputs(self):
        message = {"id": "x" * 500, "senderType": "human", "senderName": "N" * 500, "createdAt": "bad",
                   "text": "the message"}
        tasks = [f'{i:08d} "{"t" * 200}" [in progress]' for i in range(3)]
        delta = build_delta(message, roster={}, tasks=tasks, open_count=99, ack_first=True, coalesced=7)
        self.assertLessEqual(len(delta), DELTA_MAX)
        _, api_text = compose_api_text([message], delta)
        self.assertLessEqual(len(api_text), DELTA_MAX + len("the message") + 2)
        self.assertTrue(api_text.startswith("the message"))

    def test_sender_name_from_roster_or_metadata(self):
        message = {"id": "m", "senderType": "agent", "senderId": "ag-2", "text": "hi"}
        self.assertIn("from=Ada (agent)", build_delta(message, roster={"ag-2": "Ada"}, tasks=None, open_count=0,
                                                      ack_first=True))
        meta = {"id": "m", "senderType": "human", "metadataJson": {"senderName": "Jose"}, "text": "hi"}
        self.assertIn("from=Jose (human)", build_delta(meta, roster={}, tasks=None, open_count=0, ack_first=True))


class TaskLineTests(unittest.TestCase):
    TASKS = {"tasks": [{"id": "t-1", "state": "in_progress", "assignedAgentId": "a1", "inputJson": {"title": "Ship"}},
                       {"id": "t-2", "state": "done", "assignedAgentId": "a1"},
                       {"id": "t-3", "state": "inbox", "assignedAgentId": "other"}]}

    def test_task_set_hash_ignores_done_and_foreign_tasks(self):
        first, lines, count = task_lines(self.TASKS["tasks"], "a1")
        self.assertEqual((lines, count), (['t-1 "Ship" [in progress]'], 1))
        second, _, _ = task_lines(self.TASKS["tasks"][:1], "a1")
        self.assertEqual(first, second)

    def test_line_only_when_the_set_changed_since_the_last_turn(self):
        ctx, now = builder({"/tasks": self.TASKS})
        message = {"id": "m1", "senderType": "human", "text": "hi"}
        delta, task_hash = run(ctx.delta(message, last_task_hash=None))
        self.assertIn("[tasks changed: 1 open; t-1", delta)
        delta, same = run(ctx.delta(message, last_task_hash=task_hash))
        self.assertNotIn("tasks", delta)
        self.assertEqual(same, task_hash)
        now[0] = 60
        ctx._client.routes["/tasks"] = {"tasks": []}
        delta, changed = run(ctx.delta(message, last_task_hash=task_hash))
        self.assertIn("[tasks changed: 0 open]", delta)
        self.assertNotEqual(changed, task_hash)

    def test_failed_task_fetch_adds_no_line(self):
        ctx, _ = builder({"/tasks": ConnectionError("down")})
        delta, task_hash = run(ctx.delta({"id": "m", "senderType": "human", "text": "x"}, last_task_hash="h"))
        self.assertNotIn("tasks", delta)
        self.assertEqual(task_hash, "h")

    def test_goal_step_has_no_ack_first(self):
        ctx, _ = builder({"/tasks": {"tasks": []}})
        delta, _ = run(ctx.delta({"id": "goal-1", "senderType": "human", "text": "x"}, last_task_hash=None,
                                 goal_turn=True))
        self.assertNotIn("[ack-first]", delta)


class SeedTests(unittest.TestCase):
    def test_seed_is_oldest_first_excludes_current_and_is_capped(self):
        history = [{"id": f"m{i}", "text": f"line {i} " + "x" * 500, "senderName": "Jose",
                    "createdAt": f"2026-10-22T10:{i:02d}:00Z"} for i in range(30)]
        newest_first = list(reversed(history))
        seed = format_seed(newest_first, {"m29"}, {})
        self.assertLessEqual(len(seed), SEED_MAX)
        self.assertNotIn("line 29 ", seed)
        self.assertLess(seed.index("line 27 "), seed.index("line 28 "))

    def test_seed_fetch_failure_is_empty(self):
        ctx, _ = builder({"/threads/t1/messages": ConnectionError("down")})
        self.assertEqual(run(ctx.seed("t1", set())), "")

    def test_seed_from_thread_history(self):
        ctx, _ = builder({"/threads/t1/messages": {"messages": [
            {"id": "a", "text": "first", "createdAt": "2026-01-01T00:00:00Z", "senderName": "Jose"},
            {"id": "b", "text": "second", "createdAt": "2026-01-01T00:01:00Z", "senderName": "Jose"}]}})
        seed = run(ctx.seed("t1", {"b"}))
        self.assertIn("- Jose: first", seed)
        self.assertNotIn("second", seed)


class SystemPromptTests(unittest.TestCase):
    def test_hook_rules_moved_into_the_system_prompt(self):
        ctx, _ = builder({"/agents": {"agents": []}})
        text, _ = ctx.system_prompt("t1", "team")
        for needle in ("emperor_list_threads, then emperor_get_thread_messages", "emperor_update_objective",
                       "emperor_upload_artifact", "emperor_request is not a generic external HTTP client",
                       "ONLY respond to a team chat message if your @name appears in it",
                       "answer only when your @name is in the message", "status: draft only",
                       "/resources/context"):
            self.assertIn(needle, text)

    def test_thread_context_changes_the_prompt_but_message_content_does_not(self):
        ctx, _ = builder({})
        _, before = ctx.system_prompt("t1", "direct")
        ctx.remember_threads({"t1": {"type": "direct", "title": "Renamed"}})
        _, after = ctx.system_prompt("t1", "direct")
        self.assertNotEqual(before, after)

    def test_rich_reply_guide_only_when_the_server_supports_it(self):
        ctx, _ = builder({})
        ctx.set_capabilities(frozenset({"rich-blocks-v1"}), "RICH GUIDE")
        self.assertIn("RICH GUIDE", ctx.system_prompt("t", "direct")[0])
        off, _ = builder({}, rich_replies=False)
        off.set_capabilities(frozenset({"rich-blocks-v1"}), "RICH GUIDE")
        self.assertNotIn("RICH GUIDE", off.system_prompt("t", "direct")[0])


XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def with_files(text, files):
    return {"id": "m1", "senderType": "human", "text": text, "metadataJson": {"attachments": files}}


class AttachmentTests(unittest.TestCase):
    FILE = {"id": "art-1", "name": "report.xlsx", "contentType": XLSX, "sizeBytes": 43622}

    def test_attachments_are_listed_under_the_text_with_the_download_hint(self):
        text, api_text = compose_api_text([with_files("Summarize this", [self.FILE])], "[emperor msg=m1]")
        self.assertTrue(text.startswith("Summarize this\nAttached files:\n"))
        self.assertIn(f"- report.xlsx ({XLSX}, 42.6 KB) [artifact art-1]", text)
        self.assertIn("emperor_download_attachment", text)
        self.assertTrue(api_text.startswith(text))
        self.assertTrue(api_text.endswith("[emperor msg=m1]"))

    def test_attachment_only_message_is_not_empty(self):
        text, _ = compose_api_text([with_files("", [self.FILE])], "d")
        self.assertNotIn("(empty message)", text)
        self.assertTrue(text.startswith("Attached files:"))
        self.assertIn("[artifact art-1]", text)

    def test_coalesced_messages_keep_each_files_and_one_hint(self):
        second = {**with_files("", [{"id": "art-2", "name": "b.csv"}]), "id": "m2"}
        text, _ = compose_api_text([with_files("look", [self.FILE]), {"id": "m3", "text": "thanks"}, second], "d")
        self.assertIn("[artifact art-1]", text)
        self.assertIn("- b.csv [artifact art-2]", text)
        self.assertEqual(text.count("emperor_download_attachment"), 1)
        self.assertLess(text.index("art-1"), text.index("thanks"))
        self.assertLess(text.index("thanks"), text.index("art-2"))

    def test_messages_without_files_are_unchanged(self):
        text, _ = compose_api_text([{"id": "m", "text": "hi"}], "d")
        self.assertEqual(text, "hi")
        self.assertEqual(compose_api_text([{"id": "m", "text": ""}], "d")[0], "(empty message)")

    def test_malformed_metadata_is_ignored(self):
        for meta in (None, "x", {"attachments": "nope"}, {"attachments": {"id": "a"}},
                     {"attachments": [None, 3, "a", {"name": "no id"}, {"id": ""}]}):
            message = {"id": "m", "text": "hi", "metadataJson": meta}
            self.assertEqual(message_attachments(message), [])
            self.assertEqual(compose_api_text([message], "d")[0], "hi")

    def test_missing_fields_and_hostile_values_are_tolerated(self):
        files = message_attachments(with_files("", [{"id": "a1", "sizeBytes": "big", "name": "x\n" * 200},
                                                    {"id": "a2", "sizeBytes": True}]))
        self.assertEqual([f["id"] for f in files], ["a1", "a2"])
        self.assertIsNone(files[0]["sizeBytes"])
        self.assertIsNone(files[1]["sizeBytes"])
        self.assertNotIn("\n", files[0]["name"])
        self.assertLessEqual(len(files[0]["name"]), 120)
        lines = attachment_lines(with_files("", [{"id": "a3"}]), hint=False)
        self.assertEqual(lines, ["Attached files:", "- file [artifact a3]"])

    def test_list_is_capped(self):
        files = [{"id": f"a{i}", "name": f"f{i}.txt"} for i in range(ATTACHMENTS_MAX + 7)]
        lines = attachment_lines(with_files("", files), hint=False)
        self.assertEqual(len(lines), 1 + ATTACHMENTS_MAX + 1)
        self.assertEqual(lines[-1], "- +7 more")

    def test_seed_keeps_attachment_only_messages(self):
        history = [with_files("", [self.FILE]) | {"id": "old", "senderName": "Jose"},
                   {"id": "older", "text": "hello", "senderName": "Jose"}]
        seed = format_seed(history, set(), {})
        self.assertIn("- Jose: [attached: report.xlsx (artifact art-1)]", seed)
        self.assertLess(seed.index("hello"), seed.index("report.xlsx"))

    def test_seed_lists_files_after_text_and_caps_them(self):
        files = [{"id": f"a{i}", "name": f"f{i}.pdf"} for i in range(8)]
        seed = format_seed([with_files("see these", files) | {"senderName": "Jose"}], set(), {})
        self.assertIn("- Jose: see these [attached: f0.pdf (artifact a0);", seed)
        self.assertIn("; +3 more]", seed)
        self.assertNotIn("f5.pdf", seed)

    def test_rules_tell_the_agent_to_download_attachments(self):
        ctx, _ = builder({"/agents": {"agents": []}})
        text, _ = ctx.system_prompt("t1", "direct")
        self.assertIn("emperor_download_attachment(artifactId)", text)
        self.assertIn("Never say nothing was attached", text)


if __name__ == "__main__":
    unittest.main()
