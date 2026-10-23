"""Managed mode (Mode B, Docker): the bridge supervises its own Hermes gateway child.

Design: docs/design/hermes-persistent-runtime.md section 7.2 (D3, D15).

Process tree in the container::

    tini -g (PID 1) -> bridge (python -m emperor_bridge run) -> hermes gateway (own session)

Behavior:

1. ``start()`` spawns ``hermes -p <profile> gateway run --replace --external-supervisor`` and polls
   ``identify`` on the profile's ``gateway.sock`` until ``state == "ready"`` (cold start measured
   3.8-4.2 s, timeout 120 s).
2. An exit we did not ask for is a crash: restart with backoff 1/2/5/10/30 s (restart -> ready
   measured 1.6-1.8 s). ``on_ready(identity, restarted=True)`` then lets the bridge run its D15
   restart path. Five failures within 5 minutes -> ``SupervisorGaveUp`` (the bridge exits
   non-zero and Docker's restart policy takes over).
3. ``stop()`` sends SIGTERM to the gateway only. Hermes' ``agent.restart_drain_timeout: 30``
   governs in-flight turns; the gateway exits ~20 s after the drain (~50.5 s measured).
   After ``stop_timeout_s`` (55 s) the whole gateway process group gets
   SIGKILL. **rc 1 after our SIGTERM is normal** (W0 section 6 D3), and so are 0 and -SIGTERM.
   Provisioning sets ``StopTimeout: 75`` so Docker never SIGKILLs mid-drain.

The gateway runs in its own session (``start_new_session``): ``tini -g`` forwards Docker's SIGTERM
to the bridge's process group, and the gateway must not get it at the same moment, because the
bridge stops dispatch first and then asks the gateway to drain.

Stdlib only. Also runnable on its own (diagnostics, contract tests)::

    python -m emperor_bridge.supervisor run          # supervise the gateway of $HERMES_PROFILE
    python -m emperor_bridge.supervisor healthcheck  # exit 0 when the supervised gateway is ready
    python -m emperor_bridge.supervisor status       # print the status file
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import signal
import socket
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# rc values that mean "stopped because we asked": Hermes exits 1 on SIGTERM (W0 section 6 D3).
EXPECTED_STOP_CODES = frozenset({0, 1, -int(signal.SIGTERM)})
DEFAULT_BACKOFF_S = (1.0, 2.0, 5.0, 10.0, 30.0)


def default_status_path(env: Optional[dict] = None) -> Path:
    """Where the supervisor publishes its state (outside the profile volume: per container)."""
    env = os.environ if env is None else env
    override = (env.get("EMPEROR_HERMES_SUPERVISOR_STATUS") or "").strip()
    if override:
        return Path(override)
    return Path(env.get("HOME") or Path.home()) / ".local" / "state" / "emperor-hermes" / "supervisor.json"


IdentifyFn = Callable[[Path], Awaitable[dict]]
ReadyCallback = Callable[[dict, bool], Any]
ExitCallback = Callable[[Optional[int], bool], Any]


class SupervisorError(RuntimeError):
    """Base class for supervisor failures."""


class GatewayStartError(SupervisorError):
    """The gateway exited before it was ready, or did not get ready in time."""


class SupervisorGaveUp(SupervisorError):
    """Too many gateway failures inside the failure window."""


# ── configuration ─────────────────────────────────────────────────────────────────────────────


def _env_float(env: dict, name: str, default: float) -> float:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


@dataclass(frozen=True)
class SupervisorConfig:
    profile: str
    profile_home: Path
    hermes_bin: str = "hermes"
    extra_args: tuple[str, ...] = ()
    ready_timeout_s: float = 120.0
    stop_timeout_s: float = 55.0
    backoff_s: tuple[float, ...] = DEFAULT_BACKOFF_S
    max_failures: int = 5
    failure_window_s: float = 300.0
    poll_interval_s: float = 0.1
    identify_timeout_s: float = 2.0
    status_path: Optional[Path] = None
    # None: the gateway inherits our stdout/stderr (docker logs). A path: append there instead.
    log_path: Optional[Path] = None
    env: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "SupervisorConfig":
        env = dict(os.environ if env is None else env)
        profile = (env.get("HERMES_PROFILE") or env.get("EMPEROR_CLAW_AGENT_NAME") or "").strip()
        if not profile:
            raise SupervisorError("HERMES_PROFILE is required to supervise a gateway")
        home = Path(env.get("HOME") or Path.home())
        profile_home = Path(env.get("HERMES_PROFILE_HOME") or home / ".hermes" / "profiles" / profile)
        log_path = (env.get("EMPEROR_HERMES_GATEWAY_LOG") or "").strip()
        return cls(
            profile=profile,
            profile_home=profile_home,
            hermes_bin=(env.get("HERMES_LAUNCHER") or "hermes").strip() or "hermes",
            ready_timeout_s=_env_float(env, "EMPEROR_HERMES_GATEWAY_READY_TIMEOUT", 120.0),
            stop_timeout_s=_env_float(env, "EMPEROR_HERMES_GATEWAY_STOP_TIMEOUT", 55.0),
            status_path=default_status_path(env),
            log_path=Path(log_path) if log_path else None,
        )

    def command(self) -> list[str]:
        return [self.hermes_bin, "-p", self.profile, "gateway", "run", "--replace",
                "--external-supervisor", *self.extra_args]

    def child_env(self) -> dict:
        env = dict(os.environ)
        env.update(self.env)
        # The bridge's PYTHONPATH and any venv must not leak into Hermes (its launcher runs -I,
        # but tool subprocesses inherit the environment).
        for key in ("PYTHONPATH", "VIRTUAL_ENV", "PYTHONHOME"):
            env.pop(key, None)
        env.setdefault("PYTHONUNBUFFERED", "1")
        env.setdefault("EMPEROR_GATEWAY_TOPOLOGY", "standalone")  # managed: one container, one agent
        return env


# ── control socket ────────────────────────────────────────────────────────────────────────────


def control_socket_path(profile_home: Path) -> Path:
    """``<profile_home>/gateway.sock``, honoring the ``gateway.sock.path`` indirection."""
    redirect = profile_home / "gateway.sock.path"
    try:
        target = redirect.read_text(encoding="utf-8").strip()
    except OSError:
        target = ""
    return Path(target) if target else profile_home / "gateway.sock"


def identify_sync(profile_home: Path, timeout: float = 2.0) -> dict:
    """One ``identify`` request over the gateway's control socket (newline-delimited JSON)."""
    family = getattr(socket, "AF_UNIX", None)
    if family is None:  # pragma: no cover - Windows hosts never run the gateway
        raise OSError("AF_UNIX sockets are not available on this platform")
    request = json.dumps({"protocol": 1, "verb": "identify", "id": 1}).encode() + b"\n"
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(control_socket_path(profile_home)))
        sock.sendall(request)
        data = bytearray()
        while not data.endswith(b"\n"):
            chunk = sock.recv(65536)
            if not chunk:
                break
            data.extend(chunk)
    return json.loads(bytes(data))


async def identify_async(profile_home: Path, timeout: float = 2.0) -> dict:
    return await asyncio.to_thread(identify_sync, profile_home, timeout)


def is_ready(ident: Any) -> bool:
    """Ready for the bridge: the identify call worked and the gateway reports ``ready``.

    The full D1 pin check (kind, capabilities, ``code_version``) belongs to the bridge's discovery;
    the supervisor only needs to know the process is serving.
    """
    if not isinstance(ident, dict) or not ident.get("ok"):
        return False
    result = ident.get("result") or {}
    return result.get("state") == "ready" and result.get("runtime_protocol") == 1


# ── supervisor ────────────────────────────────────────────────────────────────────────────────


async def _maybe_await(value: Any) -> None:
    if inspect.isawaitable(value):
        await value


def _log(message: str) -> None:
    print(f"[supervisor] {message}", file=sys.stderr, flush=True)


class GatewaySupervisor:
    """Owns one gateway child. Not thread-safe: use it from one event loop."""

    def __init__(self, cfg: SupervisorConfig, *, identify: Optional[IdentifyFn] = None,
                 on_ready: Optional[ReadyCallback] = None, on_exit: Optional[ExitCallback] = None,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
                 log: Callable[[str], None] = _log) -> None:
        self.cfg = cfg
        self._identify = identify or (lambda home: identify_async(home, cfg.identify_timeout_s))
        self._on_ready = on_ready
        self._on_exit = on_exit
        self._clock = clock
        self._sleep = sleep
        self._log = log
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.state = "idle"  # idle | starting | ready | restarting | stopping | stopped | failed
        self.identity: Optional[dict] = None
        self.starts = 0
        self.restarts = 0
        self.last_exit_rc: Optional[int] = None
        self.last_ready_s: Optional[float] = None
        self._failures: list[float] = []
        self._stopping = False
        self._stop_requested = asyncio.Event()
        self._logfile: Any = None

    # ― status ―

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.proc else None

    @property
    def stopping(self) -> bool:
        return self._stopping

    def status(self) -> dict:
        result = (self.identity or {}).get("result") or {}
        return {
            "state": self.state, "profile": self.cfg.profile, "profileHome": str(self.cfg.profile_home),
            "pid": self.pid, "starts": self.starts, "restarts": self.restarts,
            "recentFailures": len(self._recent_failures()), "lastExitRc": self.last_exit_rc,
            "lastReadySeconds": self.last_ready_s, "instanceId": result.get("instance_id"),
            "codeVersion": result.get("code_version"), "updatedAt": time.time(),
        }

    def _write_status(self) -> None:
        path = self.cfg.status_path
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(self.status()), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:  # status is advisory; never fail supervision over it
            self._log(f"status write failed: {exc}")

    def _set_state(self, state: str) -> None:
        self.state = state
        self._write_status()

    def _recent_failures(self) -> list[float]:
        horizon = self._clock() - self.cfg.failure_window_s
        self._failures = [t for t in self._failures if t >= horizon]
        return self._failures

    # ― process control ―

    async def _spawn(self) -> None:
        stdout: Any = None
        if self.cfg.log_path:
            self.cfg.log_path.parent.mkdir(parents=True, exist_ok=True)
            if self._logfile is None:
                self._logfile = open(self.cfg.log_path, "ab", buffering=0)
            stdout = self._logfile
        self.proc = await asyncio.create_subprocess_exec(
            *self.cfg.command(), stdin=asyncio.subprocess.DEVNULL, stdout=stdout,
            stderr=asyncio.subprocess.STDOUT if stdout is not None else None,
            env=self.cfg.child_env(), start_new_session=True)
        self.starts += 1
        self._write_status()
        self._log(f"gateway spawned pid={self.proc.pid} ({' '.join(self.cfg.command())})")

    async def start(self) -> dict:
        """Spawn the gateway and wait for ``identify.state == "ready"``."""
        if self.proc and self.proc.returncode is None:
            raise SupervisorError("gateway already running")
        restarted = self.starts > 0
        self._set_state("restarting" if restarted else "starting")
        t0 = self._clock()
        await self._spawn()
        assert self.proc is not None
        deadline = t0 + self.cfg.ready_timeout_s
        last: Any = None
        while True:
            if self.proc.returncode is not None:
                self.last_exit_rc = self.proc.returncode
                raise GatewayStartError(f"gateway exited before ready rc={self.proc.returncode} (last identify: {last!r})")
            if self._stopping:
                raise GatewayStartError("stop requested while the gateway was starting")
            try:
                last = await self._identify(self.cfg.profile_home)
                if is_ready(last):
                    break
            except (OSError, ValueError) as exc:
                last = repr(exc)
            if self._clock() >= deadline:
                await self._kill_group()
                raise GatewayStartError(f"gateway not ready in {self.cfg.ready_timeout_s:.0f} s (last identify: {last!r})")
            await self._sleep(self.cfg.poll_interval_s)
        self.identity = last
        self.last_ready_s = round(self._clock() - t0, 3)
        result = last.get("result") or {}
        self._log(f"gateway ready in {self.last_ready_s} s pid={self.proc.pid} "
                  f"instance={result.get('instance_id')} version={result.get('code_version')}")
        self._set_state("ready")
        if self._on_ready:
            try:
                await _maybe_await(self._on_ready(last, restarted))
            except Exception as exc:  # a bridge callback bug must not kill supervision
                self._log(f"on_ready callback failed: {exc!r}")
        return last

    async def _kill_group(self) -> None:
        proc = self.proc
        if not proc or proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, AttributeError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:  # pragma: no cover - SIGKILL does not get ignored
            self._log(f"gateway pid={proc.pid} survived SIGKILL")

    async def stop(self, reason: str = "stop") -> Optional[int]:
        """SIGTERM the gateway, wait up to ``stop_timeout_s``, then SIGKILL its process group.

        Idempotent. Returns the gateway's exit code (None when nothing was running).
        """
        self._stopping = True
        self._stop_requested.set()
        proc = self.proc
        if not proc or proc.returncode is not None:
            if self.state != "failed":  # keep "failed" visible to the healthcheck
                self._set_state("stopped")
            return proc.returncode if proc else None
        self._set_state("stopping")
        t0 = self._clock()
        self._log(f"stopping gateway pid={proc.pid} ({reason}): SIGTERM, drain up to {self.cfg.stop_timeout_s:.0f} s")
        try:
            proc.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            rc = await asyncio.wait_for(proc.wait(), self.cfg.stop_timeout_s)
        except asyncio.TimeoutError:
            self._log(f"gateway did not exit in {self.cfg.stop_timeout_s:.0f} s: SIGKILL")
            await self._kill_group()
            rc = proc.returncode
        self.last_exit_rc = rc
        took = round(self._clock() - t0, 3)
        normal = rc in EXPECTED_STOP_CODES
        self._log(f"gateway stopped rc={rc} in {took} s ({'normal' if normal else 'unexpected'})")
        self._set_state("stopped")
        if self._logfile is not None:
            self._logfile.close()
            self._logfile = None
        return rc

    async def run(self) -> None:
        """Keep the gateway alive until ``stop()``. Starts it first when it is not running.

        Raises ``SupervisorGaveUp`` after ``max_failures`` failures within ``failure_window_s``.
        """
        if not self.proc or self.proc.returncode is not None:
            await self._start_with_retry()
        while not self._stopping:
            assert self.proc is not None
            rc = await self.proc.wait()
            if self._stopping:
                return
            self.last_exit_rc = rc
            self._log(f"gateway exited unexpectedly rc={rc}")
            if self._on_exit:
                try:
                    await _maybe_await(self._on_exit(rc, False))
                except Exception as exc:
                    self._log(f"on_exit callback failed: {exc!r}")
            self._record_failure()
            await self._start_with_retry()

    def _record_failure(self) -> None:
        self._failures.append(self._clock())
        failures = len(self._recent_failures())
        self._write_status()
        if failures >= self.cfg.max_failures:
            self._set_state("failed")
            raise SupervisorGaveUp(
                f"gateway failed {failures} times in {self.cfg.failure_window_s:.0f} s; giving up")

    async def _start_with_retry(self) -> None:
        while not self._stopping:
            failures = len(self._recent_failures())
            if failures:
                delay = self.cfg.backoff_s[min(failures, len(self.cfg.backoff_s)) - 1]
                self._set_state("restarting")
                self._log(f"restarting gateway in {delay:g} s (failure {failures}/{self.cfg.max_failures})")
                try:
                    await asyncio.wait_for(self._stop_requested.wait(), delay)
                    return  # stop() arrived during the backoff
                except asyncio.TimeoutError:
                    pass
                self.restarts += 1
            try:
                await self.start()
                return
            except GatewayStartError as exc:
                if self._stopping:
                    return
                self._log(str(exc))
                self._record_failure()


async def supervise(cfg: SupervisorConfig, *, stop_event: Optional[asyncio.Event] = None,
                    on_ready: Optional[ReadyCallback] = None, on_exit: Optional[ExitCallback] = None,
                    identify: Optional[IdentifyFn] = None) -> int:
    """Run the gateway until ``stop_event`` is set. Returns a process exit code.

    0: stopped on request. 1: gave up after repeated failures.
    The bridge (W4) can instead hold a ``GatewaySupervisor`` itself: ``await sup.start()`` before
    connecting, ``asyncio.create_task(sup.run())``, and ``await sup.stop()`` on SIGTERM right after
    it stops dispatch.
    """
    stop_event = stop_event or asyncio.Event()
    sup = GatewaySupervisor(cfg, identify=identify, on_ready=on_ready, on_exit=on_exit)
    runner = asyncio.create_task(sup.run())
    waiter = asyncio.create_task(stop_event.wait())
    try:
        done, _ = await asyncio.wait({runner, waiter}, return_when=asyncio.FIRST_COMPLETED)
        if runner in done:
            exc = runner.exception()
            if isinstance(exc, SupervisorGaveUp):
                _log(str(exc))
                await sup.stop("gave up")
                return 1
            if exc:
                raise exc
            return 0
        await sup.stop("stop requested")
        await asyncio.gather(runner, return_exceptions=True)
        return 0
    finally:
        waiter.cancel()
        if not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)


# ── healthcheck / CLI ─────────────────────────────────────────────────────────────────────────


def read_status(path: Optional[Path] = None) -> Optional[dict]:
    path = path or default_status_path()
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def healthcheck(status_path: Optional[Path] = None, *, identify: Callable[[Path], dict] = identify_sync) -> tuple[bool, str]:
    """Gateway part of the container healthcheck: the supervised gateway answers ``ready``.

    The bridge's ``python -m emperor_bridge healthcheck`` (W4) calls this and adds its own checks.
    The profile comes from the supervisor's status file, because Docker runs the healthcheck with
    the container's create-time environment only.
    """
    status = read_status(status_path)
    if not status:
        return False, "supervisor status file missing: the gateway was never started"
    state = status.get("state")
    if state in {"failed", "stopped", "stopping"}:
        return False, f"supervisor state {state}"
    home = Path(status.get("profileHome") or "")
    try:
        ident = identify(home)
    except (OSError, ValueError) as exc:
        return False, f"gateway identify failed ({state}): {exc}"
    if not is_ready(ident):
        result = (ident or {}).get("result") or {}
        return False, f"gateway not ready ({state}): state={result.get('state')!r}"
    result = ident.get("result") or {}
    return True, f"gateway ready pid={result.get('pid')} version={result.get('code_version')}"


def _main(argv: list[str]) -> int:
    command = argv[0] if argv else "run"
    if command == "healthcheck":
        ok, message = healthcheck()
        print(("healthy: " if ok else "unhealthy: ") + message)
        return 0 if ok else 1
    if command == "status":
        print(json.dumps(read_status()))
        return 0
    if command != "run":
        print("usage: python -m emperor_bridge.supervisor [run|healthcheck|status]", file=sys.stderr)
        return 2

    cfg = SupervisorConfig.from_env()

    async def runner() -> int:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        return await supervise(cfg, stop_event=stop)

    return asyncio.run(runner())


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
