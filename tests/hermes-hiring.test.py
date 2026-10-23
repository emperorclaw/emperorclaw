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

    def test_tier2_tools_hit_the_lean_endpoints(self):
        with patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_get_manual({"section": "storage"})
            plugin.emperor_get_knowledge_note({"id": "note-1"})
            plugin.emperor_search_knowledge({"query": "invoice", "limit": 5})
        calls = request.call_args_list
        self.assertEqual(calls[0].args[:2], ("GET", "/manual"))
        self.assertEqual(calls[0].kwargs["query"], {"section": "storage"})
        self.assertEqual(calls[1].args[:2], ("GET", "/knowledge/note-1"))
        self.assertEqual(calls[2].args[:2], ("GET", "/knowledge/search"))
        self.assertEqual(calls[2].kwargs["query"]["q"], "invoice")
        self.assertEqual(calls[2].kwargs["query"]["limit"], 5)

    def test_tier2_tools_are_registered(self):
        class Context:
            tools = {}
            def register_tool(self, name, toolset, schema, fn, **kwargs):
                self.tools[name] = (schema, fn)
            def register_skill(self, *args): pass
            def register_hook(self, *args): pass
        ctx = Context()
        plugin.register(ctx)
        for name in ("emperor_get_manual", "emperor_get_knowledge_note", "emperor_search_knowledge"):
            self.assertIn(name, ctx.tools)
        self.assertEqual(ctx.tools["emperor_get_manual"][0]["parameters"]["required"], [])
        self.assertEqual(ctx.tools["emperor_get_knowledge_note"][0]["parameters"]["required"], ["id"])
        self.assertEqual(ctx.tools["emperor_search_knowledge"][0]["parameters"]["required"], ["query"])

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


class AcknowledgeTests(unittest.TestCase):
    # Acks inside a turn (turn file + bound_client_env) are covered by tests/hermes-plugin-context.test.py.
    TURN = {
        "EMPEROR_CLAW_TURN_THREAD_ID": "thread-1",
        "EMPEROR_CLAW_TURN_MESSAGE_ID": "msg-1",
        "EMPEROR_CLAW_TURN_THREAD_TYPE": "group",
    }

    def _clean_env(self):
        return {k: v for k, v in os.environ.items() if not k.startswith("EMPEROR_CLAW_TURN_")}

    def test_ack_outside_a_bridge_turn_posts_nothing(self):
        with patch.dict(os.environ, self._clean_env(), clear=True), \
             patch.object(plugin, "_request", return_value={"ok": True}) as request:
            result = json.loads(plugin.emperor_send_message({"text": "On it", "acknowledge": True}))
        self.assertEqual(result, {"error": "acknowledge is only available inside a bridge turn"})
        request.assert_not_called()

    def test_ack_in_a_goal_turn_posts_nothing(self):
        # A goal step exports the thread but no trigger message id.
        env = {**self._clean_env(), "EMPEROR_CLAW_TURN_THREAD_ID": "thread-1"}
        with patch.dict(os.environ, env, clear=True), \
             patch.object(plugin, "_request", return_value={"ok": True}) as request:
            result = json.loads(plugin.emperor_send_message({"text": "On it", "acknowledge": True}))
        self.assertIn("error", result)
        request.assert_not_called()

    def test_ack_into_another_thread_is_refused(self):
        with patch.dict(os.environ, {**self._clean_env(), **self.TURN}, clear=True), \
             patch.object(plugin, "_request", return_value={"ok": True}) as request:
            result = json.loads(plugin.emperor_send_message({"text": "On it", "acknowledge": True, "threadId": "other"}))
        self.assertIn("error", result)
        request.assert_not_called()

    def test_ordinary_post_is_not_an_ack(self):
        with patch.dict(os.environ, {**self._clean_env(), **self.TURN}, clear=True), \
             patch.object(plugin, "_request", return_value={"ok": True}) as request:
            plugin.emperor_send_message({"text": "handoff", "threadId": "team-x"})
        self.assertNotIn("ack", request.call_args.kwargs["body"])


if __name__ == "__main__":
    unittest.main()
