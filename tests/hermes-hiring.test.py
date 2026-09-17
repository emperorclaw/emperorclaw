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
        for phrase in ["Emperor minimum operating practices", "Human mentions are text", "3–8 words", "isShared=true", "status=\"draft\"", "Common scenarios"]:
            self.assertIn(phrase, context)

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


if __name__ == "__main__":
    unittest.main()
