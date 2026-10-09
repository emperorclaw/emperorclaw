import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/__init__.py"
spec = importlib.util.spec_from_file_location("hermes_plugin", path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class HermesHiringTests(unittest.TestCase):
    def test_hiring_uses_own_identity_and_local_runtime(self):
        with patch.dict(os.environ, {"EMPEROR_CLAW_AGENT_ID": "parent-worker"}), patch.object(plugin, "_request", return_value={"ok": True}) as request:
            self.assertEqual(json.loads(plugin.emperor_create_agent({"name": "Researcher", "role": "research", "sourceAgentId": "sibling"})), {"ok": True})
            self.assertEqual(request.call_args.args[:2], ("POST", "/agents"))
            body = request.call_args.args[2]
            self.assertEqual(body["sourceAgentId"], "parent-worker")
            self.assertEqual(body["deploymentMode"], "local")
            self.assertNotIn("llmApiKey", body)

    def test_baseline_loads_without_kb_or_network(self):
        with patch.object(plugin, "_request", side_effect=AssertionError("baseline must not fetch KB")):
            context = plugin.emperor_context_hook()["context"]
        for phrase in ["Emperor minimum operating practices", "Human mentions never route to an agent", "3–8 words", "isShared=true", "status=\"draft\"", "Common scenarios"]:
            self.assertIn(phrase, context)

    def test_bridge_turn_does_not_inject_operating_guide_twice(self):
        with patch.dict(os.environ, {"EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE": "1"}):
            context = plugin.emperor_context_hook()["context"]
        self.assertNotIn("Emperor minimum operating practices", context)
        self.assertIn("durable state", context)

    def test_batch_upload_reports_partial_failures(self):
        responses = [json.dumps({"ok": True}), json.dumps({"ok": False, "error": "nope"})]
        with patch.object(plugin, "emperor_upload_artifact", side_effect=responses):
            result = json.loads(plugin.emperor_upload_artifacts({
                "kind": "report",
                "folderId": "folder-1",
                "files": ["/tmp/a.pdf", "/tmp/b.pdf"],
            }))
        self.assertFalse(result["ok"])
        self.assertEqual(result["succeeded"], 1)
        self.assertEqual(result["failed"], 1)

    def test_task_overview_uses_compact_endpoint(self):
        with patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_get_task_overview({"projectId": "project-1", "maxItems": 7})
        self.assertEqual(request.call_args.args[:2], ("GET", "/tasks/overview"))
        self.assertEqual(request.call_args.kwargs["query"]["maxItems"], 7)

    def test_add_task_note_defaults_agent_to_own_identity(self):
        with patch.dict(os.environ, {"EMPEROR_CLAW_AGENT_ID": "self-agent"}), patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_add_task_note({"taskId": "task-1", "note": "did the thing"})
        self.assertEqual(request.call_args.args[:2], ("POST", "/tasks/task-1/notes"))
        body = request.call_args.kwargs["body"]
        self.assertEqual(body["note"], "did the thing")
        self.assertEqual(body["agentId"], "self-agent")

    def test_add_task_note_explicit_agent_wins(self):
        with patch.dict(os.environ, {"EMPEROR_CLAW_AGENT_ID": "self-agent"}), patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_add_task_note({"taskId": "task-1", "note": "handoff", "kind": "handoff", "agentId": "explicit-agent"})
        self.assertEqual(request.call_args.kwargs["body"]["agentId"], "explicit-agent")

    def test_hiring_tool_registered(self):
        class Context:
            tools = {}
            def register_tool(self, name, toolset, schema, fn, **kwargs):
                self.tools[name] = (schema, fn)
            def register_skill(self, *args): pass
            def register_hook(self, *args): pass
        ctx = Context()
        plugin.register(ctx)
        schema, fn = ctx.tools["emperor_create_agent"]
        self.assertEqual(schema["parameters"]["required"], ["name"])
        self.assertIs(fn, plugin.emperor_create_agent)
        self.assertIn("emperor_get_task_overview", ctx.tools)
        self.assertIn("emperor_upload_artifacts", ctx.tools)
        self.assertIn("emperor_replace_artifact", ctx.tools)
        self.assertIn("emperor_list_objectives", ctx.tools)
        self.assertIn("emperor_update_objective", ctx.tools)

    def test_list_objectives_never_sends_an_agent_id(self):
        with patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_list_objectives({"agentId": "someone-else"})
        self.assertEqual(request.call_args.args[:2], ("GET", "/objectives"))
        # The bound token decides whose objectives these are; no agent override.
        self.assertNotIn("agentId", request.call_args.kwargs.get("query") or {})
        self.assertIsNone(request.call_args.kwargs.get("body"))

    def test_update_objective_shape_and_no_agent_override(self):
        with patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_update_objective({
                "objectiveId": "obj-1", "action": "block",
                "blockerReason": "Waiting on legal", "agentId": "someone-else",
            })
        self.assertEqual(request.call_args.args[:2], ("POST", "/objectives"))
        body = request.call_args.kwargs["body"]
        self.assertEqual(body["objectiveId"], "obj-1")
        self.assertEqual(body["action"], "block")
        self.assertEqual(body["blockerReason"], "Waiting on legal")
        self.assertNotIn("agentId", body, "an agent can never act on another agent's objective")

    def test_update_objective_rejects_unknown_action(self):
        with patch.object(plugin, "_request") as request:
            result = json.loads(plugin.emperor_update_objective({"objectiveId": "obj-1", "action": "delete"}))
        self.assertIn("error", result)
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
