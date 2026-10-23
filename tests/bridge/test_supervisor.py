"""Managed-mode gateway supervisor (emperor_bridge/supervisor.py), design section 7.2.

A fake ``hermes`` executable stands in for the gateway: it publishes a ready marker, exits 1 on
SIGTERM like Hermes v0.22.4, and can crash, fail to start, or ignore SIGTERM on request.

    python -m unittest tests/bridge/test_supervisor.py      (or pytest)
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "integrations/hermes/emperor-claw/bridge"))

from emperor_bridge import supervisor as sv  # noqa: E402

POSIX = os.name == "posix"

FAKE_GATEWAY = textwrap.dedent("""\
    import os, signal, sys, time
    from pathlib import Path
    home = Path(os.environ["FAKE_HOME"])
    runs_file = home / "runs"
    run = int(runs_file.read_text()) + 1 if runs_file.exists() else 1
    runs_file.write_text(str(run))
    (home / "argv").write_text(" ".join(sys.argv[1:]))
    (home / "env-pythonpath").write_text(os.environ.get("PYTHONPATH", "<unset>"))
    if run <= int(os.environ.get("FAKE_FAIL_START_RUNS", "0")):
        sys.exit(2)
    drain = float(os.environ.get("FAKE_DRAIN", "0"))
    def on_term(signum, frame):
        (home / "got-sigterm").write_text(str(os.getpid()))
        time.sleep(drain)
        sys.exit(1)  # Hermes v0.22.4 exits rc 1 on SIGTERM
    if os.environ.get("FAKE_IGNORE_TERM") == "1":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    else:
        signal.signal(signal.SIGTERM, on_term)
    if os.environ.get("FAKE_NEVER_READY") != "1":
        time.sleep(float(os.environ.get("FAKE_READY_DELAY", "0.05")))
        (home / "ready").write_text(str(os.getpid()))
    if run <= int(os.environ.get("FAKE_CRASH_RUNS", "0")):
        time.sleep(0.2)
        sys.exit(3)
    while True:
        time.sleep(0.05)
""")


def fake_identify_sync(home: Path) -> dict:
    try:
        pid = int((home / "ready").read_text())
        os.kill(pid, 0)
    except (OSError, ValueError):
        raise ConnectionRefusedError("no gateway")
    return {"ok": True, "result": {"state": "ready", "runtime_protocol": 1, "pid": pid,
                                   "instance_id": f"inst-{pid}", "code_version": "0.22.4"}}


async def fake_identify(home: Path) -> dict:
    return fake_identify_sync(home)


class Fixture:
    def __init__(self, **env: str) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "profile"
        self.home.mkdir()
        script = Path(self.tmp.name) / "fake_hermes"
        script.write_text(f"#!{sys.executable}\n{FAKE_GATEWAY}")
        script.chmod(0o755)
        self.status = Path(self.tmp.name) / "state" / "supervisor.json"
        self.cfg = sv.SupervisorConfig(
            profile="agent", profile_home=self.home, hermes_bin=str(script), ready_timeout_s=5,
            stop_timeout_s=2, backoff_s=(0.05, 0.1, 0.1, 0.1, 0.1), max_failures=3, failure_window_s=60,
            poll_interval_s=0.02, status_path=self.status,
            env={"FAKE_HOME": str(self.home), "PYTHONPATH": "/should/not/leak", **env})

    def read(self, name: str) -> str:
        return (self.home / name).read_text()

    def close(self) -> None:
        self.tmp.cleanup()


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 30))


@unittest.skipUnless(POSIX, "the supervisor only runs inside Linux containers")
class GatewaySupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixtures: list[Fixture] = []

    def tearDown(self) -> None:
        for fx in self.fixtures:
            fx.close()

    def make(self, **env: str) -> Fixture:
        self.fixtures.append(Fixture(**env))
        return self.fixtures[-1]

    def test_start_waits_for_ready_and_runs_gateway_in_its_own_session(self) -> None:
        fx = self.make(FAKE_READY_DELAY="0.2")
        ready_calls: list[bool] = []

        async def scenario() -> None:
            sup = sv.GatewaySupervisor(fx.cfg, identify=fake_identify,
                                       on_ready=lambda ident, restarted: ready_calls.append(restarted))
            ident = await sup.start()
            self.assertEqual(ident["result"]["pid"], sup.pid)
            self.assertEqual(os.getsid(sup.pid), sup.pid, "gateway must not share tini's process group")
            status = json.loads(fx.status.read_text())
            self.assertEqual(status["state"], "ready")
            self.assertEqual(status["profileHome"], str(fx.home))
            self.assertGreaterEqual(status["lastReadySeconds"], 0.15)
            await sup.stop()

        run(scenario())
        self.assertEqual(ready_calls, [False])
        self.assertEqual(fx.read("argv"), "-p agent gateway run --replace --external-supervisor")
        self.assertEqual(fx.read("env-pythonpath"), "<unset>", "bridge PYTHONPATH must not leak into Hermes")

    def test_sigterm_rc_1_is_a_normal_stop_and_drain_is_awaited(self) -> None:
        fx = self.make(FAKE_DRAIN="0.3")

        async def scenario() -> tuple[int | None, float, str]:
            sup = sv.GatewaySupervisor(fx.cfg, identify=fake_identify)
            await sup.start()
            t0 = time.monotonic()
            rc = await sup.stop()
            return rc, time.monotonic() - t0, sup.state

        rc, took, state = run(scenario())
        self.assertEqual(rc, 1)
        self.assertIn(rc, sv.EXPECTED_STOP_CODES)
        self.assertGreaterEqual(took, 0.25, "stop must wait for the gateway's own drain")
        self.assertEqual(state, "stopped")
        self.assertTrue((fx.home / "got-sigterm").exists())

    def test_sigkill_after_stop_timeout_when_the_gateway_ignores_sigterm(self) -> None:
        fx = self.make(FAKE_IGNORE_TERM="1")
        fx.cfg = sv.SupervisorConfig(**{**fx.cfg.__dict__, "stop_timeout_s": 0.4})

        async def scenario() -> int | None:
            sup = sv.GatewaySupervisor(fx.cfg, identify=fake_identify)
            await sup.start()
            return await sup.stop()

        rc = run(scenario())
        self.assertEqual(rc, -int(signal.SIGKILL))
        self.assertNotIn(rc, sv.EXPECTED_STOP_CODES)

    def test_crash_is_restarted_with_backoff_and_reported_as_restart(self) -> None:
        fx = self.make(FAKE_CRASH_RUNS="1")
        events: list[tuple[str, object]] = []

        async def scenario() -> sv.GatewaySupervisor:
            sup = sv.GatewaySupervisor(
                fx.cfg, identify=fake_identify,
                on_ready=lambda ident, restarted: events.append(("ready", restarted)),
                on_exit=lambda rc, expected: events.append(("exit", rc)))
            task = asyncio.create_task(sup.run())
            for _ in range(200):
                if sup.restarts == 1 and sup.state == "ready":
                    break
                await asyncio.sleep(0.02)
            await sup.stop()
            await task
            return sup

        sup = run(scenario())
        self.assertEqual(events, [("ready", False), ("exit", 3), ("ready", True)])
        self.assertEqual((sup.starts, sup.restarts), (2, 1))
        self.assertEqual(fx.read("runs"), "2")

    def test_gives_up_after_max_failures_inside_the_window(self) -> None:
        fx = self.make(FAKE_FAIL_START_RUNS="99")

        async def scenario() -> sv.GatewaySupervisor:
            sup = sv.GatewaySupervisor(fx.cfg, identify=fake_identify)
            with self.assertRaises(sv.SupervisorGaveUp):
                await sup.run()
            return sup

        sup = run(scenario())
        self.assertEqual(sup.starts, 3)
        self.assertEqual(sup.state, "failed")
        self.assertEqual(json.loads(fx.status.read_text())["state"], "failed")

    def test_ready_timeout_kills_the_child(self) -> None:
        fx = self.make(FAKE_NEVER_READY="1")
        fx.cfg = sv.SupervisorConfig(**{**fx.cfg.__dict__, "ready_timeout_s": 0.4})

        async def scenario() -> sv.GatewaySupervisor:
            sup = sv.GatewaySupervisor(fx.cfg, identify=fake_identify)
            with self.assertRaises(sv.GatewayStartError):
                await sup.start()
            return sup

        sup = run(scenario())
        self.assertIsNotNone(sup.proc.returncode)

    def test_supervise_returns_0_on_stop_and_1_when_it_gives_up(self) -> None:
        fx = self.make()

        async def stopped() -> int:
            stop = asyncio.Event()
            asyncio.get_running_loop().call_later(0.5, stop.set)
            return await sv.supervise(fx.cfg, stop_event=stop, identify=fake_identify)

        self.assertEqual(run(stopped()), 0)
        self.assertTrue((fx.home / "got-sigterm").exists())
        self.assertEqual(json.loads(fx.status.read_text())["state"], "stopped")

        failing = self.make(FAKE_FAIL_START_RUNS="99")

        async def gave_up() -> int:
            return await sv.supervise(failing.cfg, identify=fake_identify)

        self.assertEqual(run(gave_up()), 1)

    def test_stop_during_backoff_does_not_restart(self) -> None:
        fx = self.make(FAKE_CRASH_RUNS="1")
        fx.cfg = sv.SupervisorConfig(**{**fx.cfg.__dict__, "backoff_s": (5.0,)})

        async def scenario() -> sv.GatewaySupervisor:
            sup = sv.GatewaySupervisor(fx.cfg, identify=fake_identify)
            task = asyncio.create_task(sup.run())
            for _ in range(200):
                if sup.state == "restarting":
                    break
                await asyncio.sleep(0.02)
            await sup.stop()
            await asyncio.wait_for(task, 2)
            return sup

        sup = run(scenario())
        self.assertEqual(sup.starts, 1)
        self.assertEqual(sup.state, "stopped")


class ConfigAndHealthTests(unittest.TestCase):
    def test_from_env_uses_profile_and_defaults(self) -> None:
        cfg = sv.SupervisorConfig.from_env({"HOME": "/home/hermes", "HERMES_PROFILE": "ada"})
        self.assertEqual(cfg.profile_home, Path("/home/hermes/.hermes/profiles/ada"))
        self.assertEqual((cfg.ready_timeout_s, cfg.stop_timeout_s), (120.0, 55.0))
        self.assertEqual(cfg.backoff_s, (1.0, 2.0, 5.0, 10.0, 30.0))
        self.assertEqual((cfg.max_failures, cfg.failure_window_s), (5, 300.0))
        self.assertEqual(cfg.status_path, Path("/home/hermes/.local/state/emperor-hermes/supervisor.json"))
        with self.assertRaises(sv.SupervisorError):
            sv.SupervisorConfig.from_env({"HOME": "/tmp"})

    def test_stop_deadline_fits_inside_docker_stop_timeout(self) -> None:
        cfg = sv.SupervisorConfig.from_env({"HOME": "/h", "HERMES_PROFILE": "p"})
        # Gateway drain 30 s + ~20.5 s exit tail (measured) < supervisor SIGKILL deadline 55 s
        # < provisioning StopTimeout 75 s.
        self.assertLess(30 + 20.5, cfg.stop_timeout_s)
        self.assertLessEqual(cfg.stop_timeout_s + 15, 75)

    def test_control_socket_redirect(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertEqual(sv.control_socket_path(home), home / "gateway.sock")
            (home / "gateway.sock.path").write_text("/run/short.sock\n")
            self.assertEqual(sv.control_socket_path(home), Path("/run/short.sock"))

    def test_is_ready(self) -> None:
        self.assertTrue(sv.is_ready({"ok": True, "result": {"state": "ready", "runtime_protocol": 1}}))
        self.assertFalse(sv.is_ready({"ok": True, "result": {"state": "starting", "runtime_protocol": 1}}))
        self.assertFalse(sv.is_ready({"ok": False}))
        self.assertFalse(sv.is_ready("nope"))

    def test_healthcheck_reads_the_status_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            status = Path(tmp) / "supervisor.json"
            ok, message = sv.healthcheck(status, identify=lambda home: {})
            self.assertFalse(ok)
            self.assertIn("missing", message)

            status.write_text(json.dumps({"state": "ready", "profileHome": tmp}))
            ready = {"ok": True, "result": {"state": "ready", "runtime_protocol": 1, "pid": 7, "code_version": "0.22.4"}}
            seen: list[Path] = []
            ok, message = sv.healthcheck(status, identify=lambda home: seen.append(home) or ready)
            self.assertTrue(ok, message)
            self.assertEqual(seen, [Path(tmp)])

            def refused(home: Path) -> dict:
                raise ConnectionRefusedError("down")
            self.assertFalse(sv.healthcheck(status, identify=refused)[0])

            status.write_text(json.dumps({"state": "failed", "profileHome": tmp}))
            self.assertFalse(sv.healthcheck(status, identify=lambda home: ready)[0])

    @unittest.skipUnless(POSIX and hasattr(socket, "AF_UNIX"), "AF_UNIX control socket")
    def test_identify_sync_speaks_ndjson_over_the_control_socket(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            home = Path(tmp)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(home / "gateway.sock"))
            server.listen(1)
            received: list[dict] = []

            def serve() -> None:
                conn, _ = server.accept()
                with conn:
                    buf = b""
                    while not buf.endswith(b"\n"):
                        buf += conn.recv(4096)
                    received.append(json.loads(buf))
                    conn.sendall(json.dumps({"ok": True, "result": {"state": "ready", "runtime_protocol": 1}}).encode() + b"\n")

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            try:
                ident = sv.identify_sync(home, timeout=2)
            finally:
                thread.join(2)
                server.close()
            self.assertTrue(sv.is_ready(ident))
            self.assertEqual(received, [{"protocol": 1, "verb": "identify", "id": 1}])


if __name__ == "__main__":
    unittest.main()
