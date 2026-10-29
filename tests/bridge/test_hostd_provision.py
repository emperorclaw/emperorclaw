"""emperor_hostd 0.22: provision_agent (setting a new agent up on this host) and remove_agent.

Hermes and the installer are faked (an injected runner); everything else is the real code: the
plan checks, the key lookup, the .env the daemon writes, the spec file, the runner and a session.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
for extra in (BRIDGE_DIR, Path(__file__).resolve().parent):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from emperor_bridge.config import read_env_file  # noqa: E402
from emperor_hostd import commands, provision  # noqa: E402
from emperor_hostd.commands import CommandRefused  # noqa: E402
from emperor_hostd.connection import HostSession  # noqa: E402
from emperor_hostd.inventory import build_hello  # noqa: E402
from emperor_hostd.protocol import Redactor, encode  # noqa: E402
from emperor_hostd.runner import JobRunner, JobStore  # noqa: E402
from test_hostd import (AGENT, AGENT_TOKEN, ANTHROPIC, DEEPSEEK, HOST_TOKEN, JOB_A, OPENAI, WELCOME, FakeHome,  # noqa: E402
                        FakeTransport, InstantExecutor, _ctx, _settle, write)
from emperor_hostd.connection import HostClosed  # noqa: E402

NEW_AGENT = "44444444-4444-4444-8444-444444444444"
NEW_TOKEN = "ec_" + "e" * 48
OTHER_TOKEN = "ec_" + "f" * 48
POSIX = os.name == "posix"


def spec(**over: Any) -> dict[str, Any]:
    base = {"profile": "growth-hacker", "agentId": NEW_AGENT, "agentName": "Growth Hacker", "apiToken": NEW_TOKEN,
            "gateway": "standalone", "llmProvider": "deepseek", "model": "deepseek-chat", "skipBrowser": True}
    base.update(over)
    return base


class FakeMachine:
    """Hermes and emperor-hermes as the provision job sees them: argv in, files out. `config` holds
    each profile's config keys (what `hermes config get/set/unset` see)."""

    def __init__(self, home: FakeHome, register: bool = True, install_code: int = 0, clone_env: str = "",
                 clone_config: dict[str, str] | None = None, create_code: int = 0, unset_works: bool = True) -> None:
        self.home = home
        self.calls: list[list[str]] = []
        self.register = register
        self.install_code = install_code
        self.create_code = create_code
        self.unset_works = unset_works
        # Hermes v0.22.4 clones the default home's .env too (profiles._CLONE_CONFIG_FILES).
        self.clone_env = clone_env or (f'DEEPSEEK_API_KEY="{DEEPSEEK}"\nOPENAI_API_KEY="{OPENAI}"\nHERMES_TOOLSETS=web\n'
                                       'EMPEROR_CLAW_API_URL="https://evil.example.com"\n')
        self.clone_config = dict(clone_config or {})
        self.config: dict[str, dict[str, str]] = {}

    def _profile(self, argv: list[str]) -> str:
        return argv[argv.index("-p") + 1] if "-p" in argv else "default"

    def __call__(self, argv) -> int:
        argv = list(argv)
        self.calls.append(argv)
        paths = self.home.paths
        if argv[1:3] == ["profile", "create"]:
            profile_home = paths.profile_home(argv[3])
            profile_home.mkdir(parents=True)
            write(profile_home / ".env", self.clone_env)
            write(profile_home / "config.yaml", "model:\n  default: other\n")
            self.config[argv[3]] = dict(self.clone_config)
            return self.create_code
        if "config" in argv:
            cfg = self.config.setdefault(self._profile(argv), {})
            op, key = argv[argv.index("config") + 1], argv[argv.index("config") + 2]
            if op == "set":
                cfg[key] = argv[argv.index("config") + 3]
                return 0
            if op == "unset":
                if key not in cfg:
                    return 1
                if self.unset_works:
                    del cfg[key]
                return 0
        if argv[:1] == ["/bin/bash"] and "install" in argv:
            profile = argv[argv.index("--profile") + 1]
            gateway = argv[argv.index("--gateway") + 1]
            write(paths.records_dir / f"{profile}.env", f'status="active"\ntopology="{gateway}"\n')
            if self.register:
                write(paths.profile_home(profile) / "emperor" / "health.json", json.dumps({"registered": True}))
            return self.install_code
        if argv[:2] == ["systemctl", "--user"]:
            return 0
        return 2

    def capture(self, argv) -> tuple[int, str]:
        argv = list(argv)
        self.calls.append(argv)
        key = argv[argv.index("get") + 1]
        cfg = self.config.get(self._profile(argv), {})
        if key not in cfg:
            return 1, f"Config key not set: {key}\n"
        return 0, json.dumps(cfg[key]) + "\n"


def run_provision(home: FakeHome, machine: FakeMachine, data: dict[str, Any], register_timeout: float = 10.0) -> tuple[int, str]:
    now = [0.0]

    def sleep(delay: float) -> None:
        now[0] += delay

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = provision.Provisioner(home.paths, {**data, "jobId": JOB_A}, run=machine, sleep=sleep, clock=lambda: now[0],
                                     register_timeout=register_timeout, capture=machine.capture).run()
    return code, out.getvalue()


class ProvisionPlanTests(unittest.TestCase):
    def test_a_profile_of_another_agent_is_refused_the_same_agent_reruns(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "provision_agent", spec(profile="viktor"))
            self.assertEqual(ctx.exception.code, "profile_conflict")
            # viktor's .env names AGENT: the same agent may set it up again.
            plan = commands.plan(home.paths, "provision_agent", spec(profile="viktor", agentId=AGENT))
            self.assertEqual(plan.module, "emperor_hostd.provision")
            # A profile made by hand (no agent id in its .env) is never taken over.
            write(home.paths.profile_home("handmade") / ".env", "SOMETHING=1\n")
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "provision_agent", spec(profile="handmade"))
            self.assertEqual(ctx.exception.code, "profile_conflict")

    def test_the_token_never_reaches_argv_args_or_repr(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            plan = commands.plan(home.paths, "provision_agent", spec())
            self.assertEqual(plan.argv, [])
            self.assertNotIn("apiToken", plan.args)
            self.assertEqual(plan.secret_spec["apiToken"], NEW_TOKEN)
            self.assertNotIn(NEW_TOKEN, repr(plan))
            self.assertEqual(plan.token_sha256, hashlib.sha256(NEW_TOKEN.encode()).hexdigest())

    def test_no_key_on_the_host_is_refused_with_a_clear_message(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "provision_agent", spec(llmProvider="openrouter"))
            self.assertEqual(ctx.exception.code, "no_api_key")
            self.assertIn("No openrouter API key on this host", str(ctx.exception))
            self.assertIn("~/.hermes/.env", str(ctx.exception))

    def test_names_hermes_refuses_and_url_overrides_are_refused(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            for bad in ("Growth", "default", "gateway", "a.b", "a;rm"):
                with self.assertRaises(CommandRefused, msg=bad):
                    commands.plan(home.paths, "provision_agent", spec(profile=bad))
            for extra in ({"apiUrl": "https://evil.example.com"}, {"emperorUrl": "https://evil.example.com"}, {"env": {"A": "1"}}):
                with self.assertRaises(CommandRefused):
                    commands.plan(home.paths, "provision_agent", spec(**extra))
            with self.assertRaises(CommandRefused):
                commands.plan(home.paths, "provision_agent", spec(llmProvider="custom"))

    def test_key_lookup_order_default_home_then_profiles_by_name(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            self.assertEqual(commands.find_provider_key(home.paths, "deepseek", "new")[2], "~/.hermes/.env")
            name, value, where = commands.find_provider_key(home.paths, "anthropic", "new")
            self.assertEqual((name, value, where), ("ANTHROPIC_API_KEY", ANTHROPIC, "profile viktor"))
            # Two profiles hold the key: the first by name wins (deterministic).
            write(home.paths.profile_home("alpha") / ".env", 'ANTHROPIC_API_KEY="sk-ant-alpha-000000"\n')
            self.assertEqual(commands.find_provider_key(home.paths, "anthropic", "new")[2], "profile alpha")
            # A rerun takes the key the profile itself already has.
            write(home.paths.profile_home("new") / ".env", 'ANTHROPIC_API_KEY="sk-ant-own-000000"\n')
            self.assertEqual(commands.find_provider_key(home.paths, "anthropic", "new")[2], "profile new")
            self.assertIsNone(commands.find_provider_key(home.paths, "openrouter", "new"))


class ProvisionJobTests(unittest.TestCase):
    def test_a_new_profile_end_to_end(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec())
            self.assertEqual(code, 0, out)
            p = home.paths.profile_home("growth-hacker")
            env = read_env_file(p / ".env")
            # The URL comes from hostd.env only (the clone's evil URL is gone), with the agent's identity.
            self.assertEqual(env["EMPEROR_CLAW_API_URL"], "https://emperor.example.com")
            self.assertEqual(env["EMPEROR_CLAW_API_TOKEN"], NEW_TOKEN)
            self.assertEqual(env["EMPEROR_CLAW_AGENT_ID"], NEW_AGENT)
            self.assertEqual(env["EMPEROR_CLAW_AGENT_NAME"], "Growth Hacker")
            # Only the chosen provider's key; the cloned OpenAI key is dropped, settings are kept.
            self.assertEqual(env["DEEPSEEK_API_KEY"], DEEPSEEK)
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("ANTHROPIC_API_KEY", env)
            self.assertEqual(env["HERMES_TOOLSETS"], "web")
            self.assertEqual((p / ".env").read_text(encoding="utf-8").count("EMPEROR_CLAW_API_URL"), 1)
            if POSIX:
                self.assertEqual(stat.S_IMODE((p / ".env").stat().st_mode), 0o600)
            launcher = machine.calls[0][0]
            self.assertEqual(machine.calls[0], [launcher, "profile", "create", "growth-hacker", "--clone-from", "default"])
            self.assertIn([launcher, "-p", "growth-hacker", "config", "set", "model.provider", "deepseek"], machine.calls)
            self.assertIn([launcher, "-p", "growth-hacker", "config", "set", "model.default", "deepseek-chat"], machine.calls)
            install = [c for c in machine.calls if c[:1] == ["/bin/bash"]][0]
            self.assertEqual(install[2:], ["install", "--profile", "growth-hacker", "--gateway", "standalone", "--non-interactive", "--yes", "--skip-browser"])
            self.assertTrue(all(isinstance(a, str) for c in machine.calls for a in c))
            self.assertIn("==> Online", out)
            for secret in (NEW_TOKEN, DEEPSEEK, OPENAI, ANTHROPIC, HOST_TOKEN):
                self.assertNotIn(secret, out, "nothing secret in the job output")
                self.assertNotIn(secret, json.dumps(machine.calls), "nothing secret in any argv")

    def test_openai_goes_through_custom_with_a_base_url_and_shared_gateway_flags(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            write(home.paths.hermes_root / ".env", f'OPENAI_API_KEY="{OPENAI}"\n')
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec(llmProvider="openai", model="gpt-4o-mini", gateway="shared", skipBrowser=False, maxParallel=2))
            self.assertEqual(code, 0, out)
            sets = [c[4:] for c in machine.calls if "config" in c]
            self.assertIn(["set", "model.provider", "custom"], sets)
            self.assertIn(["set", "model.base_url", "https://api.openai.com/v1"], sets)
            install = [c for c in machine.calls if c[:1] == ["/bin/bash"]][0]
            self.assertIn("shared", install)
            self.assertNotIn("--skip-browser", install)
            self.assertEqual(install[-2:], ["--max-parallel", "2"])

    def test_an_idempotent_rerun_for_the_same_agent_writes_the_new_token(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            self.assertEqual(run_provision(home, FakeMachine(home), spec())[0], 0)
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec(apiToken=OTHER_TOKEN))
            self.assertEqual(code, 0, out)
            self.assertFalse(any(c[1:3] == ["profile", "create"] for c in machine.calls), "the profile is not created twice")
            env_text = (home.paths.profile_home("growth-hacker") / ".env").read_text(encoding="utf-8")
            self.assertIn(OTHER_TOKEN, env_text)
            self.assertNotIn(NEW_TOKEN, env_text)
            self.assertEqual(env_text.count("EMPEROR_CLAW_API_TOKEN"), 1)

    def test_another_agents_profile_is_left_untouched(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            before = (home.paths.profile_home("viktor") / ".env").read_text(encoding="utf-8")
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec(profile="viktor"))
            self.assertEqual(code, provision.EXIT_PROFILE_CONFLICT)
            self.assertIn("already exists on this host for another agent", out)
            self.assertEqual((home.paths.profile_home("viktor") / ".env").read_text(encoding="utf-8"), before)
            self.assertEqual(machine.calls, [])

    def test_no_key_stops_before_anything_is_created(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec(llmProvider="openrouter"))
            self.assertEqual(code, provision.EXIT_NO_KEY)
            self.assertIn("No openrouter API key on this host; add OPENROUTER_API_KEY", out)
            self.assertEqual(machine.calls, [])
            self.assertFalse(home.paths.profile_home("growth-hacker").exists())

    def test_a_brand_new_host_without_any_key_fails_early(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            write(home.paths.hermes_root / ".env", "")
            for name in ("viktor", "qa"):
                write(home.paths.profile_home(name) / ".env", "")
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "provision_agent", spec())
            self.assertEqual(ctx.exception.code, "no_api_key")

    def test_the_url_never_comes_from_the_command(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            with self.assertRaises(CommandRefused):
                provision.Provisioner(home.paths, spec(apiUrl="https://evil.example.com"))
            # Without a valid hostd.env there is no URL at all: it stops (exit 14), nothing is created.
            home.paths.hostd_env.unlink()
            machine = FakeMachine(home)
            code, _ = run_provision(home, machine, spec())
            self.assertEqual(code, provision.EXIT_CONFIG)
            self.assertEqual(machine.calls, [])

    def test_not_registered_in_time_and_installer_failures(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            code, out = run_provision(home, FakeMachine(home, register=False), spec(), register_timeout=6)
            self.assertEqual(code, provision.EXIT_NOT_REGISTERED)
            self.assertIn("did not register with Emperor", out)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            code, out = run_provision(home, FakeMachine(home, install_code=7), spec())
            self.assertEqual(code, 7)
            self.assertIn("emperor-hermes install failed (exit 7)", out)

    def test_the_spec_file_is_deleted_as_soon_as_it_is_read(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            path = Path(tmp) / "job.spec"
            path.write_text(json.dumps(spec()), encoding="utf-8")
            self.assertEqual(provision.load_spec(path)["apiToken"], NEW_TOKEN)
            self.assertFalse(path.exists())


class ProvisionRunnerTests(unittest.TestCase):
    def test_the_runner_hands_the_token_over_in_a_private_spec_only(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            seen: dict[str, Any] = {}

            class SpecExecutor(InstantExecutor):
                def start(self, unit, argv, log_path, exit_path, keep_pythonpath=False):
                    spec_path = Path(argv[-1])
                    seen["argv"], seen["keep"] = list(argv), keep_pythonpath
                    seen["spec"] = json.loads(spec_path.read_text(encoding="utf-8"))
                    seen["mode"] = stat.S_IMODE(spec_path.stat().st_mode)
                    super().start(unit, argv, log_path, exit_path, keep_pythonpath)

            red = Redactor([HOST_TOKEN, NEW_TOKEN])
            runner = JobRunner(JobStore(home.paths.jobs_dir), SpecExecutor(home.paths, f"==> Online\nsaw {NEW_TOKEN}\n"), red)
            plan = commands.plan(home.paths, "provision_agent", spec())
            job = runner.start(JOB_A, plan, 1800)
            self.assertEqual(seen["argv"][-3:-1], ["-m", "emperor_hostd.provision"])
            self.assertTrue(seen["keep"], "only module jobs get PYTHONPATH")
            self.assertEqual(seen["spec"]["apiToken"], NEW_TOKEN)
            self.assertEqual(seen["spec"]["jobId"], JOB_A)
            if POSIX:
                self.assertEqual(seen["mode"], 0o600)
            stored = runner.store.path(JOB_A, "json").read_text(encoding="utf-8")
            self.assertNotIn(NEW_TOKEN, stored, "the job record never holds the token")
            _, result, *_ = runner.poll(job)
            self.assertTrue(result["ok"])
            self.assertEqual(result["tokenSha256"], hashlib.sha256(NEW_TOKEN.encode()).hexdigest())
            self.assertNotIn(NEW_TOKEN, encode(result, red))
            self.assertFalse(runner.store.path(JOB_A, "spec").exists(), "the spec does not outlive the job")

    def test_exit_codes_read_as_reasons(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            runner = JobRunner(JobStore(home.paths.jobs_dir), InstantExecutor(home.paths, "error: x\n", code=11), Redactor())
            job = runner.start(JOB_A, commands.plan(home.paths, "provision_agent", spec()), 1800)
            _, result, *_ = runner.poll(job)
            self.assertFalse(result["ok"])
            self.assertIn("no API key", result["summary"])
            self.assertNotIn("tokenSha256", result)


class ProvisionSessionTests(unittest.TestCase):
    def test_a_provision_command_over_the_socket_never_leaks_its_token(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                execu = InstantExecutor(home.paths, f"==> Writing\ntoken {NEW_TOKEN} key {DEEPSEEK}\n==> Online\n")
                t = FakeTransport([WELCOME, {"type": "command", "jobId": JOB_A, "command": "provision_agent", "args": spec(), "deadlineSec": 1800}])
                task = asyncio.create_task(HostSession(t, _ctx(home, execu)).run())
                await _settle(t, lambda: t.of("result") and len(t.of("inventory")) >= 2)
                t.incoming.put_nowait(HostClosed(1006))
                await task
                return t, execu

        t, execu = asyncio.run(scenario())
        self.assertEqual([a["accepted"] for a in t.of("ack")], [True])
        self.assertTrue(t.of("result")[0]["ok"])
        self.assertEqual(len(t.of("inventory")), 2, "a fresh inventory follows the setup")
        wire = json.dumps(t.sent)
        for secret in (NEW_TOKEN, DEEPSEEK, HOST_TOKEN):
            self.assertNotIn(secret, wire)
        self.assertIn("[redacted]", wire)
        self.assertNotIn(NEW_TOKEN, json.dumps(execu.started), "the token is not in the job's argv")

    def test_hello_advertises_the_commands_this_daemon_runs(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            hello = build_hello(FakeHome(tmp).paths, [], fingerprint="f" * 64)
            self.assertEqual(hello["commands"], ["provision_agent", "refresh_inventory", "remove_agent", "restart_agent"])


class HalfCreatedProfileTests(unittest.TestCase):
    """A setup that died between `hermes profile create` and writing the .env (review fix 1)."""

    def _half_created(self, home: FakeHome, env: str = "HERMES_TOOLSETS=web\n", agent: str = NEW_AGENT) -> None:
        commands.write_marker(home.paths, "growth-hacker", JOB_A, agent)
        write(home.paths.profile_home("growth-hacker") / ".env", env)

    def test_retry_reclaims_a_profile_our_marker_names(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            self._half_created(home)
            self.assertTrue(commands.plan(home.paths, "provision_agent", spec()).module)
            machine = FakeMachine(home)
            code, out = run_provision(home, machine, spec())
            self.assertEqual(code, 0, out)
            self.assertFalse(any(c[1:3] == ["profile", "create"] for c in machine.calls), "the half-made profile is reused")
            self.assertEqual(read_env_file(home.paths.profile_home("growth-hacker") / ".env")["EMPEROR_CLAW_AGENT_ID"], NEW_AGENT)

    def test_the_default_homes_cloned_identity_does_not_block_retry(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            legacy = "77777777-7777-4777-8777-777777777777"
            write(home.paths.hermes_root / ".env", f'DEEPSEEK_API_KEY="{DEEPSEEK}"\nEMPEROR_CLAW_AGENT_ID="{legacy}"\n')
            self._half_created(home, f'EMPEROR_CLAW_AGENT_ID="{legacy}"\nEMPEROR_CLAW_API_TOKEN="{AGENT_TOKEN}"\n')
            code, out = run_provision(home, FakeMachine(home), spec())
            self.assertEqual(code, 0, out)
            env_text = (home.paths.profile_home("growth-hacker") / ".env").read_text(encoding="utf-8")
            self.assertNotIn(legacy, env_text)
            self.assertNotIn(AGENT_TOKEN, env_text, "the default home's agent token never reaches the new profile")

    def test_delete_removes_a_half_created_profile(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            self._half_created(home)
            plan = commands.plan(home.paths, "remove_agent", {"profile": "growth-hacker", "agentId": NEW_AGENT, "purge": True})
            self.assertIsNone(plan.argv)
            self.assertEqual(plan.discard_profile, "growth-hacker")
            self.assertEqual(commands.discard_profile(home.paths, "growth-hacker"), "deleted")
            self.assertFalse(home.paths.profile_home("growth-hacker").exists())
            self.assertIsNone(commands.read_marker(home.paths, "growth-hacker"))

    def test_a_foreign_profile_without_our_marker_is_still_refused(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            write(home.paths.profile_home("growth-hacker") / ".env", "HERMES_TOOLSETS=web\n")
            with self.assertRaises(CommandRefused):
                commands.plan(home.paths, "provision_agent", spec())
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "remove_agent", {"profile": "growth-hacker", "agentId": NEW_AGENT, "purge": True})
            self.assertEqual(ctx.exception.code, "agent_mismatch")
            # Our marker for ANOTHER agent does not make it this agent's either.
            commands.write_marker(home.paths, "growth-hacker", JOB_A, AGENT)
            with self.assertRaises(CommandRefused):
                commands.plan(home.paths, "provision_agent", spec())
            self.assertTrue(home.paths.profile_home("growth-hacker").exists())

    def test_a_create_that_fails_after_making_the_dir_is_finished_by_retry(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            code, out = run_provision(home, FakeMachine(home, create_code=1), spec())
            self.assertEqual(code, provision.EXIT_HERMES, out)
            self.assertIsNotNone(commands.read_marker(home.paths, "growth-hacker"), "the marker stays: the profile is ours")
            env_text = (home.paths.profile_home("growth-hacker") / ".env").read_text(encoding="utf-8")
            self.assertNotIn(DEEPSEEK, env_text, "the cloned .env was stripped at once")
            self.assertNotIn("evil.example.com", env_text)
            code, out = run_provision(home, FakeMachine(home), spec(apiToken=OTHER_TOKEN))
            self.assertEqual(code, 0, out)


class ReviewHardeningTests(unittest.TestCase):
    def test_line_breaking_characters_in_the_name_are_refused(self):
        for bad in ("Growth\u2028EMPEROR_CLAW_API_URL=x", "a\x0bb", "a\x0cb", "a\x1cb", "a\x1eb", "a\x85b", "a\u2029b", "a\x00b", "a\x7fb", " lead"):
            with self.assertRaises(CommandRefused, msg=repr(bad)):
                commands.validate("provision_agent", spec(agentName=bad))
        with self.assertRaises(provision.ProvisionError):
            provision.env_value("x\u2028EMPEROR_CLAW_API_URL=evil")

    def test_models_never_start_with_a_dash(self):
        for bad in ("-x", "--help", ".hidden", "/abs"):
            with self.assertRaises(CommandRefused, msg=bad):
                commands.validate("provision_agent", spec(model=bad))
        commands.validate("provision_agent", spec(model="nvidia/nemotron-3-ultra-550b-a55b:free"))

    def test_multi_line_values_are_dropped_with_their_key(self):
        existing = 'OPENAI_API_KEY="first\nsecond-line-secret"\nKEEP=1\nEMPEROR_CLAW_EXTRA=\'a\nb\'\nOTHER=2\n'
        out = provision.compose_env(existing, "https://e.example.com", NEW_TOKEN, NEW_AGENT, "Scout", "DEEPSEEK_API_KEY", DEEPSEEK)
        self.assertNotIn("second-line-secret", out)
        self.assertNotIn("EMPEROR_CLAW_EXTRA", out)
        self.assertNotIn("\nb'", out)
        env = {}
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            env = read_env_file(write(Path(tmp) / ".env", out))
        self.assertEqual((env["KEEP"], env["OTHER"], env["EMPEROR_CLAW_AGENT_NAME"]), ("1", "2", "Scout"))

    def test_a_cloned_endpoint_and_key_are_removed_and_a_stuck_one_fails_closed(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            machine = FakeMachine(home, clone_config={"model.base_url": "https://evil.example.com/v1", "model.api_key": "sk-cloned-0000000"})
            code, out = run_provision(home, machine, spec())
            self.assertEqual(code, 0, out)
            self.assertEqual(machine.config["growth-hacker"].get("model.base_url"), None)
            self.assertEqual(machine.config["growth-hacker"].get("model.api_key"), None)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            machine = FakeMachine(home, clone_config={"model.base_url": "https://evil.example.com/v1"}, unset_works=False)
            code, out = run_provision(home, machine, spec())
            self.assertEqual(code, provision.EXIT_HERMES)
            self.assertIn("could not be removed", out)
            self.assertFalse(any(c[:1] == ["/bin/bash"] for c in machine.calls), "nothing installed with a foreign endpoint")

    def test_a_slow_registration_stops_the_standalone_units(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            machine = FakeMachine(home, register=False)
            code, out = run_provision(home, machine, spec(), register_timeout=300)
            self.assertEqual(code, provision.EXIT_NOT_REGISTERED)
            self.assertIn(["systemctl", "--user", "disable", "--now", "emperor-hermes-bridge@growth-hacker.service",
                           "emperor-hermes-gateway@growth-hacker.service"], machine.calls)
            self.assertIn("within 300 s", out)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            machine = FakeMachine(home, register=False)
            code, _ = run_provision(home, machine, spec(gateway="shared"))
            self.assertEqual(code, provision.EXIT_NOT_REGISTERED)
            self.assertFalse(any(c[:2] == ["systemctl", "--user"] for c in machine.calls), "a shared gateway serves others: left alone")

    def test_slow_hosts_wait_longer(self):
        from unittest import mock
        with mock.patch.object(provision.platform, "machine", return_value="aarch64"):
            self.assertEqual(provision.register_timeout_for_this_host(), 300)
        with mock.patch.object(provision.platform, "machine", return_value="x86_64"), \
                mock.patch.object(provision, "meminfo", return_value={"MemTotal": 32000}):
            self.assertEqual(provision.register_timeout_for_this_host(), 120)
        with mock.patch.object(provision.platform, "machine", return_value="x86_64"), \
                mock.patch.object(provision, "meminfo", return_value={"MemTotal": 4000}):
            self.assertEqual(provision.register_timeout_for_this_host(), 300)


class RemoveTests(unittest.TestCase):
    def test_remove_runs_only_for_the_agent_the_profile_names(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "remove_agent", {"profile": "viktor", "agentId": NEW_AGENT, "purge": True})
            self.assertEqual(ctx.exception.code, "agent_mismatch")
            # qa's .env names no agent: never removed on Emperor's word.
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "remove_agent", {"profile": "qa", "agentId": NEW_AGENT})
            self.assertEqual(ctx.exception.code, "agent_mismatch")
            plan = commands.plan(home.paths, "remove_agent", {"profile": "viktor", "agentId": AGENT.upper(), "purge": True})
            self.assertEqual(plan.argv[2:], ["remove", "--profile", "viktor", "--yes", "--non-interactive", "--purge"])
            self.assertTrue(plan.argv[1].endswith("emperor-hermes"))

    def test_nothing_left_to_remove_is_a_success(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            plan = commands.plan(home.paths, "remove_agent", {"profile": "gone", "agentId": NEW_AGENT, "purge": True})
            self.assertIsNone(plan.argv)
            self.assertIn("nothing to remove", plan.summary)
            write(home.paths.records_dir / "old.env", 'status="removed"\n')
            self.assertIsNone(commands.plan(home.paths, "remove_agent", {"profile": "old", "agentId": NEW_AGENT}).argv)

    def test_a_profile_not_managed_by_emperor_hermes_is_not_removed(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            write(home.paths.profile_home("manual") / ".env", f'EMPEROR_CLAW_AGENT_ID="{NEW_AGENT}"\n')
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "remove_agent", {"profile": "manual", "agentId": NEW_AGENT})
            self.assertEqual(ctx.exception.code, "unknown_profile")


if __name__ == "__main__":
    unittest.main()
