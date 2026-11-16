"""emperor_hostd: GitHub Copilot as a host LLM provider.

Hermes v0.22.4 has a native `copilot` provider (plugins/model-providers/copilot) that reads a GitHub
token from COPILOT_GITHUB_TOKEN and refuses classic PATs (hermes_cli/copilot_auth.py). These tests
cover what the daemon does with it: the inventory, the plan, the provision job and the redactor.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
for extra in (BRIDGE_DIR, Path(__file__).resolve().parent):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from emperor_bridge.config import read_env_file  # noqa: E402
from emperor_hostd import commands, provision  # noqa: E402
from emperor_hostd.commands import CommandRefused  # noqa: E402
from emperor_hostd.inventory import build_inventory  # noqa: E402
from emperor_hostd.protocol import Redactor  # noqa: E402
from test_hostd import HOST_TOKEN, FakeHome, fake_systemctl, write  # noqa: E402
from test_hostd_provision import NEW_TOKEN, FakeMachine, run_provision, spec  # noqa: E402

# Fake, low-entropy tokens: shapes only.
OAUTH = "gho_" + "x" * 36
FINE_GRAINED = "github_pat_" + "z" * 60
CLASSIC = "ghp_" + "q" * 36
POSIX = os.name == "posix"


def copilot_home(tmp: str, token: str = OAUTH) -> FakeHome:
    home = FakeHome(tmp)
    with (home.paths.hermes_root / ".env").open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(f'COPILOT_GITHUB_TOKEN="{token}"\n')
    return home


class CopilotInventoryTests(unittest.TestCase):
    def test_a_copilot_token_reports_the_copilot_provider(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = copilot_home(tmp)
            red = Redactor([HOST_TOKEN])
            inv = build_inventory(home.paths, "https://emperor.example.com", red, run=fake_systemctl)
            self.assertEqual(inv["llmProviders"], ["anthropic", "copilot", "deepseek", "openai"])
            self.assertNotIn(OAUTH, json.dumps(inv))
            self.assertNotIn(OAUTH, red.text(f"the token was {OAUTH}"), "the token value is redacted once read")

    def test_a_classic_pat_or_an_empty_token_is_not_a_copilot_provider(self):
        for token in (CLASSIC, ""):
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = copilot_home(tmp, token)
                inv = build_inventory(home.paths, "https://emperor.example.com", Redactor([HOST_TOKEN]), run=fake_systemctl)
                self.assertNotIn("copilot", inv["llmProviders"], token[:4])

    def test_other_tool_keys_and_tokens_are_still_not_providers(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = copilot_home(tmp)
            with (home.paths.hermes_root / ".env").open("a", encoding="utf-8", newline="\n") as fh:
                fh.write(f'GITHUB_TOKEN="{OAUTH}"\nTELEGRAM_BOT_TOKEN=123:abc\n')
            inv = build_inventory(home.paths, "https://emperor.example.com", Redactor(), run=fake_systemctl)
            self.assertEqual(inv["llmProviders"], ["anthropic", "copilot", "deepseek", "openai"])


class CopilotPlanTests(unittest.TestCase):
    def test_copilot_is_a_supported_host_provider(self):
        self.assertEqual(commands.PROVIDER_KEY_NAMES["copilot"], ("COPILOT_GITHUB_TOKEN",))
        self.assertEqual(provision.HERMES_PROVIDER["copilot"], ("copilot", None))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = copilot_home(tmp)
            plan = commands.plan(home.paths, "provision_agent", spec(llmProvider="copilot", model="gpt-5-mini"))
            self.assertEqual(plan.module, "emperor_hostd.provision")
            self.assertNotIn(OAUTH, repr(plan))

    def test_no_copilot_token_reads_as_a_missing_credential(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "provision_agent", spec(llmProvider="copilot", model="gpt-5-mini"))
            self.assertEqual(ctx.exception.code, "no_api_key")
            self.assertIn("No copilot credential on this host; add COPILOT_GITHUB_TOKEN=", str(ctx.exception))
            self.assertIn("gh auth token", str(ctx.exception))

    def test_a_classic_pat_is_refused_at_plan_time_without_its_value(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = copilot_home(tmp, CLASSIC)
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "provision_agent", spec(llmProvider="copilot", model="gpt-5-mini"))
            self.assertEqual(ctx.exception.code, "no_api_key")
            self.assertIn("Classic PATs (ghp_) are not supported", str(ctx.exception))
            self.assertIn("COPILOT_GITHUB_TOKEN in ~/.hermes/.env", str(ctx.exception))
            self.assertNotIn(CLASSIC, str(ctx.exception))

    def test_token_shapes(self):
        for token in (OAUTH, FINE_GRAINED, "ghu_" + "y" * 36, f"  {OAUTH}  "):
            self.assertTrue(commands.copilot_token_usable(token), token[:4])
        for token in (CLASSIC, "sk-abc", "gho_ space", "", "token"):
            self.assertFalse(commands.copilot_token_usable(token), token[:4])
        self.assertIsNone(commands.provider_key_problem("deepseek", "DEEPSEEK_API_KEY", CLASSIC, "x"))
        problem = commands.provider_key_problem("copilot", "COPILOT_GITHUB_TOKEN", "sk-not-github-000", "profile a")
        self.assertIn("not a GitHub token the Copilot API accepts", problem)
        self.assertNotIn("sk-not-github-000", problem)


class CopilotProvisionTests(unittest.TestCase):
    def test_a_copilot_agent_end_to_end(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = copilot_home(tmp, FINE_GRAINED)
            machine = FakeMachine(home, clone_config={"model.base_url": "https://old.example.com/v1"})
            code, out = run_provision(home, machine, spec(llmProvider="copilot", model="claude-sonnet-4.5"))
            self.assertEqual(code, 0, out)
            p = home.paths.profile_home("growth-hacker")
            env = read_env_file(p / ".env")
            self.assertEqual(env["COPILOT_GITHUB_TOKEN"], FINE_GRAINED)
            self.assertNotIn("DEEPSEEK_API_KEY", env, "only the chosen provider's credential is copied")
            if POSIX:
                self.assertEqual(stat.S_IMODE((p / ".env").stat().st_mode), 0o600)
            launcher = machine.calls[0][0]
            self.assertIn([launcher, "-p", "growth-hacker", "config", "set", "model.provider", "copilot"], machine.calls)
            self.assertIn([launcher, "-p", "growth-hacker", "config", "set", "model.default", "claude-sonnet-4.5"], machine.calls)
            # Hermes' default Copilot endpoint: a cloned base URL is removed.
            self.assertNotIn("model.base_url", machine.config["growth-hacker"])
            self.assertIn("using COPILOT_GITHUB_TOKEN from ~/.hermes/.env", out)
            for secret in (FINE_GRAINED, NEW_TOKEN, HOST_TOKEN):
                self.assertNotIn(secret, out)
                self.assertNotIn(secret, json.dumps(machine.calls))

    def test_a_classic_pat_stops_the_job_before_anything_is_written(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = copilot_home(tmp, CLASSIC)
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec(llmProvider="copilot", model="gpt-5-mini"))
            self.assertEqual(code, provision.EXIT_NO_KEY)
            self.assertIn("Classic PATs (ghp_) are not supported", out)
            self.assertNotIn(CLASSIC, out)
            self.assertEqual(machine.calls, [])
            self.assertFalse(home.paths.profile_home("growth-hacker").exists())


class GithubTokenRedactionTests(unittest.TestCase):
    def test_bare_github_tokens_are_redacted_and_other_patterns_still_work(self):
        red = Redactor()
        text = red.text(f"tokens {OAUTH} {CLASSIC} {FINE_GRAINED} Bearer abc.def.ghi DEEPSEEK_API_KEY=sk-zzz gho_short")
        for secret in (OAUTH, CLASSIC, FINE_GRAINED, "abc.def.ghi", "sk-zzz"):
            self.assertNotIn(secret, text)
        self.assertIn("Bearer [redacted]", text)
        self.assertIn("DEEPSEEK_API_KEY=[redacted]", text)
        self.assertIn("gho_short", text, "short look-alikes are left alone")


if __name__ == "__main__":
    unittest.main()
