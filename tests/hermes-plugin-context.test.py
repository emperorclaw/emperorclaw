"""Per-session credentials and turn context in the Emperor Hermes plugin.

One gateway process can serve several sessions, and in shared mode several
agents. The plugin must take per-session data only from bound_client_env()
and the bridge's turn file (<profileHome>/emperor/turns/<threadId>.json),
never from os.environ, and it must not register the pre_llm_call hook.
"""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "integrations/hermes/emperor-claw"
spec = importlib.util.spec_from_file_location("hermes_plugin_context", PLUGIN_DIR / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

PROCESS_ENV = {
    "EMPEROR_CLAW_API_URL": "https://process.example",
    "EMPEROR_CLAW_API_TOKEN": "process-token",
    "EMPEROR_CLAW_AGENT_ID": "process-agent",
    "EMPEROR_CLAW_TURN_THREAD_ID": "env-thread",
    "EMPEROR_CLAW_TURN_MESSAGE_ID": "env-message",
    "EMPEROR_CLAW_TURN_THREAD_TYPE": "direct",
    "HERMES_SESSION_ID": "someone-elses-session",
}


def _iso(delta_seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat().replace("+00:00", "Z")


class _Response:
    status = 200

    def __init__(self, body=b'{"ok":true}'):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ProfileFixture:
    """A temporary profile home with its own .env and turn directory."""

    def __init__(self, root, name, token, agent_id, url="https://emperor.example"):
        self.home = Path(root) / name
        (self.home / "emperor" / "turns").mkdir(parents=True)
        self.write_env(token, agent_id, url)

    def write_env(self, token, agent_id, url="https://emperor.example"):
        path = self.home / ".env"
        lines = [
            "# profile env",
            f"export EMPEROR_CLAW_API_URL={url}/",
            f'EMPEROR_CLAW_API_TOKEN="{token}"',
            f"EMPEROR_CLAW_AGENT_ID={agent_id}  # inline comment",
            "OPENAI_API_KEY=sk-not-ours",
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        # Force a distinct mtime so the cache sees the rewrite.
        stamp = time.time_ns() + int(1e9) * (1 + len(token))
        os.utime(path, ns=(stamp, stamp))

    def bound(self, thread_id="thread-1", generation="3", thread_type="direct", agent_id="bound-agent"):
        return {
            "EMPEROR_PROFILE_HOME": str(self.home),
            "EMPEROR_THREAD_ID": thread_id,
            "EMPEROR_THREAD_TYPE": thread_type,
            "EMPEROR_SESSION_GEN": generation,
            "EMPEROR_AGENT_ID": agent_id,
            "HERMES_EPHEMERAL_SYSTEM_PROMPT": "system",
        }

    def write_turn(self, thread_id="thread-1", **overrides):
        data = {
            "threadId": thread_id,
            "messageId": "msg-42",
            "runId": "run-42",
            "submissionId": "emp-msg-42",
            "sessionGeneration": 3,
            "expiresAt": _iso(600),
        }
        data.update(overrides)
        data = {k: v for k, v in data.items() if v is not None}
        (self.home / "emperor" / "turns" / f"{thread_id}.json").write_text(json.dumps(data), encoding="utf-8")


class PluginContextCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.viktor = ProfileFixture(self.root, "viktor", "viktor-token", "viktor-id")
        self.qa = ProfileFixture(self.root, "qa", "qa-token", "qa-id", url="https://qa.example")
        env = patch.dict(os.environ, PROCESS_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self._tmp.cleanup)
        plugin._dotenv_cache.clear()

    def bind(self, bound):
        return patch.object(plugin, "_bound_env", return_value=dict(bound))


class CredentialTests(PluginContextCase):
    def test_each_profile_uses_its_own_env_file(self):
        with self.bind(self.viktor.bound()):
            viktor = plugin._creds()
        with self.bind(self.qa.bound()):
            qa = plugin._creds()
        self.assertEqual((viktor["token"], viktor["agent_ref"], viktor["url"]),
                         ("viktor-token", "viktor-id", "https://emperor.example"))
        self.assertEqual((qa["token"], qa["agent_ref"], qa["url"]), ("qa-token", "qa-id", "https://qa.example"))

    def test_requests_carry_the_bound_profiles_bearer(self):
        seen = []

        def fake_urlopen(req, timeout=0):
            seen.append((req.full_url, req.get_header("Authorization")))
            return _Response()

        with patch.object(plugin.urllib.request, "urlopen", side_effect=fake_urlopen):
            with self.bind(self.viktor.bound()):
                plugin.emperor_health({})
            with self.bind(self.qa.bound()):
                plugin.emperor_health({})
        self.assertEqual(seen, [
            ("https://emperor.example/api/mcp/runtime/health", "Bearer viktor-token"),
            ("https://qa.example/api/mcp/runtime/health", "Bearer qa-token"),
        ])

    def test_parallel_sessions_in_one_process_never_mix_tokens(self):
        # Simulates a shared gateway: the binding is per thread (Hermes uses a
        # ContextVar), while os.environ holds a third, unrelated token.
        local = threading.local()
        seen = {}
        barrier = threading.Barrier(2)

        def fake_urlopen(req, timeout=0):
            barrier.wait(timeout=5)
            seen[local.name] = req.get_header("Authorization")
            return _Response()

        def run(name, profile):
            local.name = name
            local.bound = profile.bound()
            plugin.emperor_health({})

        with patch.object(plugin, "_bound_env", side_effect=lambda: dict(local.bound)), \
                patch.object(plugin.urllib.request, "urlopen", side_effect=fake_urlopen):
            threads = [threading.Thread(target=run, args=("viktor", self.viktor)),
                       threading.Thread(target=run, args=("qa", self.qa))]
            for t in threads:
                t.start()
            for t in threads:
                t.join(10)
        self.assertEqual(seen, {"viktor": "Bearer viktor-token", "qa": "Bearer qa-token"})

    def test_bound_session_without_token_never_falls_back_to_process_env(self):
        (self.viktor.home / ".env").write_text("EMPEROR_CLAW_AGENT_ID=viktor-id\n", encoding="utf-8")
        with self.bind(self.viktor.bound()), \
                patch.object(plugin.urllib.request, "urlopen", side_effect=AssertionError("must not post")):
            out = json.loads(plugin.emperor_health({}))
            self.assertFalse(plugin._available())
        self.assertFalse(out["ok"])
        self.assertIn("EMPEROR_CLAW_API_TOKEN is not set", out["error"])
        self.assertIn(str(self.viktor.home / ".env"), out["error"])

    def test_missing_env_file_is_a_clear_error(self):
        (self.qa.home / ".env").unlink()
        with self.bind(self.qa.bound()), \
                patch.object(plugin.urllib.request, "urlopen", side_effect=AssertionError("must not post")):
            out = json.loads(plugin.emperor_list_projects({}))
        self.assertIn("not configured", out["error"])

    def test_agent_id_falls_back_to_the_bound_agent(self):
        (self.qa.home / ".env").write_text("EMPEROR_CLAW_API_TOKEN=qa-token\n", encoding="utf-8")
        with self.bind(self.qa.bound(agent_id="qa-bound")):
            self.assertEqual(plugin._agent_ref(), "qa-bound")

    def test_token_rotation_lands_on_the_next_call(self):
        with self.bind(self.viktor.bound()):
            self.assertEqual(plugin._token(), "viktor-token")
            self.viktor.write_env("viktor-rotated", "viktor-id")
            self.assertEqual(plugin._token(), "viktor-rotated")

    def test_unbound_sessions_use_the_process_environment(self):
        with self.bind({}):
            creds = plugin._creds()
            self.assertTrue(plugin._available())
        self.assertEqual((creds["token"], creds["agent_ref"], creds["url"]),
                         ("process-token", "process-agent", "https://process.example"))

    def test_unbound_without_any_token_keeps_tools_listed_but_errors(self):
        with self.bind({}), patch.dict(os.environ, {"EMPEROR_CLAW_API_TOKEN": ""}):
            self.assertTrue(plugin._available())
            out = json.loads(plugin.emperor_health({}))
        self.assertIn("EMPEROR_CLAW_API_TOKEN is not set in environment", out["error"])

    def test_dotenv_parsing(self):
        parsed = plugin._parse_dotenv(
            "# c\n\nexport A=1\nB = 'two words'\nC=\"x # not a comment\"\nD=v # comment\nnot a line\nE=\n"
        )
        self.assertEqual(parsed, {"A": "1", "B": "two words", "C": "x # not a comment", "D": "v", "E": ""})


class BoundEnvTests(unittest.TestCase):
    def _install(self, fn):
        agent = types.ModuleType("agent")
        module = types.ModuleType("agent.session_client_env")
        module.bound_client_env = fn
        agent.session_client_env = module
        return patch.dict(sys.modules, {"agent": agent, "agent.session_client_env": module})

    def test_reads_hermes_bound_client_env(self):
        with self._install(lambda: {"EMPEROR_THREAD_ID": "t-1"}):
            self.assertEqual(plugin._bound_env(), {"EMPEROR_THREAD_ID": "t-1"})

    def test_outside_a_session_is_empty(self):
        with self._install(lambda: None):
            self.assertEqual(plugin._bound_env(), {})

    def test_without_hermes_is_empty(self):
        with patch.dict(sys.modules, {"agent": None, "agent.session_client_env": None}):
            self.assertEqual(plugin._bound_env(), {})


class TurnContextTests(PluginContextCase):
    def test_valid_turn_file(self):
        self.viktor.write_turn()
        with self.bind(self.viktor.bound()):
            turn = plugin._turn_context()
        self.assertEqual(turn["threadId"], "thread-1")
        self.assertEqual(turn["messageId"], "msg-42")
        self.assertEqual(turn["runId"], "run-42")
        self.assertEqual(turn["threadType"], "direct")
        self.assertEqual(turn["sessionGeneration"], "3")

    def test_epoch_expiry_in_seconds_and_millis(self):
        for expires in (time.time() + 600, (time.time() + 600) * 1000):
            self.viktor.write_turn(expiresAt=expires)
            with self.bind(self.viktor.bound()):
                self.assertIsNotNone(plugin._turn_context(), expires)

    def test_invalid_turn_files_give_no_context(self):
        cases = {
            "expired": {"expiresAt": _iso(-1)},
            "no expiry": {"expiresAt": None},
            "bad expiry": {"expiresAt": "soon"},
            "other generation": {"sessionGeneration": 2},
            "no generation": {"sessionGeneration": None},
            "other thread": {"threadId": "thread-2"},
            "no message": {"messageId": None},
        }
        for name, overrides in cases.items():
            with self.subTest(name):
                # Always thread-1.json; "other thread" names thread-2 inside it.
                self.viktor.write_turn(**overrides)
                with self.bind(self.viktor.bound()):
                    self.assertIsNone(plugin._turn_context())

    def test_missing_or_corrupt_file_gives_no_context(self):
        with self.bind(self.viktor.bound()):
            self.assertIsNone(plugin._turn_context())
        (self.viktor.home / "emperor/turns/thread-1.json").write_text("{not json", encoding="utf-8")
        with self.bind(self.viktor.bound()):
            self.assertIsNone(plugin._turn_context())

    def test_unsafe_thread_id_is_never_used_as_a_path(self):
        (Path(self.root) / "escape.json").write_text(json.dumps({"messageId": "x", "sessionGeneration": 3, "expiresAt": _iso(600)}))
        with self.bind(self.viktor.bound(thread_id="../../escape")):
            self.assertIsNone(plugin._turn_context())

    def test_turn_files_are_per_profile(self):
        self.viktor.write_turn(messageId="viktor-msg")
        self.qa.write_turn(messageId="qa-msg")
        with self.bind(self.viktor.bound()):
            self.assertEqual(plugin._turn_context()["messageId"], "viktor-msg")
        with self.bind(self.qa.bound()):
            self.assertEqual(plugin._turn_context()["messageId"], "qa-msg")

    def test_process_env_turn_variables_are_ignored(self):
        # PROCESS_ENV sets EMPEROR_CLAW_TURN_* and HERMES_SESSION_ID: unbound, there is no turn.
        with self.bind({}):
            self.assertIsNone(plugin._turn_context())


class AckFlowTests(PluginContextCase):
    def send(self, bound, args):
        with self.bind(bound), patch.object(plugin, "_request", return_value={"ok": True}) as request:
            out = json.loads(plugin.emperor_send_message(args))
        return out, request

    def test_ack_posts_into_the_turn_thread_replying_to_the_turn_message(self):
        self.viktor.write_turn()
        out, request = self.send(self.viktor.bound(), {"text": "On it.", "acknowledge": True})
        self.assertEqual(out, {"ok": True})
        method, path = request.call_args.args[:2]
        body = request.call_args.kwargs["body"]
        self.assertEqual((method, path), ("POST", "/messages/send"))
        self.assertEqual(body["thread_id"], "thread-1")
        self.assertEqual(body["thread_type"], "direct")
        self.assertEqual(body["replyToMessageId"], "msg-42")
        self.assertIs(body["ack"], True)
        self.assertEqual(body["agentId"], "viktor-id")

    def test_ack_without_a_turn_file_posts_nothing(self):
        out, request = self.send(self.viktor.bound(), {"text": "On it.", "acknowledge": True})
        self.assertIn("only available inside a bridge turn", out["error"])
        request.assert_not_called()

    def test_ack_with_a_stale_turn_file_posts_nothing(self):
        self.viktor.write_turn(expiresAt=_iso(-5))
        out, request = self.send(self.viktor.bound(), {"text": "On it.", "acknowledge": True})
        self.assertIn("error", out)
        request.assert_not_called()
        self.viktor.write_turn(sessionGeneration=2)
        out, request = self.send(self.viktor.bound(), {"text": "On it.", "acknowledge": True})
        self.assertIn("error", out)
        request.assert_not_called()

    def test_ack_ignores_process_env_turn_variables(self):
        out, request = self.send({}, {"text": "On it.", "acknowledge": True})
        self.assertIn("error", out)
        request.assert_not_called()

    def test_ack_into_another_thread_is_refused(self):
        self.viktor.write_turn()
        out, request = self.send(self.viktor.bound(), {"text": "On it.", "acknowledge": True, "threadId": "thread-9"})
        self.assertIn("only into the thread", out["error"])
        request.assert_not_called()

    def test_post_to_another_thread_does_not_claim_a_reply(self):
        self.viktor.write_turn()
        _, request = self.send(self.viktor.bound(), {"text": "@QA please check", "threadId": "team-7", "threadType": "team"})
        body = request.call_args.kwargs["body"]
        self.assertEqual(body["thread_id"], "team-7")
        self.assertNotIn("replyToMessageId", body)
        self.assertNotIn("ack", body)


class RegistrationTests(unittest.TestCase):
    class Context:
        def __init__(self):
            self.tools, self.hooks, self.skills = {}, [], []

        def register_tool(self, name, toolset, schema, fn, **kwargs):
            self.tools[name] = kwargs

        def register_skill(self, *args):
            self.skills.append(args)

        def register_hook(self, *args):
            self.hooks.append(args)

    def test_registers_tools_and_skill_without_hook_or_process_token(self):
        ctx = self.Context()
        with patch.dict(os.environ, {"EMPEROR_CLAW_API_TOKEN": ""}):
            plugin.register(ctx)
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(len(ctx.skills), 1)
        self.assertIn("emperor_send_message", ctx.tools)
        self.assertTrue(all(kw.get("check_fn") is plugin._available for kw in ctx.tools.values()))
        self.assertFalse(hasattr(plugin, "emperor_context_hook"))

    def test_manifest_matches(self):
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("version: 0.9.2", manifest)
        self.assertNotIn("provides_hooks", manifest)
        self.assertNotIn("pre_llm_call", manifest)
        ctx = self.Context()
        plugin.register(ctx)
        listed = [line.strip()[2:] for line in manifest.splitlines() if line.startswith("  - emperor_")]
        self.assertEqual(sorted(listed), sorted(ctx.tools))

    def test_source_has_no_process_env_session_reads(self):
        source = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8")
        for banned in ("EMPEROR_CLAW_TURN_", "EMPEROR_CLAW_CONTEXT_MODE", "PROMPT_INCLUDES_OPERATING_GUIDE",
                       "register_hook", 'environ.get("HERMES_SESSION', "environ.get('HERMES_SESSION",
                       'environ["HERMES_SESSION'):
            self.assertNotIn(banned, source)


if __name__ == "__main__":
    unittest.main()
