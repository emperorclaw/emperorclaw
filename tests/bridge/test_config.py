"""Configuration (design 5.7, D8): per-profile .env, host topology, credential isolation."""
from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.config import (DEFAULT_TOOLSETS, AgentConfig, ConfigError, HostConfig, host_fingerprint,  # noqa: E402
                                   load_agent_configs, read_env_file)
from emperor_bridge.interfaces import Topology  # noqa: E402
from emperor_bridge.log import warn_deleted_env  # noqa: E402


class Env:
    def __init__(self, tmp: str, profiles: dict[str, str]) -> None:
        self.home = Path(tmp)
        for name, text in profiles.items():
            folder = self.home / ".hermes" / "profiles" / name
            folder.mkdir(parents=True)
            (folder / ".env").write_text(text, encoding="utf-8")

    def env(self, **extra: str) -> dict[str, str]:
        return {"HOME": str(self.home), **extra}


class ReadEnvFileTests(unittest.TestCase):
    def test_parses_quotes_exports_and_comments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("# comment\nexport A=1\nB='two words'\nC=\"x=y\"\n\nbroken line\nD= spaced \n", encoding="utf-8")
            self.assertEqual(read_env_file(path), {"A": "1", "B": "two words", "C": "x=y", "D": "spaced"})

    def test_missing_file_is_empty(self):
        self.assertEqual(read_env_file(Path("/definitely/missing/.env")), {})


class HostConfigTests(unittest.TestCase):
    def test_profiles_from_argument_or_env(self):
        self.assertEqual(HostConfig.from_env({"HERMES_PROFILE": "qa"}).profiles, ("qa",))
        self.assertEqual(HostConfig.from_env({"HERMES_PROFILE": "qa"}, profiles="a, b").profiles, ("a", "b"))
        self.assertEqual(HostConfig.from_env({"EMPEROR_HERMES_PROFILES": "x,y"}).profiles, ("x", "y"))

    def test_missing_or_duplicate_profile_is_an_error(self):
        with self.assertRaises(ConfigError):
            HostConfig.from_env({})
        with self.assertRaises(ConfigError):
            HostConfig.from_env({}, profiles="a,a")

    def test_topology_and_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            shared = HostConfig.from_env({"HOME": tmp, "EMPEROR_CLAW_HERMES_GATEWAY": "shared"}, profiles="a,b")
            target = shared.target("a")
            self.assertEqual(shared.topology, Topology.SHARED)
            self.assertEqual(target.control_home, Path(tmp) / ".hermes")
            self.assertEqual(target.profile_home, Path(tmp) / ".hermes" / "profiles" / "a")
            standalone = HostConfig.from_env({"HOME": tmp, "HERMES_PROFILE": "a"})
            self.assertEqual(standalone.target("a").control_home, standalone.target("a").profile_home)

    def test_managed_mode_hosts_one_agent_and_bad_topology_fails(self):
        with self.assertRaises(ConfigError):
            HostConfig.from_env({"EMPEROR_CLAW_HERMES_GATEWAY": "managed"}, profiles="a,b")
        with self.assertRaises(ConfigError):
            HostConfig.from_env({"EMPEROR_CLAW_HERMES_GATEWAY": "cloud", "HERMES_PROFILE": "a"})

    def test_python_and_checkout(self):
        host = HostConfig.from_env({"HERMES_PROFILE": "a", "HERMES_PYTHON": "/py", "HERMES_CHECKOUT": "/co"})
        self.assertEqual((host.hermes_python, host.hermes_checkout), ("/py", Path("/co")))


class AgentConfigTests(unittest.TestCase):
    def test_reads_the_profile_env_and_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Env(tmp, {"qa": "EMPEROR_CLAW_API_TOKEN=tok-qa\nEMPEROR_CLAW_AGENT_ID=ag-qa\n"
                                  "EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS=1\nEMPEROR_CLAW_HERMES_TOOLSETS=emperor-claw,file\n"})
            cfg = AgentConfig.from_profile("qa", HostConfig.from_env(env.env(HERMES_PROFILE="qa")))
            self.assertEqual((cfg.api_token, cfg.agent_id, cfg.max_parallel_turns), ("tok-qa", "ag-qa", 1))
            self.assertEqual(cfg.toolsets, ("emperor-claw", "file"))
            self.assertEqual(cfg.compact_after_tokens, 60000)
            self.assertEqual(cfg.turn_idle_timeout_s, 900)
            self.assertEqual(cfg.cwd, tmp)
            self.assertEqual(cfg.health_path, cfg.profile_home / "emperor" / "health.json")
            self.assertIsNone(cfg.legacy_state_path)

    def test_process_env_is_a_fallback_for_tuning_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Env(tmp, {"qa": "EMPEROR_CLAW_API_TOKEN=t\n"})
            host = HostConfig.from_env(env.env(HERMES_PROFILE="qa", EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS="50"))
            cfg = AgentConfig.from_profile("qa", host)
            self.assertEqual(cfg.compact_after_tokens, 50)
            self.assertEqual(cfg.toolsets, DEFAULT_TOOLSETS)

    def test_credentials_never_cross_agents_in_one_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Env(tmp, {"a": "EMPEROR_CLAW_API_TOKEN=tok-a\n", "b": "EMPEROR_CLAW_AGENT_ID=ag-b\n"})
            host = HostConfig.from_env(env.env(EMPEROR_CLAW_API_TOKEN="process-token"), profiles="a,b")
            self.assertEqual(AgentConfig.from_profile("a", host).api_token, "tok-a")
            with self.assertRaises(ConfigError):
                AgentConfig.from_profile("b", host)  # no token of its own: never the process token

    def test_single_agent_may_use_the_process_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Env(tmp, {"a": "EMPEROR_CLAW_AGENT_NAME=Ada\n"})
            cfg = AgentConfig.from_profile("a", HostConfig.from_env(env.env(HERMES_PROFILE="a",
                                                                            EMPEROR_CLAW_API_TOKEN="proc")))
            self.assertEqual((cfg.api_token, cfg.agent_name), ("proc", "Ada"))

    def test_legacy_state_and_outbox_paths_are_imported_only_when_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Env(tmp, {"a": "EMPEROR_CLAW_API_TOKEN=t\nEMPEROR_CLAW_HERMES_STATE_PATH=/x/state-a.json\n"})
            cfg = AgentConfig.from_profile("a", HostConfig.from_env(env.env(HERMES_PROFILE="a")))
            self.assertEqual(cfg.legacy_state_path, Path("/x/state-a.json"))
            self.assertEqual(cfg.legacy_outbox_dir, Path("/x/state-a-outbox"))

    def test_load_agent_configs_warns_about_deleted_vars_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Env(tmp, {"a": "EMPEROR_CLAW_API_TOKEN=t\nHERMES_BIN=hermes\n",
                            "b": "EMPEROR_CLAW_API_TOKEN=u\nHERMES_BIN=hermes\n"})
            host = HostConfig.from_env(env.env(HERMES_TOOLSETS="web"), profiles="a,b")
            with self.assertLogs("test.config", level="WARNING") as logs:
                configs = load_agent_configs(host, logging.getLogger("test.config"))
            self.assertEqual(len(configs), 2)
            joined = "\n".join(logs.output)
            self.assertEqual(joined.count("HERMES_BIN"), 1)
            self.assertIn("use EMPEROR_CLAW_HERMES_TOOLSETS", joined)

    def test_warning_set_is_shared(self):
        seen: set[str] = set()
        logger = logging.getLogger("test.config2")
        with self.assertLogs("test.config2", level="WARNING"):
            self.assertEqual(warn_deleted_env([("x", {"HERMES_BIN": "1"})], logger, seen), ["HERMES_BIN"])
        self.assertEqual(warn_deleted_env([("y", {"HERMES_BIN": "1"})], logger, seen), [])


class FingerprintTests(unittest.TestCase):
    def test_hash_of_the_first_machine_id_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            second = Path(tmp) / "dbus-id"
            second.write_text("abc\n", encoding="utf-8")
            fingerprint = host_fingerprint((str(Path(tmp) / "missing"), str(second)))
            import hashlib
            self.assertEqual(fingerprint, hashlib.sha256(b"abc").hexdigest())
            self.assertIsNone(host_fingerprint((str(Path(tmp) / "missing"),)))


if __name__ == "__main__":
    unittest.main()
