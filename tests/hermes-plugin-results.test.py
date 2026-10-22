"""Tool results from the Emperor Hermes plugin stay small and valid JSON.

Every char a tool returns is re-sent on each later model call of the turn, so
the plugin bounds results (`_fit`), projects list reads to compact rows, and
answers writes with a short receipt instead of the stored record.
"""
import importlib.util
import json
import os
import time
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/__init__.py"
spec = importlib.util.spec_from_file_location("hermes_plugin_results", path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def _task(i, description="x" * 4000):
    return {
        "id": f"task-{i}",
        "companyId": "company-1",
        "projectId": "project-1",
        "taskType": "research",
        "state": "blocked" if i == 0 else "in_progress",
        "priority": i,
        "assignedAgentId": "agent-1",
        "assignedMemberId": None,
        "assignee": {"type": "agent", "id": "agent-1"},
        "slaDueAt": "2026-10-30T00:00:00.000Z",
        "updatedAt": "2026-10-22T10:00:00.000Z",
        "createdAt": "2026-10-20T10:00:00.000Z",
        "blockedByTaskIds": ["task-x"] if i == 0 else [],
        "inputJson": {
            "title": f"Task {i}",
            "description": description,
            "acceptanceCriteria": ["a" * 2000],
            "deliverables": ["d" * 2000],
            "blockedReason": "Waiting on legal" if i == 0 else None,
        },
        "outputJson": {"blob": "o" * 3000},
        "approvalSummary": {"total": 1, "pending": 1 if i == 1 else 0, "latestPendingApprovalId": None},
    }


class FitTests(unittest.TestCase):
    def test_fitting_payload_is_unchanged_and_compact(self):
        data = {"ok": True, "data": {"a": [1, 2], "b": "text"}}
        out = plugin._fit(data, 1000)
        self.assertEqual(out, '{"ok":true,"data":{"a":[1,2],"b":"text"}}')
        self.assertEqual(json.loads(out), data)

    def test_long_strings_keep_head_and_say_how_much_was_cut(self):
        out = json.loads(plugin._fit({"text": "h" * 5000}, 2500))
        self.assertTrue(out["text"].startswith("h" * 100))
        self.assertIn("…[+", out["text"])
        self.assertLessEqual(len(plugin._compact(out)), 2500)

    def test_long_list_in_object_keeps_first_items_and_marks_totals(self):
        data = {"ok": True, "data": {"tasks": [{"id": i, "body": "b" * 300} for i in range(200)]}}
        text = plugin._fit(data, 3000)
        self.assertLessEqual(len(text), 3000)
        out = json.loads(text)
        tasks = out["data"]["tasks"]
        self.assertIsInstance(tasks, list, "the list stays a list at its key")
        self.assertEqual(tasks[0]["id"], 0, "first items are kept")
        marker = out["data"]["_truncated"]["tasks"]
        self.assertEqual(marker["total"], 200)
        self.assertEqual(marker["returned"], len(tasks))
        self.assertIn("_hint", out["data"])

    def test_top_level_list_is_wrapped_with_marker(self):
        out = json.loads(plugin._fit(["x" * 200 for _ in range(100)], 1500))
        self.assertTrue(out["truncated"])
        self.assertEqual(out["total"], 100)
        self.assertEqual(out["returned"], len(out["items"]))

    def test_error_is_never_dropped(self):
        data = {"ok": False, "status": 500, "error": {"error": "Internal Server Error", "details": "boom"},
                "data": {"rows": [{"blob": "z" * 1000} for _ in range(100)]}}
        out = json.loads(plugin._fit(data, 800))
        self.assertEqual(out["error"], data["error"])
        self.assertEqual(out["status"], 500)

    def test_huge_error_string_is_kept_readable(self):
        out = json.loads(plugin._fit({"ok": False, "error": "E" * 20000}, 1000))
        self.assertTrue(out["error"].startswith("E" * 1000))
        self.assertIn("…[+", out["error"])

    def test_deepest_bulky_fields_are_dropped_last(self):
        data = {"id": "keep-me", "nested": {"deeper": {"k%d" % i: "v" * 150 for i in range(200)}}}
        text = plugin._fit(data, 400)
        out = json.loads(text)
        self.assertEqual(out["id"], "keep-me")
        self.assertLessEqual(len(text), 400)
        self.assertIn("omitted", json.dumps(out))

    def test_deterministic(self):
        data = {"rows": [{"t": "q" * i} for i in range(300)]}
        self.assertEqual(plugin._fit(data, 2000), plugin._fit(data, 2000))

    def test_budget_zero_disables(self):
        data = {"text": "y" * 50000}
        self.assertEqual(plugin._fit(data, 0), plugin._compact(data))

    def test_json_reads_budget_from_env(self):
        with patch.dict(os.environ, {"EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS": "0"}):
            self.assertEqual(len(plugin._json({"t": "y" * 50000})), len('{"t":""}') + 50000)
        with patch.dict(os.environ, {"EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS": "1000"}):
            self.assertLessEqual(len(plugin._json({"t": "y" * 50000})), 1000)
        with patch.dict(os.environ, {"EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS": "junk"}):
            self.assertEqual(plugin._tool_result_budget(), plugin.DEFAULT_TOOL_RESULT_MAX_CHARS)


class FitReviewFixTests(unittest.TestCase):
    def test_chronological_lists_keep_the_newest_items(self):
        data = {"ok": True, "data": {"messages": [{"id": f"m{i:02d}", "text": "x" * 1400} for i in range(30)]}}
        out = json.loads(plugin._fit(data, 12000))
        kept = out["data"]["messages"]
        self.assertEqual(kept[-1]["id"], "m29")
        self.assertEqual(out["data"]["_truncated"]["messages"]["kept"], "newest")
        self.assertEqual(out["data"]["_truncated"]["messages"]["total"], 30)

    def test_non_chronological_lists_keep_the_first_items(self):
        data = {"rows": [{"id": i, "t": "x" * 1400} for i in range(30)]}
        self.assertEqual(json.loads(plugin._fit(data, 12000))["rows"][0]["id"], 0)

    def test_notes_tail_survives_fitting_with_original_total(self):
        events = [{"id": f"e{i:02d}", "payloadJson": {"note": "y" * 400, "a": "b" * 400, "c": "c" * 400}} for i in range(50)]
        tailed = plugin._tail_task_notes({"ok": True, "status": 200, "data": {"events": events}}, None)
        out = json.loads(plugin._fit(tailed, 12000))
        kept = out["data"]["events"]
        self.assertEqual(kept[-1]["id"], "e49")
        marker = out["data"]["_truncated"]["events"]
        self.assertEqual(marker["total"], 50)
        self.assertEqual(marker["kept"], "newest")
        self.assertEqual(marker["returned"], len(kept))
        self.assertIn("query.limit", out["data"]["_hint"])

    def test_large_nested_payload_fits_fast(self):
        big = {"ok": True, "data": {"byId": {f"id{i}": {"a": "x" * 100, "b": "y" * 100, "c": {"d": "z" * 100}} for i in range(1800)}}}
        self.assertGreater(len(plugin._compact(big)), 600000)
        started = time.perf_counter()
        text = plugin._fit(big, 12000)
        self.assertLess(time.perf_counter() - started, 0.5)
        self.assertLessEqual(len(text), 12000)
        self.assertTrue(json.loads(text)["ok"])

    def test_error_lists_are_capped_but_the_message_is_kept(self):
        error = {"ok": False, "status": 400, "error": {"error": "TASK_SPEC_UNDERSPECIFIED", "missingFields": ["field"] * 5000, "details": "d" * 9000}}
        text = plugin._fit(error, 12000)
        self.assertLessEqual(len(text), 12000)
        out = json.loads(text)
        self.assertEqual(out["error"]["error"], "TASK_SPEC_UNDERSPECIFIED")
        self.assertEqual(out["error"]["_truncated"]["missingFields"]["total"], 5000)
        self.assertLessEqual(len(out["error"]["missingFields"]), 50)


class ListTasksTests(unittest.TestCase):
    def _call(self, args, rows):
        response = {"ok": True, "status": 200, "data": {"tasks": rows}}
        with patch.object(plugin, "_request", return_value=response) as request:
            out = json.loads(plugin.emperor_list_tasks(args))
        return out, request

    def test_default_rows_are_compact_projections(self):
        out, request = self._call({}, [_task(0), _task(1)])
        self.assertEqual(request.call_args.kwargs["query"]["limit"], 20)
        first, second = out["data"]["tasks"]
        self.assertEqual(first["id"], "task-0")
        self.assertEqual(first["title"], "Task 0")
        self.assertEqual(first["state"], "blocked")
        self.assertEqual(first["assignee"], {"type": "agent", "id": "agent-1"})
        self.assertEqual(first["projectId"], "project-1")
        self.assertTrue(first["blocked"])
        self.assertEqual(first["blockers"], 1)
        self.assertEqual(first["blockedReason"], "Waiting on legal")
        self.assertLessEqual(len(first["summary"]), 160)
        self.assertEqual(second["pendingApprovals"], 1)
        for row in (first, second):
            self.assertNotIn("inputJson", row)
            self.assertNotIn("outputJson", row)
            self.assertLess(len(json.dumps(row)), 700)

    def test_limit_is_capped_at_50(self):
        _, request = self._call({"limit": 500}, [])
        self.assertEqual(request.call_args.kwargs["query"]["limit"], 50)

    def test_detail_returns_full_objects_still_fitted(self):
        rows = [_task(i) for i in range(20)]
        with patch.dict(os.environ, {"EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS": "12000"}):
            response = {"ok": True, "status": 200, "data": {"tasks": rows}}
            with patch.object(plugin, "_request", return_value=response):
                text = plugin.emperor_list_tasks({"detail": True})
        self.assertLessEqual(len(text), 12000)
        self.assertIn("inputJson", json.loads(text)["data"]["tasks"][0])

    def test_error_passes_through(self):
        with patch.object(plugin, "_request", return_value={"ok": False, "status": 400, "error": {"error": "Invalid state"}}):
            out = json.loads(plugin.emperor_list_tasks({"state": "nope"}))
        self.assertEqual(out["error"], {"error": "Invalid state"})


class ThreadMessagesTests(unittest.TestCase):
    def test_default_limit_and_message_projection(self):
        message = {
            "id": "m1", "threadId": "t1", "companyId": "c1", "senderType": "agent", "senderId": "a1",
            "targetAgentId": None, "text": "w" * 4000, "deliveryState": "delivered",
            "platformMessageId": "p1", "createdAt": "2026-10-22T10:00:00.000Z",
            "metadataJson": {"replyToMessageId": "m0", "agentName": "Viktor", "trace": "t" * 2000},
        }
        response = {"ok": True, "status": 200, "data": {
            "thread": {"id": "t1", "type": "team", "title": "Team", "description": "long"},
            "messages": [message], "hasMore": True,
        }}
        with patch.object(plugin, "_request", return_value=response) as request:
            out = json.loads(plugin.emperor_get_thread_messages({"threadId": "t1"}))
        self.assertEqual(request.call_args.kwargs["query"]["limit"], 30)
        row = out["data"]["messages"][0]
        self.assertEqual(set(row), {"id", "sender", "createdAt", "text", "replyToMessageId"})
        self.assertEqual(row["sender"], {"type": "agent", "id": "a1", "name": "Viktor"})
        self.assertEqual(row["replyToMessageId"], "m0")
        self.assertTrue(row["text"].startswith("w" * 1500))
        self.assertIn("…[+2500 chars]", row["text"])
        self.assertEqual(out["data"]["thread"], {"id": "t1", "type": "team", "title": "Team"})
        self.assertTrue(out["data"]["hasMore"])

    def test_keeps_the_newest_messages_when_the_server_returns_more(self):
        rows = [{"id": f"m{i:02d}", "senderType": "agent", "text": "t", "createdAt": "x"} for i in range(80)]
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {"messages": rows, "hasMore": False}}):
            out = json.loads(plugin.emperor_get_thread_messages({"threadId": "t1", "since": "2026-01-01"}))
        ids = [m["id"] for m in out["data"]["messages"]]
        self.assertEqual(ids, [f"m{i:02d}" for i in range(50, 80)])
        self.assertTrue(out["data"]["hasMore"])

    def test_limit_capped_at_100(self):
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {"messages": []}}) as request:
            plugin.emperor_get_thread_messages({"threadId": "t1", "limit": 400})
        self.assertEqual(request.call_args.kwargs["query"]["limit"], 100)


class WriteReceiptTests(unittest.TestCase):
    def test_add_task_note_returns_a_small_confirmation(self):
        response = {"ok": True, "status": 200, "data": {
            "message": "Task note added successfully",
            "event": {"id": "ev-1", "taskId": "task-1", "payloadJson": {"note": "n" * 3000, "kind": "progress"}},
            "memory": None,
        }}
        with patch.object(plugin, "_request", return_value=response):
            out = json.loads(plugin.emperor_add_task_note({"taskId": "task-1", "note": "n" * 3000}))
        self.assertEqual(out, {"ok": True, "status": 200, "id": "ev-1", "taskId": "task-1", "kind": "progress"})

    def test_add_task_note_error_is_returned_whole(self):
        error = {"ok": False, "status": 403, "error": {"error": "Task's project is outside this agent's scope"}}
        with patch.object(plugin, "_request", return_value=error):
            out = json.loads(plugin.emperor_add_task_note({"taskId": "task-1", "note": "x"}))
        self.assertEqual(out, error)

    def test_handoff_note_reports_memory_id(self):
        response = {"ok": True, "status": 200, "data": {
            "event": {"id": "ev-2", "taskId": "task-1", "payloadJson": {"kind": "handoff"}},
            "memory": {"id": "mem-1", "content": "c" * 500},
        }}
        with patch.object(plugin, "_request", return_value=response):
            out = json.loads(plugin.emperor_add_task_note({"taskId": "task-1", "note": "x", "kind": "handoff"}))
        self.assertEqual(out["memoryId"], "mem-1")

    def test_upload_artifact_returns_receipt_without_content(self):
        response = {"ok": True, "status": 201, "data": {"message": "Artifact uploaded", "artifact": {
            "id": "art-1", "title": "Report", "kind": "report", "folderId": "f1", "sizeBytes": 10,
            "sha256": "abc", "contentText": "c" * 50000, "searchText": "s" * 50000, "storageKey": "k",
        }}}
        with patch.object(plugin, "_multipart_upload", return_value=response), patch("os.path.isfile", return_value=True):
            out = json.loads(plugin.emperor_upload_artifact({"filePath": "/tmp/r.pdf", "kind": "report"}))
        self.assertEqual(out["artifact"]["id"], "art-1")
        self.assertNotIn("contentText", out["artifact"])
        self.assertNotIn("storageKey", out["artifact"])
        self.assertLess(len(json.dumps(out)), 400)

    def test_remember_returns_receipt(self):
        response = {"ok": True, "status": 201, "data": {"entry": {"id": "mem-9", "kind": "lesson"}, "snapshot": "s" * 9000}}
        with patch.dict(os.environ, {"EMPEROR_CLAW_AGENT_ID": "self"}), patch.object(plugin, "_request", return_value=response):
            out = json.loads(plugin.emperor_remember({"content": "Use metric units"}))
        self.assertEqual(out, {"ok": True, "status": 201, "id": "mem-9", "kind": "lesson"})


class RequestDefaultsTests(unittest.TestCase):
    def test_artifact_list_gets_default_limit(self):
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {"artifacts": []}}) as request:
            plugin.emperor_request({"path": "/artifacts"})
        self.assertEqual(request.call_args.kwargs["query"], {"limit": 30})

    def test_inline_query_in_path_is_merged_not_doubled(self):
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {}}) as request:
            plugin.emperor_request({"path": "/api/mcp/artifacts?projectId=p1&kind=report"})
        self.assertEqual(request.call_args.args[1], "/api/mcp/artifacts")
        self.assertEqual(request.call_args.kwargs["query"], {"projectId": "p1", "kind": "report", "limit": 30})

    def test_explicit_artifact_limit_wins(self):
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {}}) as request:
            plugin.emperor_request({"path": "/artifacts", "query": {"limit": 5}})
        self.assertEqual(request.call_args.kwargs["query"], {"limit": 5})

    def test_single_artifact_and_writes_are_untouched(self):
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {}}) as request:
            plugin.emperor_request({"path": "/artifacts/art-1"})
            plugin.emperor_request({"method": "POST", "path": "/artifacts", "body": {"kind": "x"}})
        self.assertIsNone(request.call_args_list[0].kwargs["query"])
        self.assertIsNone(request.call_args_list[1].kwargs["query"])

    def test_task_notes_keep_the_newest_twenty(self):
        events = [{"id": f"ev-{i}"} for i in range(50)]
        with patch.object(plugin, "_request", return_value={"ok": True, "status": 200, "data": {"events": events}}) as request:
            out = json.loads(plugin.emperor_request({"path": "/tasks/task-1/notes"}))
        # The server route takes no limit, so none is sent.
        self.assertIsNone(request.call_args.kwargs["query"])
        kept = out["data"]["events"]
        self.assertEqual([e["id"] for e in kept], [f"ev-{i}" for i in range(30, 50)])
        self.assertEqual(out["data"]["_truncated"]["events"]["total"], 50)

    def test_task_notes_limit_from_query(self):
        events = [{"id": f"ev-{i}"} for i in range(10)]
        with patch.object(plugin, "_request", return_value={"ok": True, "data": {"events": events}}):
            out = json.loads(plugin.emperor_request({"path": "/tasks/task-1/notes", "query": {"limit": 3}}))
        self.assertEqual([e["id"] for e in out["data"]["events"]], ["ev-7", "ev-8", "ev-9"])

    def test_large_get_is_fitted(self):
        big = {"ok": True, "status": 200, "data": {"task": {"inputJson": {"description": "d" * 100000}}}}
        with patch.dict(os.environ, {"EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS": "12000"}), \
             patch.object(plugin, "_request", return_value=big):
            text = plugin.emperor_request({"path": "/tasks/task-1"})
        self.assertLessEqual(len(text), 12000)


class TaskWriteReceiptTests(unittest.TestCase):
    def _patch(self, args, response):
        with patch.object(plugin, "_request", return_value=response):
            return json.loads(plugin.emperor_request(args))

    def test_patch_task_returns_compact_receipt(self):
        response = {"ok": True, "status": 200, "data": {"message": "Task task-0 updated successfully", "task": _task(0)}}
        out = self._patch({"method": "PATCH", "path": "/tasks/task-0", "body": {"state": "done"}}, response)
        task = out["data"]["task"]
        self.assertEqual(out["data"]["message"], "Task task-0 updated successfully")
        for key in ("id", "state", "priority", "assignedAgentId", "projectId", "updatedAt", "createdAt", "taskType"):
            self.assertEqual(task[key], _task(0)[key], key)
        self.assertEqual(task["title"], "Task 0")
        self.assertLessEqual(len(task["summary"]), 160)
        self.assertEqual(task["blockers"], 1)
        self.assertNotIn("inputJson", task)
        self.assertNotIn("outputJson", task)
        self.assertLess(len(json.dumps(out)), 900)

    def test_full_api_path_and_post_create_and_note(self):
        created = {"ok": True, "status": 201, "data": {"message": "Task generated", "task": _task(1)}}
        out = self._patch({"method": "POST", "path": "/api/mcp/tasks", "body": {}}, created)
        self.assertEqual(out["data"]["task"]["id"], "task-1")
        self.assertNotIn("inputJson", out["data"]["task"])
        noted = {"ok": True, "status": 200, "data": {
            "message": "Task note added successfully",
            "event": {"id": "ev-1", "taskId": "task-1", "eventType": "task_note", "payloadJson": {"note": "n" * 3000, "kind": "progress"}},
            "memory": None,
        }}
        out = self._patch({"method": "POST", "path": "/tasks/task-1/notes", "body": {"note": "x"}}, noted)
        event = out["data"]["event"]
        self.assertEqual((event["id"], event["kind"], event["eventType"]), ("ev-1", "progress", "task_note"))
        self.assertLessEqual(len(event["summary"]), 160)
        self.assertIsNone(out["data"]["memory"])

    def test_errors_pass_through_unchanged(self):
        error = {"ok": False, "status": 400, "error": {"error": "TASK_SPEC_UNDERSPECIFIED", "details": "d", "missingFields": ["title"]}}
        out = self._patch({"method": "POST", "path": "/tasks", "body": {}}, error)
        self.assertEqual(out, error)

    def test_full_opt_out_returns_the_record(self):
        response = {"ok": True, "status": 200, "data": {"message": "ok", "task": _task(2, description="short")}}
        out = self._patch({"method": "PATCH", "path": "/tasks/task-2", "body": {}, "full": True}, response)
        self.assertIn("inputJson", out["data"]["task"])

    def test_claiming_returns_the_full_work_spec(self):
        response = {"ok": True, "status": 200, "data": {"task": _task(4, description="Do the research")}}
        for path in ("/tasks/claim", "/api/mcp/tasks/claim", "/tasks/task-4/assign"):
            task = self._patch({"method": "POST", "path": path, "body": {}}, response)["data"]["task"]
            self.assertEqual(task["inputJson"]["description"], "Do the research", path)
            self.assertIn("deliverables", task["inputJson"], path)

    def test_reads_and_other_paths_are_not_receipted(self):
        response = {"ok": True, "status": 200, "data": {"task": _task(3, description="short")}}
        self.assertIn("inputJson", self._patch({"path": "/tasks/task-3"}, response)["data"]["task"])
        self.assertIn("inputJson", self._patch({"method": "PATCH", "path": "/projects/p1", "body": {}}, response)["data"]["task"])


if __name__ == "__main__":
    unittest.main()
