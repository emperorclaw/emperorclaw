"""
Tests for the Hermes worker pairing script (integrations/hermes/emperor-claw/pair.py).

Covers the poll → configure → persist → resume cycle: URL normalization, shell-safe
export lines, worker-id persistence, first-delivery persistence, and the restart
merge that reuses the persisted token when the app re-delivers without it.
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

PAIR_PATH = Path(__file__).resolve().parent.parent / "integrations" / "hermes" / "emperor-claw" / "pair.py"

TMP = Path(tempfile.mkdtemp())
os.environ.setdefault("EMPEROR_CLAW_API_URL", "emperorclaw.onrender.com:10000")
os.environ.setdefault("EMPEROR_WORKER_PAIRING_SECRET", "pairing-secret")
os.environ["EMPEROR_CLAW_HERMES_STATE_PATH"] = str(TMP / "bridge-state.json")
os.environ["EMPEROR_CLAW_PAIRING_STATE_PATH"] = str(TMP / "pairing-state.json")

spec = importlib.util.spec_from_file_location("pair", PAIR_PATH)
pair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pair)


class TestNormalizeUrl(unittest.TestCase):
    def test_bare_hostport_gets_http(self):
        self.assertEqual(pair.normalize_api_url("host.example:10000"), "http://host.example:10000")

    def test_full_url_is_kept(self):
        self.assertEqual(pair.normalize_api_url("https://host.example/"), "https://host.example")

    def test_trailing_slash_is_trimmed(self):
        self.assertEqual(pair.normalize_api_url("https://host.example////"), "https://host.example")

    def test_empty_raises(self):
        with self.assertRaises(RuntimeError):
            pair.normalize_api_url("")


class TestExportLines(unittest.TestCase):
    def test_exports_assignment_and_normalized_url(self):
        lines = pair.export_lines({
            "apiToken": "ec_token", "agentName": "Viktor", "agentId": "a1",
            "agentRole": "Operator", "llmProvider": "openai", "llmModel": "gpt-4o-mini",
            "llmApiKey": "sk-key",
        }, "http://host.example:10000")
        self.assertIn('export EMPEROR_CLAW_API_URL=http://host.example:10000', lines)
        self.assertIn('export EMPEROR_CLAW_API_TOKEN=ec_token', lines)
        self.assertIn('export EMPEROR_CLAW_AGENT_NAME=Viktor', lines)
        self.assertIn('export EMPEROR_CLAW_LLM_PROVIDER=openai', lines)
        self.assertIn('export OPENAI_API_KEY=sk-key', lines)

    def test_values_are_shell_quoted(self):
        lines = pair.export_lines({"apiToken": "tok en$'x", "agentName": "a b"}, "http://h")
        self.assertIn("export EMPEROR_CLAW_AGENT_NAME='a b'", lines)


class TestWorkerIdAndPersistence(unittest.TestCase):
    def test_stable_worker_id_is_persisted(self):
        state = {}
        wid = pair.stable_worker_id(state)
        self.assertTrue(wid.startswith("hermes-worker-"))
        self.assertEqual(pair.stable_worker_id(state), wid)
        self.assertEqual(pair.load_state().get("workerId"), wid)

    def test_persist_delivery_keeps_secrets(self):
        state = {}
        pair.persist_delivery(state, {"agentId": "a1", "agentName": "Viktor", "apiToken": "ec_token", "llmApiKey": "sk-key", "llmProvider": "openai"})
        self.assertEqual(state["apiToken"], "ec_token")
        self.assertEqual(state["llmApiKey"], "sk-key")
        self.assertEqual(state["agentId"], "a1")


class TestRestartMerge(unittest.TestCase):
    def test_first_delivery_returns_as_is(self):
        delivery = {"assigned": True, "agentId": "a1", "apiToken": "ec_token", "llmProvider": "openai"}
        self.assertEqual(pair.merged_delivery({}, delivery), delivery)

    def test_restart_reuses_persisted_secrets(self):
        state = {"apiToken": "ec_token", "llmApiKey": "sk-key", "llmProvider": "openai"}
        redelivery = {"assigned": True, "agentId": "a1", "agentName": "Viktor"}
        merged = pair.merged_delivery(state, redelivery)
        self.assertEqual(merged["apiToken"], "ec_token")
        self.assertEqual(merged["llmApiKey"], "sk-key")
        self.assertEqual(merged["llmProvider"], "openai")


class TestPairRequest(unittest.TestCase):
    def test_posts_worker_id_and_secret(self):
        from unittest.mock import patch
        class FakeResponse:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def read(self):
                return json.dumps({"assigned": True, "agentId": "a1"}).encode("utf-8")
        with patch.object(pair.urllib.request, "urlopen", return_value=FakeResponse()) as urlopen:
            result = pair.pair_request("http://h", "secret", "worker-1", None)
        self.assertEqual(result, {"assigned": True, "agentId": "a1"})
        req = urlopen.call_args.args[0]
        self.assertEqual(req.get_header("X-worker-pairing-secret"), "secret")
        self.assertIn(b"worker-1", req.data)

    def test_sends_agent_id_on_restart(self):
        from unittest.mock import patch
        class FakeResponse:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def read(self):
                return json.dumps({"assigned": True}).encode("utf-8")
        with patch.object(pair.urllib.request, "urlopen", return_value=FakeResponse()) as urlopen:
            pair.pair_request("http://h", "secret", "worker-1", "agent-9")
        req = urlopen.call_args.args[0]
        self.assertIn(b'"agentId": "agent-9"', req.data)


if __name__ == "__main__":
    unittest.main()
