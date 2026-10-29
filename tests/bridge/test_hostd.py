"""emperor_hostd (runtime host daemon, 0.21): validators, redaction, runner, backoff, close codes."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any, Optional

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_hostd import commands  # noqa: E402
from emperor_hostd.commands import CommandRefused, Plan  # noqa: E402
from emperor_hostd.config import HostdConfig, HostdConfigError, HostPaths, load_hostd_config, url_origin  # noqa: E402
from emperor_hostd.connection import (DaemonContext, HandshakeRefused, HostClosed, HostSession, backoff_delay,  # noqa: E402
                                      run_daemon, slow_backoff_delay)
from emperor_hostd.inventory import build_hello, build_inventory  # noqa: E402
from emperor_hostd.protocol import EXIT_REVOKED, Redactor, encode  # noqa: E402
from emperor_hostd.runner import JobRunner, JobStore, SystemdExecutor, unit_name  # noqa: E402

JOB_A = "11111111-1111-4111-8111-111111111111"
JOB_B = "22222222-2222-4222-8222-222222222222"
AGENT = "33333333-3333-4333-8333-333333333333"
HOST_TOKEN = "ech_" + "c" * 64
AGENT_TOKEN = "ec_" + "d" * 48
DEEPSEEK = "sk-fake-deepseek-0123456789"
ANTHROPIC = "plain-anthropic-secret-99"
OPENAI = "sk-proj-fake-openai-abcdef"


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:  # LF on Windows too (byte offsets matter)
        fh.write(text)
    return path


class FakeHome:
    """A home with emperor-hermes records, profiles with secrets, and a hostd.env."""

    def __init__(self, tmp: str) -> None:
        self.paths = HostPaths(home=Path(tmp))
        p = self.paths
        write(p.hermes_root / ".env", f'DEEPSEEK_API_KEY="{DEEPSEEK}"\nFIRECRAWL_API_KEY=fc-tool-key-123\nEMPTY_API_KEY=\n')
        for name, topo in (("viktor", "standalone"), ("qa", "shared")):
            write(p.records_dir / f"{name}.env", f'status="active"\ntopology="{topo}"\n')
        write(p.profile_home("viktor") / ".env", textwrap.dedent(f"""\
            EMPEROR_CLAW_API_URL="https://Emperor.Example.com/"
            EMPEROR_CLAW_API_TOKEN="{AGENT_TOKEN}"
            EMPEROR_CLAW_AGENT_ID="{AGENT.upper()}"
            ANTHROPIC_API_KEY={ANTHROPIC}
            """))
        write(p.profile_home("qa") / ".env", f'EMPEROR_CLAW_API_URL="https://other.example.com"\nOPENAI_API_KEY="{OPENAI}"\n')
        write(p.profile_home("viktor") / "emperor" / "health.json", json.dumps({
            "bridgeVersion": "0.21.0", "registered": False,
            "lastError": f"401 from provider with key {ANTHROPIC} and token {AGENT_TOKEN} DEEPSEEK_API_KEY={DEEPSEEK}"}))
        # A 0.3 profile still on its own unit: reported as legacy, never acted on.
        write(p.unit_dir / "emperor-hermes-bridge-growth.service", "[Service]\nEnvironment=HERMES_PROFILE=growth\n")
        write(p.home / ".local" / "bin" / "emperor-hermes", 'readonly EMPEROR_HERMES_VERSION="0.21.0"\nreadonly HERMES_REF="v0.22.4"\n')
        write(p.bridge_current / "VERSION", "0.21.0\n")
        write(p.hostd_env, f'EMPEROR_URL="https://emperor.example.com"\nHOST_ID="{JOB_B}"\nHOST_TOKEN="{HOST_TOKEN}"\n')


def fake_systemctl(argv):
    import subprocess
    out = "\n".join("active" for _ in argv[3:]) if argv[:3] == ["systemctl", "--user", "is-active"] else ""
    return subprocess.CompletedProcess(list(argv), 0, out, "")


class ValidatorTests(unittest.TestCase):
    def test_injection_and_traversal_are_refused(self):
        for bad in ("a;rm", "../etc", "a b", "", "-rf", "$(id)", "x" * 65, "a\nb", "a`id`", "a|b", "/abs"):
            with self.assertRaises(CommandRefused, msg=repr(bad)):
                commands.validate("restart_agent", {"profile": bad})

    def test_url_override_and_unknown_arguments_are_refused(self):
        for extra in ({"url": "https://evil.example"}, {"apiUrl": "https://evil.example"}, {"argv": ["sh", "-c", "id"]}, {"env": {"X": "1"}}):
            with self.assertRaises(CommandRefused):
                commands.validate("restart_agent", {"profile": "viktor", **extra})
        with self.assertRaises(CommandRefused):
            commands.validate("provision_agent", {"profile": "p", "agentId": AGENT, "agentName": "A", "apiToken": AGENT_TOKEN,
                                                  "gateway": "standalone", "llmProvider": "deepseek", "apiUrl": "https://evil.example"})

    def test_bad_tokens_and_names_are_refused(self):
        base = {"profile": "p", "agentId": AGENT, "agentName": "Viktor", "apiToken": AGENT_TOKEN, "gateway": "standalone", "llmProvider": "deepseek"}
        commands.validate("provision_agent", base)
        for patch in ({"apiToken": "ec_short"}, {"apiToken": HOST_TOKEN}, {"agentName": 'x"; rm -rf ~'}, {"agentName": "$HOME"},
                      {"agentId": "not-a-uuid"}, {"maxParallel": 99}, {"model": "a b"}):
            with self.assertRaises(CommandRefused, msg=repr(patch)):
                commands.validate("provision_agent", {**base, **patch})
        with self.assertRaises(CommandRefused):
            commands.validate("update_runtime", {"version": "0.22.0;curl evil"})

    def test_only_allowlisted_commands_run_and_only_managed_profiles(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            for command in ("provision_agent", "update_runtime", "remove_agent", "rotate_agent_token", "disconnect"):
                with self.assertRaises(CommandRefused) as ctx:
                    commands.plan(home.paths, command, {})
                self.assertIn(ctx.exception.code, ("unsupported_command", "invalid_args"))
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "restart_agent", {"profile": "growth"})
            self.assertEqual(ctx.exception.code, "unknown_profile")
            with self.assertRaises(CommandRefused):
                commands.plan(home.paths, "shell", {"cmd": "id"})

    def test_restart_argv_is_a_list_built_from_the_local_record(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            write(home.paths.host_env, 'EMPEROR_HERMES_PROFILES="qa,courier"\n')
            p = commands.plan(home.paths, "restart_agent", {"profile": "viktor"})
            self.assertEqual(p.argv, ["systemctl", "--user", "restart", "emperor-hermes-bridge@viktor.service"])
            self.assertEqual(p.units, ("emperor-hermes-bridge@viktor.service",))
            # Emperor says nothing about topology; the local record says shared: the shared bridge restarts.
            p = commands.plan(home.paths, "restart_agent", {"profile": "qa"})
            self.assertEqual(p.argv, ["systemctl", "--user", "restart", "emperor-hermes-bridge-shared.service"])
            self.assertEqual(p.units, ("emperor-hermes-bridge-shared.service",))
            self.assertIn("all agents: qa, courier", p.summary)
            p = commands.plan(home.paths, "restart_agent", {"profile": "viktor", "target": "gateway"})
            self.assertEqual(p.argv[2:], ["restart-gateway", "--profile", "viktor"])
            self.assertTrue(all(isinstance(a, str) for a in p.argv))

    def test_a_shared_gateway_restart_always_waits_for_idle_unless_forced(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            # Stale or missing topology from Emperor never matters: the record says shared.
            for raw in ({"profile": "qa", "target": "gateway"}, {"profile": "qa", "target": "gateway", "force": False}):
                p = commands.plan(home.paths, "restart_agent", raw)
                self.assertEqual(p.argv[2:], ["restart-gateway", "--shared", "--when-idle", "--timeout", "240"])
                self.assertEqual(p.units, ("emperor-hermes-gateway-shared.service",))
            p = commands.plan(home.paths, "restart_agent", {"profile": "qa", "target": "gateway", "force": True})
            self.assertEqual(p.argv[2:], ["restart-gateway", "--shared"])
            # The old fields (a server claiming standalone, or whenIdle false) are refused outright.
            for raw in ({"profile": "qa", "target": "gateway", "topology": "standalone"}, {"profile": "qa", "target": "gateway", "whenIdle": False}):
                with self.assertRaises(CommandRefused):
                    commands.plan(home.paths, "restart_agent", raw)
            with self.assertRaises(CommandRefused):
                commands.plan(home.paths, "restart_agent", {"profile": "qa", "target": "gateway", "force": "yes"})
            # A profile without a recorded topology is refused rather than guessed.
            write(home.paths.records_dir / "odd.env", 'status="active"\n')
            with self.assertRaises(CommandRefused) as ctx:
                commands.plan(home.paths, "restart_agent", {"profile": "odd"})
            self.assertEqual(ctx.exception.code, "unknown_topology")


class ConfigTests(unittest.TestCase):
    def test_hostd_env(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            cfg = load_hostd_config(home.paths.hostd_env)
            self.assertEqual(cfg.socket_url, "wss://emperor.example.com/api/hosts/ws")
            write(home.paths.hostd_env, 'EMPEROR_URL="ftp://x"\nHOST_ID="x"\nHOST_TOKEN="y"\n')
            with self.assertRaises(HostdConfigError):
                load_hostd_config(home.paths.hostd_env)
            with self.assertRaises(HostdConfigError):
                load_hostd_config(home.paths.config_dir / "missing.env")

    def test_plain_http_only_to_private_addresses_unless_insecure(self):
        from emperor_hostd.config import url_allowed
        for ok in ("https://emperor.example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://10.0.0.5",
                   "http://172.16.4.2:3000", "http://192.168.0.100:3000", "http://[::1]:3000"):
            self.assertTrue(url_allowed(ok), ok)
        for bad in ("http://emperor.example.com", "http://10.evil.com", "http://172.32.0.1", "http://192.168.0.1.nip.io",
                    "http://localhost.evil.com", "http://8.8.8.8"):
            self.assertFalse(url_allowed(bad), bad)
        self.assertTrue(url_allowed("http://emperor.example.com", insecure=True))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            path = write(Path(tmp) / "hostd.env", f'EMPEROR_URL="http://10.evil.com"\nHOST_ID="{JOB_B}"\nHOST_TOKEN="{HOST_TOKEN}"\n')
            with self.assertRaises(HostdConfigError):
                load_hostd_config(path)
            write(path, f'EMPEROR_URL="http://10.evil.com"\nHOST_ID="{JOB_B}"\nHOST_TOKEN="{HOST_TOKEN}"\nINSECURE="1"\n')
            self.assertEqual(load_hostd_config(path).socket_url, "ws://10.evil.com/api/hosts/ws")

    def test_origin(self):
        self.assertEqual(url_origin("https://Emperor.Example.com:443/x"), "https://emperor.example.com")
        self.assertEqual(url_origin("http://10.0.0.5:3000"), "http://10.0.0.5:3000")
        self.assertIsNone(url_origin("javascript:alert(1)"))


class InventoryAndSecretsTests(unittest.TestCase):
    def test_inventory_reports_names_agents_and_legacy(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            red = Redactor([HOST_TOKEN])
            inv = build_inventory(home.paths, "https://emperor.example.com", red, run=fake_systemctl)
            self.assertEqual(inv["llmProviders"], ["anthropic", "deepseek", "openai"])
            by = {p["profile"]: p for p in inv["profiles"]}
            self.assertEqual(by["viktor"]["agentId"], AGENT)
            self.assertTrue(by["viktor"]["sameEmperor"])
            self.assertFalse(by["qa"]["sameEmperor"])
            self.assertEqual(by["qa"]["topology"], "shared")
            self.assertTrue(by["growth"]["legacy"])
            self.assertEqual(by["viktor"]["gateway"], "active")

    def test_no_secret_value_in_any_frame(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            red = Redactor([HOST_TOKEN])
            frames = [build_hello(home.paths, [], fingerprint="f" * 64),
                      build_inventory(home.paths, "https://emperor.example.com", red, run=fake_systemctl)]
            store = JobStore(home.paths.jobs_dir)
            runner = JobRunner(store, InstantExecutor(home.paths, f"==> Restarting\nkey={ANTHROPIC}\n{OPENAI}\nBearer {HOST_TOKEN}\n"), red)
            job = runner.start(JOB_A, Plan("restart_agent", {"profile": "viktor"}, ["true"], "restart bridge of viktor"), 300)
            progress, result, *_ = runner.poll(job)
            frames += progress + [result]
            text = "\n".join(encode(f, red) for f in frames)
            for secret in (DEEPSEEK, ANTHROPIC, OPENAI, AGENT_TOKEN, HOST_TOKEN, "fc-tool-key-123"):
                self.assertNotIn(secret, text, f"{secret[:8]}... leaked")
            self.assertIn("[redacted]", text)
            self.assertIn('"step":"Restarting"', text)


class InstantExecutor(SystemdExecutor):
    """Runs nothing: writes the log and the exit code at once (a job that already finished)."""

    def __init__(self, paths: HostPaths, log: str = "", code: int = 0) -> None:
        super().__init__(paths, {})
        self.log, self.code, self.started = log, code, []
        self.active = False

    def start(self, unit, argv, log_path, exit_path, keep_pythonpath=False):
        self.started.append((unit, list(argv)))
        Path(log_path).write_text(self.log, encoding="utf-8")
        if not self.active:
            Path(exit_path).write_text(f"{self.code}\n", encoding="utf-8")

    def is_active(self, unit):
        return self.active

    def stop(self, unit):
        self.active = False


FAKE_SYSTEMD_RUN = r'''
import os, subprocess, sys
args = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as f:
    f.write(" ".join(args[:4]) + "\n")
env = dict(os.environ)
log = None
for a in args:
    if a.startswith("--property=StandardOutput=append:"):
        log = a.split("append:", 1)[1]
    if a.startswith("--setenv="):
        k, _, v = a[len("--setenv="):].partition("=")
        env[k] = v
cmd = args[args.index("--") + 1:]
with open(log, "ab") as out:
    sys.exit(subprocess.call(cmd, stdout=out, stderr=out, env=env))
'''


class RunnerTests(unittest.TestCase):
    def _runner(self, tmp: str):
        home = FakeHome(tmp)
        fake = write(Path(tmp) / "fake_systemd_run.py", FAKE_SYSTEMD_RUN)
        calls = Path(tmp) / "calls.log"
        os.environ["FAKE_CALLS"] = str(calls)
        env = dict(os.environ)
        execu = SystemdExecutor(home.paths, env, systemd_run=[sys.executable, str(fake)],
                                systemctl=[sys.executable, "-c", "print('inactive')"], python=sys.executable, pythonpath=str(BRIDGE_DIR))
        return home, JobRunner(JobStore(home.paths.jobs_dir), execu, Redactor([HOST_TOKEN])), calls

    def test_fake_systemd_run_runs_argv_through_jobwrap(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home, runner, calls = self._runner(tmp)
            argv = [sys.executable, "-c", "print('==> Restarting viktor'); print('ok')"]
            job = runner.start(JOB_A, Plan("restart_agent", {"profile": "viktor"}, argv, "restart bridge of viktor"), 300)
            self.assertEqual(job["unit"], unit_name(JOB_A))
            frames, result, *_ = runner.poll(job)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["exitCode"], 0)
            self.assertEqual([f["seq"] for f in frames], [1, 2])
            self.assertEqual(frames[0]["step"], "Restarting viktor")
            self.assertIn("--user --unit " + unit_name(JOB_A), calls.read_text())
            self.assertEqual(runner.store.load(JOB_A)["state"], "done")

    def test_a_failing_job_reports_its_exit_code(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home, runner, _ = self._runner(tmp)
            job = runner.start(JOB_A, Plan("restart_agent", {}, [sys.executable, "-c", "import sys; print('boom'); sys.exit(3)"], "x"), 300)
            _, result, *_ = runner.poll(job)
            self.assertFalse(result["ok"])
            self.assertEqual((result["exitCode"], result["errorCode"]), (3, "exit_3"))
            self.assertIn("boom", result["logTail"])

    def test_reattach_after_a_daemon_restart(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir)
            store.save({"jobId": JOB_A, "command": "restart_agent", "args": {}, "summary": "restart", "unit": unit_name(JOB_A),
                        "state": "running", "startedAt": 1e12, "deadlineSec": 300, "lastSeq": 1, "logOffset": len(b"==> one\n")})
            write(store.path(JOB_A, "log"), "==> one\n==> two\n")
            # Still running (unit active, no exit file): new lines only, no result.
            execu = InstantExecutor(home.paths)
            execu.active = True
            runner = JobRunner(store, execu, Redactor(), now=lambda: 1e12 + 5)
            self.assertEqual([j["jobId"] for j in store.reportable()], [JOB_A])
            frames, result, *_ = runner.poll(store.load(JOB_A))
            self.assertIsNone(result)
            self.assertEqual([(f["seq"], f.get("step")) for f in frames], [(2, "two")])
            # It ended while the daemon was down: the .exit file tells how.
            write(store.path(JOB_A, "exit"), "0\n")
            _, result, *_ = runner.poll(store.load(JOB_A))
            self.assertTrue(result["ok"])
            self.assertEqual(execu.started, [], "re-attaching never starts the job again")

    def test_a_job_whose_unit_vanished_is_lost_and_a_slow_one_times_out(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir)
            store.save({"jobId": JOB_A, "command": "restart_agent", "args": {}, "unit": unit_name(JOB_A), "state": "running",
                        "startedAt": 1000.0, "deadlineSec": 300, "lastSeq": 0, "logOffset": 0})
            runner = JobRunner(store, InstantExecutor(home.paths), Redactor(), now=lambda: 1010.0)
            result = None
            for _ in range(3):
                _, result, *_ = runner.poll(store.load(JOB_A))
            self.assertEqual(result["errorCode"], "lost")
            store.save({"jobId": JOB_B, "command": "restart_agent", "args": {}, "unit": unit_name(JOB_B), "state": "running",
                        "startedAt": 1000.0, "deadlineSec": 300, "lastSeq": 0, "logOffset": 0})
            execu = InstantExecutor(home.paths)
            execu.active = True
            runner = JobRunner(store, execu, Redactor(), now=lambda: 1000.0 + 400)
            _, result, *_ = runner.poll(store.load(JOB_B))
            self.assertEqual(result["errorCode"], "timeout")


class RunnerSafetyTests(unittest.TestCase):
    def _job(self, store, **extra):
        job = {"jobId": JOB_A, "command": "restart_agent", "args": {}, "summary": "restart gateway of viktor",
               "unit": unit_name(JOB_A), "state": "running", "startedAt": 1e12, "deadlineSec": 420, "lastSeq": 0, "logOffset": 0,
               "recent": [], **extra}
        store.save(job)
        return job

    def test_the_read_position_moves_only_after_a_commit(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir)
            self._job(store)
            write(store.path(JOB_A, "log"), "==> one\ntwo\n")
            execu = InstantExecutor(home.paths)
            execu.active = True
            runner = JobRunner(store, execu, Redactor(), now=lambda: 1e12 + 1)
            frames, _, offset, seq = runner.poll(store.load(JOB_A))
            again, *_ = runner.poll(store.load(JOB_A))
            self.assertEqual([f["seq"] for f in again], [1, 2], "frames that were not sent are read again")
            runner.commit(store.load(JOB_A), offset, seq, frames)
            after, *_ = runner.poll(store.load(JOB_A))
            self.assertEqual(after, [])
            self.assertEqual([f["seq"] for f in runner.recent_lines(store.load(JOB_A))], [1, 2], "kept for a resend after a reconnect")

    def test_a_gateway_that_restarted_but_was_slow_to_get_ready_is_a_success_with_a_note(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir)
            self._job(store)
            write(store.path(JOB_A, "log"), "==> Restarted emperor-hermes-gateway@viktor.service\nerror: viktor: gateway not ready after 120s\n")
            write(store.path(JOB_A, "exit"), "1\n")
            _, result, *_ = JobRunner(store, InstantExecutor(home.paths), Redactor(), now=lambda: 1e12 + 1).poll(store.load(JOB_A))
            self.assertTrue(result["ok"])
            self.assertIn("not ready in time", result["summary"])
            # Without the "Restarted" step (the idle wait ran out) it is a failure.
            self._job(store)
            write(store.path(JOB_A, "log"), "error: still busy after 240s; not restarting\n")
            _, result, *_ = JobRunner(store, InstantExecutor(home.paths), Redactor(), now=lambda: 1e12 + 1).poll(store.load(JOB_A))
            self.assertFalse(result["ok"])

    @unittest.skipUnless(os.name == "posix", "file modes")
    def test_job_files_are_private(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir)
            runner = JobRunner(store, InstantExecutor(home.paths), Redactor())
            runner.start(JOB_A, Plan("restart_agent", {}, ["true"], "x"), 300)
            self.assertEqual(home.paths.jobs_dir.stat().st_mode & 0o777, 0o700)
            for ext in ("json", "log"):
                self.assertEqual(store.path(JOB_A, ext).stat().st_mode & 0o777, 0o600, ext)


class BoundsTests(unittest.TestCase):
    def test_a_poll_reads_at_most_50_lines_and_the_rest_waits(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir)
            store.save({"jobId": JOB_A, "command": "restart_agent", "args": {}, "unit": unit_name(JOB_A), "state": "running",
                        "startedAt": 1e12, "deadlineSec": 420, "lastSeq": 0, "logOffset": 0, "recent": []})
            write(store.path(JOB_A, "log"), "".join(f"line {i}\n" for i in range(1, 131)))
            execu = InstantExecutor(home.paths)
            execu.active = True
            runner = JobRunner(store, execu, Redactor(), now=lambda: 1e12 + 1)
            seen = []
            for _ in range(3):
                frames, _, offset, seq = runner.poll(store.load(JOB_A))
                self.assertLessEqual(len(frames), 50)
                runner.commit(store.load(JOB_A), offset, seq, frames)
                seen += [f["seq"] for f in frames]
            self.assertEqual(seen, list(range(1, 131)), "nothing lost, nothing repeated across capped polls")

    def test_hello_lists_at_most_200_jobs_newest_first_and_a_reported_corrupt_job_drops_out(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir, now=lambda: 1_000_000.0)
            for i in range(250):
                store.save({"jobId": f"00000000-0000-4000-8000-{i:012d}", "state": "done", "finishedAt": 999_000.0 + i})
            jobs = store.reportable()
            self.assertEqual(len(jobs), 200)
            self.assertEqual(jobs[0]["jobId"], "00000000-0000-4000-8000-000000000249", "newest first")
            store.ensure_dir()
            write(store.path(JOB_A, "json"), "{broken")
            self.assertIn(JOB_A, [j["jobId"] for j in store.reportable()])
            store.retire_corrupt(JOB_A)
            self.assertNotIn(JOB_A, [j["jobId"] for j in store.reportable()], "no longer listed once reported")
            self.assertEqual(store.load(JOB_A)["state"], "corrupt", "but the tombstone still stops a rerun")

    def test_a_result_frame_always_fits_and_has_no_terminal_escapes(self):
        from emperor_hostd.protocol import result as result_frame
        nasty = ("\x1b[31mred\x1b[0m \u00e9\"quote\"\\ \x07bell\n" * 3000)
        frame = result_frame(JOB_A, False, 1, "x" * 2000, nasty)
        text = encode(frame, Redactor())
        self.assertLess(len(text.encode("utf-8")), 16 * 1024)
        self.assertNotIn("\x1b", frame["logTail"])
        self.assertNotIn("\x07", frame["logTail"])
        self.assertTrue(frame["logTail"].endswith("bell\n"), "the END of the log is kept")

    def test_an_invalid_port_is_a_clean_config_error(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            for url in ("https://emperor.example.com:99999", "https://emperor.example.com:abc"):
                path = write(Path(tmp) / "hostd.env", f'EMPEROR_URL="{url}"\nHOST_ID="{JOB_B}"\nHOST_TOKEN="{HOST_TOKEN}"\n')
                with self.assertRaises(HostdConfigError, msg=url):
                    load_hostd_config(path)
        self.assertIsNone(url_origin("https://x.example:70000"))
        self.assertEqual(url_origin("http://[::1]:3000"), "http://[::1]:3000")


class BackoffTests(unittest.TestCase):
    def test_backoff_grows_caps_and_jitters(self):
        self.assertEqual(backoff_delay(0, rng=lambda: 0.0), 1.0)
        self.assertEqual(backoff_delay(0, rng=lambda: 1.0), 1.0)
        self.assertEqual(backoff_delay(3, rng=lambda: 1.0), 8.0)
        self.assertEqual(backoff_delay(3, rng=lambda: 0.0), 4.0)
        self.assertEqual(backoff_delay(20, rng=lambda: 1.0), 60.0)
        self.assertEqual(backoff_delay(20, rng=lambda: 0.0), 30.0)
        for attempt in range(30):
            self.assertTrue(1.0 <= backoff_delay(attempt) <= 60.0)


class FakeTransport:
    """Server frames come from a queue; a HostClosed in the queue closes the socket."""

    def __init__(self, frames: list[Any]) -> None:
        self.incoming: asyncio.Queue = asyncio.Queue()
        for f in frames:
            self.incoming.put_nowait(f)
        self.sent: list[dict[str, Any]] = []
        self.closed: Optional[int] = None

    async def send(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def recv(self) -> str:
        item = await self.incoming.get()
        if isinstance(item, Exception):
            raise item
        return json.dumps(item)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = code

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [f for f in self.sent if f.get("type") == kind]


WELCOME = {"type": "welcome", "hostId": JOB_B, "protocol": 1, "heartbeatSec": 30, "inventorySec": 300}


def _ctx(home: FakeHome, executor: SystemdExecutor) -> DaemonContext:
    cfg = HostdConfig("https://emperor.example.com", JOB_B, HOST_TOKEN)
    red = Redactor([HOST_TOKEN])
    return DaemonContext(paths=home.paths, config=cfg, runner=JobRunner(JobStore(home.paths.jobs_dir), executor, red), redactor=red,
                         hello=lambda jobs: {**build_hello(home.paths, jobs, fingerprint="f" * 64)},
                         inventory=lambda: build_inventory(home.paths, cfg.origin, red, run=fake_systemctl), poll_interval=0.01)


async def _settle(transport: FakeTransport, predicate, timeout: float = 3.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not predicate() and loop.time() < end:
        await asyncio.sleep(0.01)


class SessionTests(unittest.TestCase):
    def test_restart_job_end_to_end_with_busy_duplicate_and_refusals(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                execu = InstantExecutor(home.paths, "==> Restarting\nok\n")
                ctx = _ctx(home, execu)
                t = FakeTransport([WELCOME, {"type": "command", "jobId": JOB_A, "command": "restart_agent",
                                             "args": {"profile": "viktor", "target": "bridge"}, "deadlineSec": 300}])
                task = asyncio.create_task(HostSession(t, ctx).run())
                await _settle(t, lambda: t.of("result"))
                # The same jobId again (a resend after a reconnect): replayed, never run twice.
                t.incoming.put_nowait({"type": "command", "jobId": JOB_A, "command": "restart_agent", "args": {"profile": "viktor"}})
                t.incoming.put_nowait({"type": "command", "jobId": JOB_B, "command": "update_runtime", "args": {"version": "0.23.0"}})
                t.incoming.put_nowait({"type": "command", "jobId": "44444444-4444-4444-8444-444444444444", "command": "restart_agent",
                                       "args": {"profile": "a;rm -rf ~"}})
                await _settle(t, lambda: len(t.of("ack")) >= 4 and len(t.of("result")) >= 2)
                t.incoming.put_nowait(HostClosed(1006))
                code = await task
                return t, execu, code

        t, execu, code = asyncio.run(scenario())
        self.assertEqual(code, 1006)
        self.assertEqual(t.sent[0]["type"], "hello")
        self.assertEqual(t.sent[1]["type"], "inventory")
        acks = t.of("ack")
        self.assertEqual([(a["jobId"][:4], a["accepted"]) for a in acks], [("1111", True), ("1111", True), ("2222", False), ("4444", False)])
        self.assertIn("unsupported_command", acks[2]["reason"])
        self.assertIn("invalid_args", acks[3]["reason"])
        results = t.of("result")
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], results[1], "the replayed result is the stored one")
        self.assertEqual(len(execu.started), 1, "a known jobId never runs twice")
        self.assertEqual([p["seq"] for p in t.of("progress")], [1, 2])

    def test_a_second_job_while_one_runs_is_busy(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                execu = InstantExecutor(home.paths, "==> slow\n")
                execu.active = True  # never finishes during the test
                t = FakeTransport([WELCOME,
                                   {"type": "command", "jobId": JOB_A, "command": "restart_agent", "args": {"profile": "viktor"}},
                                   {"type": "command", "jobId": JOB_B, "command": "restart_agent", "args": {"profile": "qa"}}])
                task = asyncio.create_task(HostSession(t, _ctx(home, execu)).run())
                await _settle(t, lambda: len(t.of("ack")) >= 2)
                t.incoming.put_nowait(HostClosed(1006))
                await task
                return t

        t = asyncio.run(scenario())
        self.assertEqual([(a["accepted"], a.get("reason")) for a in t.of("ack")], [(True, None), (False, "busy")])

    def test_refresh_inventory_runs_and_disconnect_is_refused(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                t = FakeTransport([WELCOME, {"type": "command", "jobId": JOB_A, "command": "refresh_inventory", "args": {}},
                                   {"type": "command", "jobId": JOB_B, "command": "disconnect", "args": {}}])
                task = asyncio.create_task(HostSession(t, _ctx(home, InstantExecutor(home.paths))).run())
                await _settle(t, lambda: len(t.of("ack")) >= 2)
                t.incoming.put_nowait(HostClosed(1006))
                return t, await task

        t, code = asyncio.run(scenario())
        self.assertEqual(code, 1006, "the daemon keeps running")
        self.assertEqual(len(t.of("inventory")), 2)
        self.assertEqual([(a["accepted"], (a.get("reason") or "")[:19]) for a in t.of("ack")], [(True, ""), (False, "unsupported_command")])
        self.assertEqual([r["ok"] for r in t.of("result")], [True])

    def test_a_corrupt_job_file_is_reported_failed_and_never_run(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                execu = InstantExecutor(home.paths)
                ctx = _ctx(home, execu)
                ctx.runner.store.ensure_dir()
                write(ctx.runner.store.path(JOB_A, "json"), "{not json")
                states = [j["state"] for j in ctx.runner.store.reportable()]
                t = FakeTransport([WELCOME, {"type": "command", "jobId": JOB_A, "command": "restart_agent", "args": {"profile": "viktor"}}])
                task = asyncio.create_task(HostSession(t, ctx).run())
                await _settle(t, lambda: t.of("result"))
                t.incoming.put_nowait(HostClosed(1006))
                await task
                return t, execu, states

        t, execu, states = asyncio.run(scenario())
        self.assertEqual(states, ["done"], "reported as done so the server asks again")
        self.assertEqual(execu.started, [], "a corrupt job is never run (again)")
        result = t.of("result")[0]
        self.assertEqual((result["ok"], result["errorCode"]), (False, "corrupt_state"))

    def test_shared_restart_reports_the_units_it_restarted(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                execu = InstantExecutor(home.paths, "ok\n")
                t = FakeTransport([WELCOME, {"type": "command", "jobId": JOB_A, "command": "restart_agent", "args": {"profile": "qa"}}])
                task = asyncio.create_task(HostSession(t, _ctx(home, execu)).run())
                await _settle(t, lambda: t.of("result"))
                t.incoming.put_nowait(HostClosed(1006))
                await task
                return t, execu

        t, execu = asyncio.run(scenario())
        self.assertEqual(execu.started[0][1], ["systemctl", "--user", "restart", "emperor-hermes-bridge-shared.service"])
        result = t.of("result")[0]
        self.assertEqual(result["units"], ["emperor-hermes-bridge-shared.service"])
        self.assertIn("restart shared bridge", result["summary"])


async def _ready(value):
    return value


async def _no_sleep(_delay: float) -> None:
    return None


class CloseCodeTests(unittest.TestCase):
    def test_exit_78_when_revoked_on_the_socket(self):
        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                t = FakeTransport([WELCOME, HostClosed(4401, "revoked")])
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=lambda cfg: _ready(t), sleep=_no_sleep, max_sessions=5)
        self.assertEqual(asyncio.run(scenario()), EXIT_REVOKED)

    def test_a_transient_handshake_401_is_retried_slowly_and_403_or_5xx_normally(self):
        sleeps: list[float] = []

        async def record(delay: float) -> None:
            sleeps.append(delay)

        attempts = iter([HandshakeRefused(401), HandshakeRefused(401), HandshakeRefused(403), HandshakeRefused(502), "ok"])
        opened: list[FakeTransport] = []

        async def opener(_cfg):
            item = next(attempts)
            if isinstance(item, Exception):
                raise item
            t = FakeTransport([WELCOME, HostClosed(1006)])
            opened.append(t)
            return t

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=opener, sleep=record,
                                        rng=lambda: 1.0, max_sessions=5, clock=lambda: 0.0)

        self.assertEqual(asyncio.run(scenario()), 0, "nothing transient ever stops the daemon")
        self.assertEqual(len(opened), 1, "it connected once the refusals passed")
        self.assertEqual(sleeps[:2], [15.0, 30.0], "401: slow backoff")
        self.assertEqual(sleeps[2:4], [1.0, 2.0], "403 / 5xx: normal backoff")

    def test_exit_78_only_when_a_handshake_401_persists_for_30_minutes(self):
        now = [0.0]

        async def advance(delay: float) -> None:
            now[0] += delay

        async def refused(_cfg):
            raise HandshakeRefused(401)

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=refused, sleep=advance,
                                        rng=lambda: 1.0, max_sessions=100, clock=lambda: now[0])

        self.assertEqual(asyncio.run(scenario()), EXIT_REVOKED)
        self.assertGreaterEqual(now[0], 30 * 60)
        self.assertTrue(all(slow_backoff_delay(n, rng=lambda: 1.0) <= 300 for n in range(20)))

    def test_fingerprint_mismatch_and_two_daemons_back_off_without_stopping(self):
        sleeps: list[float] = []

        async def record(delay: float) -> None:
            sleeps.append(delay)

        closes = iter([4403, 4409, 4409, 4409])

        async def opener(_cfg):
            return FakeTransport([WELCOME, HostClosed(next(closes))])

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=opener, sleep=record,
                                        rng=lambda: 1.0, max_sessions=4, clock=lambda: 100.0)

        self.assertEqual(asyncio.run(scenario()), 0)
        self.assertEqual(sleeps[0], 15.0, "4403: slow retry, never exit 78")
        self.assertGreaterEqual(sleeps[1], 45.0)
        self.assertEqual(sleeps[3], 15 * 60, "the third replacement in 10 minutes: wait 15 minutes")

    def test_an_unexpected_error_in_a_session_is_retried(self):
        sleeps: list[float] = []

        async def record(delay: float) -> None:
            sleeps.append(delay)

        def broken_hello(_jobs):
            raise RuntimeError("bug")

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                ctx = _ctx(home, InstantExecutor(home.paths))
                ctx.hello = broken_hello
                return await run_daemon(ctx, open_transport=lambda cfg: _ready(FakeTransport([WELCOME])), sleep=record,
                                        rng=lambda: 1.0, max_sessions=2)

        self.assertEqual(asyncio.run(scenario()), 0)
        self.assertEqual(len(sleeps), 2)

    def test_the_401_give_up_timer_restarts_after_any_other_outcome(self):
        now = [0.0]

        async def advance(delay: float) -> None:
            now[0] += delay

        # 25 minutes of 401s, one 503, then 401s again: the 30 minutes start over at the 503.
        state = {"n": 0}

        async def opener(_cfg):
            state["n"] += 1
            if now[0] < 25 * 60 or now[0] >= 25 * 60 + 400:
                raise HandshakeRefused(401)
            if state.get("blip") is None:
                state["blip"] = now[0]
                raise HandshakeRefused(503)
            raise HandshakeRefused(401)

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=opener, sleep=advance,
                                        rng=lambda: 1.0, max_sessions=200, clock=lambda: now[0])

        self.assertEqual(asyncio.run(scenario()), EXIT_REVOKED)
        self.assertGreaterEqual(now[0] - state["blip"], 30 * 60, "the give-up clock restarted after the 503")

    def test_a_rate_limited_close_keeps_backing_off(self):
        sleeps: list[float] = []

        async def record(delay: float) -> None:
            sleeps.append(delay)

        async def opener(_cfg):
            return FakeTransport([WELCOME, HostClosed(4429, "too many frames")])

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=opener, sleep=record,
                                        rng=lambda: 1.0, max_sessions=4)

        asyncio.run(scenario())
        self.assertEqual(sleeps, [1.0, 2.0, 4.0, 8.0], "4429 does not reset the backoff even after a welcome")

    def test_replaced_waits_a_minute_and_network_errors_back_off(self):
        sleeps: list[float] = []

        async def record(delay: float) -> None:
            sleeps.append(delay)

        attempts = iter([ConnectionRefusedError(), ConnectionRefusedError(), "replaced", "revoked"])

        async def opener(_cfg):
            item = next(attempts)
            if isinstance(item, Exception):
                raise item
            return FakeTransport([WELCOME, HostClosed(4409 if item == "replaced" else 4401)])

        async def scenario():
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                home = FakeHome(tmp)
                return await run_daemon(_ctx(home, InstantExecutor(home.paths)), open_transport=opener, sleep=record, rng=lambda: 1.0, max_sessions=10)

        self.assertEqual(asyncio.run(scenario()), EXIT_REVOKED, "4401 on an upgraded socket: the one permanent stop")
        self.assertEqual(sleeps[:2], [1.0, 2.0])
        self.assertGreaterEqual(sleeps[2], 45.0)

    def test_hello_lists_running_and_recent_jobs(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            home = FakeHome(tmp)
            store = JobStore(home.paths.jobs_dir, now=lambda: 200_000.0)
            store.save({"jobId": JOB_A, "state": "running", "lastSeq": 4})
            store.save({"jobId": JOB_B, "state": "done", "finishedAt": 199_000.0, "lastSeq": 2})
            store.save({"jobId": "55555555-5555-4555-8555-555555555555", "state": "done", "finishedAt": 1.0})
            hello = build_hello(home.paths, store.reportable(), fingerprint="f" * 64)
            self.assertEqual(sorted((j["jobId"][:4], j["state"]) for j in hello["jobs"]), [("1111", "running"), ("2222", "done")])
            self.assertEqual((hello["installerVersion"], hello["hermesVersion"], hello["bridgeVersion"]), ("0.21.0", "v0.22.4", "0.21.0"))


if __name__ == "__main__":
    unittest.main()
