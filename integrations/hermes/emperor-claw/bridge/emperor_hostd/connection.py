"""The socket to Emperor: hello/welcome, inventory, heartbeats, jobs, and reconnects.

When the daemon gives up for good (exit 78: systemd does not restart it, RestartPreventExitStatus):
- Emperor closed an UPGRADED socket with 4401: it revoked this host. Nothing else is permanent.
- The handshake answers HTTP 401 without a break for 30 minutes (a token Emperor no longer knows).
  Until then it retries slowly (up to 5 minutes apart) and logs loudly: a proxy or a database
  hiccup must not take a host offline for good.

Everything else retries: HTTP 403/5xx and network errors with backoff (1-60 s, jitter); 4403 (the
fingerprint does not match the paired machine) slowly; 4409 (a newer connection of this host
replaced this one) after a minute, and after 3 replacements in 10 minutes (two daemons share the
token) after 15 minutes. An unexpected error in a session is logged and retried, never fatal.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Protocol

from . import commands
from .commands import CommandRefused
from .config import HostdConfig, HostPaths
from .inventory import build_hello, build_inventory, heartbeat
from .protocol import (CLOSE_FINGERPRINT, CLOSE_RATE_LIMITED, CLOSE_REPLACED, CLOSE_REVOKED, EXIT_REVOKED, Redactor, Welcome, ack,
                       decode, encode)
from .runner import JobRunner
from .version import USER_AGENT

log = logging.getLogger("emperor_hostd")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
WELCOME_TIMEOUT_SEC = 20
REPLACED_WAIT_SEC = 60
#: Three replacements within this window mean another daemon uses the same token.
DUPLICATE_WINDOW_SEC = 10 * 60
DUPLICATE_WAIT_SEC = 15 * 60
BACKOFF_MIN_SEC = 1.0
BACKOFF_MAX_SEC = 60.0
#: Slow retries: a handshake 401 or a 4403 fingerprint mismatch (at most this far apart).
SLOW_BACKOFF_MAX_SEC = 300.0
#: A handshake 401 that persists this long ends the daemon (exit 78).
UNAUTHORIZED_GIVE_UP_SEC = 30 * 60
#: Pause between progress frames: at most ~14 frames/s, well inside the server's 20/s (burst 100) budget,
#: together with runner.MAX_FRAMES_PER_POLL = 50 per poll.
PROGRESS_PACE_SEC = 0.07


class HostClosed(Exception):
    """The socket closed (or the handshake was refused); ``code`` is the websocket close code."""

    def __init__(self, code: int, reason: str = "") -> None:
        super().__init__(f"closed {code} {reason}".strip())
        self.code = code
        self.reason = reason


class HandshakeRefused(Exception):
    """The upgrade was answered with an HTTP status instead of a socket."""

    def __init__(self, status: int) -> None:
        super().__init__(f"handshake refused (HTTP {status})")
        self.status = status


class Transport(Protocol):
    async def send(self, text: str) -> None: ...
    async def recv(self) -> str: ...
    async def close(self, code: int = 1000, reason: str = "") -> None: ...


def backoff_delay(attempt: int, rng: Callable[[], float] = random.random) -> float:
    """Exponential backoff with jitter: 1, 2, 4 ... capped at 60 s, each scaled by 0.5-1.0, never below 1 s."""
    base = min(BACKOFF_MAX_SEC, BACKOFF_MIN_SEC * (2 ** max(0, attempt)))
    return max(BACKOFF_MIN_SEC, min(BACKOFF_MAX_SEC, base * (0.5 + 0.5 * rng())))


def slow_backoff_delay(attempt: int, rng: Callable[[], float] = random.random) -> float:
    """15, 30, 60 ... capped at 5 minutes, jittered: for refusals that a retry storm cannot fix."""
    base = min(SLOW_BACKOFF_MAX_SEC, 15.0 * (2 ** max(0, attempt)))
    return max(BACKOFF_MIN_SEC, base * (0.75 + 0.25 * rng()))


class WebsocketTransport:
    """websockets (asyncio client, >= 13; the Hermes venv ships 15.0.1)."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws

    async def send(self, text: str) -> None:
        from websockets.exceptions import ConnectionClosed
        try:
            await self.ws.send(text)
        except ConnectionClosed as exc:
            raise _closed(exc) from exc

    async def recv(self) -> str:
        from websockets.exceptions import ConnectionClosed
        try:
            data = await self.ws.recv()
        except ConnectionClosed as exc:
            raise _closed(exc) from exc
        return data.decode("utf-8", "replace") if isinstance(data, bytes) else data

    async def close(self, code: int = 1000, reason: str = "") -> None:
        try:
            await self.ws.close(code, reason)
        except Exception:  # noqa: BLE001 - already closed
            pass


def _closed(exc: Any) -> HostClosed:
    rcvd = getattr(exc, "rcvd", None)
    code = getattr(rcvd, "code", None) or getattr(exc, "code", None) or 1006
    reason = getattr(rcvd, "reason", "") or ""
    return HostClosed(int(code), str(reason))


async def open_websocket(config: HostdConfig) -> Transport:
    """Connect with the host token in the Authorization header (never in the URL)."""
    from websockets.asyncio.client import connect
    from websockets.exceptions import InvalidStatus
    try:
        ws = await connect(config.socket_url, additional_headers={"Authorization": f"Bearer {config.host_token}"},
                           user_agent_header=USER_AGENT, max_size=1024 * 1024, open_timeout=20,
                           ping_interval=25, ping_timeout=20)
    except InvalidStatus as exc:
        raise HandshakeRefused(int(getattr(getattr(exc, "response", None), "status_code", 0) or 0)) from exc
    return WebsocketTransport(ws)


@dataclass
class DaemonContext:
    paths: HostPaths
    config: HostdConfig
    runner: JobRunner
    redactor: Redactor
    hello: Callable[[list[dict[str, Any]]], dict[str, Any]] = field(default=None)  # type: ignore[assignment]
    inventory: Callable[[], dict[str, Any]] = field(default=None)  # type: ignore[assignment]
    poll_interval: float = 1.0

    def __post_init__(self) -> None:
        if self.hello is None:
            self.hello = lambda jobs: build_hello(self.paths, jobs)
        if self.inventory is None:
            self.inventory = lambda: build_inventory(self.paths, self.config.origin, self.redactor)


class _Stop(Exception):
    pass


class HostSession:
    """One connected socket: everything from hello until it closes."""

    def __init__(self, transport: Transport, ctx: DaemonContext) -> None:
        self.t = transport
        self.ctx = ctx
        self.welcome: Optional[Welcome] = None
        self.exit_code: Optional[int] = None
        self._send_lock = asyncio.Lock()

    async def send(self, frame: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.t.send(encode(frame, self.ctx.redactor))

    async def send_inventory(self) -> None:
        frame = await asyncio.to_thread(self.ctx.inventory)
        await self.send(frame)

    async def run(self) -> int:
        """Run until the socket closes; returns the close code."""
        try:
            await self.send(self.ctx.hello(self.ctx.runner.store.reportable()))
            raw = await asyncio.wait_for(self.t.recv(), WELCOME_TIMEOUT_SEC)
            frame = decode(raw)
            if not frame or frame.get("type") != "welcome":
                await self.t.close(4400, "expected welcome")
                return 4400
            self.welcome = Welcome.parse(frame)
            if self.welcome.upgrade_required:
                log.warning("Emperor requires a newer host protocol: update this host (emperor-hermes update)")
            log.info("connected to %s as host %s (server %s)", self.ctx.config.origin, self.welcome.host_id, self.welcome.server_version)
            await self.send_inventory()
            for job in self.ctx.runner.store.running():
                for line in self.ctx.runner.recent_lines(job):
                    await self.send(line)
            tasks = [asyncio.create_task(c) for c in (self._reader(), self._heartbeats(), self._inventories(), self._monitor())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                for task in done:
                    exc = task.exception()
                    if exc:
                        raise exc
                return 1000
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except HostClosed as exc:
            return exc.code
        except _Stop:
            return 1000
        except asyncio.TimeoutError:
            await self.t.close(4400, "no welcome")
            return 4400

    async def _reader(self) -> None:
        while True:
            frame = decode(await self.t.recv())
            if not frame:
                continue
            kind = frame.get("type")
            if kind == "command":
                await self.handle_command(frame)
            elif kind == "inventory_request":
                await self.send_inventory()

    async def _heartbeats(self) -> None:
        assert self.welcome
        while True:
            await asyncio.sleep(self.welcome.heartbeat_sec)
            active = self.ctx.runner.active()
            await self.send(heartbeat(active["jobId"] if active else None))

    async def _inventories(self) -> None:
        assert self.welcome
        while True:
            await asyncio.sleep(self.welcome.inventory_sec)
            await self.send_inventory()
            await asyncio.to_thread(self.ctx.runner.store.prune)

    async def _monitor(self) -> None:
        while True:
            await asyncio.sleep(self.ctx.poll_interval)
            job = self.ctx.runner.active()
            if not job:
                continue
            frames, result, offset, seq = await asyncio.to_thread(self.ctx.runner.poll, job)
            for index, frame in enumerate(frames):
                if index:
                    await asyncio.sleep(PROGRESS_PACE_SEC)
                await self.send(frame)
            # Only now is the position remembered: frames lost to a failed send are read again.
            if not result:
                await asyncio.to_thread(self.ctx.runner.commit, job, offset, seq, frames)
            if result:
                await self.send(result)
                log.info("job %s finished: %s", job["jobId"], result.get("summary"))

    async def handle_command(self, frame: dict[str, Any]) -> None:
        job_id = str(frame.get("jobId", ""))
        if not UUID_RE.match(job_id):
            return
        job_id = job_id.lower()
        runner = self.ctx.runner
        known = runner.store.load(job_id)
        if known:
            # Never run a job twice: acknowledge it and replay what it did. A job whose file is
            # unreadable is reported as failed, never run again.
            await self.send(ack(job_id, True))
            if known.get("state") in ("done", "corrupt"):
                await self.send(runner.result_frame(known))
            if known.get("state") == "corrupt" and not known.get("retired"):
                # Reported: stop listing it in hello (a tombstone still keeps it from ever running).
                await asyncio.to_thread(runner.store.retire_corrupt, job_id)
            return
        if self.welcome and self.welcome.upgrade_required:
            await self.send(ack(job_id, False, "upgrade_required"))
            return
        active = runner.active()
        if active:
            await self.send(ack(job_id, False, "busy"))
            return
        command = str(frame.get("command", ""))
        try:
            plan = commands.plan(self.ctx.paths, command, frame.get("args"))
        except CommandRefused as exc:
            log.warning("refused job %s (%s): %s", job_id, command[:40], exc)
            await self.send(ack(job_id, False, str(exc)[:200]))
            return
        try:
            deadline = max(10, min(3600, int(frame.get("deadlineSec", 300))))
        except (TypeError, ValueError):
            deadline = 300
        log.info("job %s: %s", job_id, plan.summary)
        if plan.argv is None:
            job = runner.finish_inline(job_id, plan)
            await self.send(ack(job_id, True))
            if plan.command == "refresh_inventory":
                await self.send_inventory()
            await self.send(runner.result_frame(job))
            return
        job = await asyncio.to_thread(runner.start, job_id, plan, deadline)
        await self.send(ack(job_id, True))
        if job.get("state") == "done":
            await self.send(runner.result_frame(job))


async def run_daemon(ctx: DaemonContext,
                     open_transport: Callable[[HostdConfig], Awaitable[Transport]] = open_websocket,
                     sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                     rng: Callable[[], float] = random.random,
                     max_sessions: Optional[int] = None,
                     clock: Callable[[], float] = time.monotonic) -> int:
    """Connect, run, reconnect. Returns the process exit code (78 only when Emperor revoked the host)."""
    attempt = 0
    slow_attempt = 0
    unauthorized_since: Optional[float] = None
    replaced_at: list[float] = []
    sessions = 0
    while max_sessions is None or sessions < max_sessions:
        sessions += 1
        try:
            try:
                transport = await open_transport(ctx.config)
            except HandshakeRefused as exc:
                if exc.status == 401:
                    now = clock()
                    unauthorized_since = now if unauthorized_since is None else unauthorized_since
                    if now - unauthorized_since >= UNAUTHORIZED_GIVE_UP_SEC:
                        log.error("Emperor has refused this host's token for %d minutes; stopping (exit 78). "
                                  "Re-pair with: emperor-hermes host connect CODE", int((now - unauthorized_since) // 60))
                        return EXIT_REVOKED
                    delay = slow_backoff_delay(slow_attempt, rng)
                    slow_attempt += 1
                    log.error("EMPEROR REFUSED THIS HOST'S TOKEN (HTTP 401). Revoked? Retrying in %.0f s; "
                              "the daemon stops if this lasts 30 minutes.", delay)
                else:
                    unauthorized_since = None  # only an UNBROKEN run of 401s counts toward giving up
                    delay = backoff_delay(attempt, rng)
                    attempt += 1
                    log.warning("connection refused (HTTP %s); retrying in %.0f s", exc.status, delay)
                await sleep(delay)
                continue
            except Exception as exc:  # noqa: BLE001 - network errors of every kind: retry
                unauthorized_since = None
                delay = backoff_delay(attempt, rng)
                attempt += 1
                log.warning("cannot reach Emperor (%s); retrying in %.0f s", type(exc).__name__, delay)
                await sleep(delay)
                continue
            unauthorized_since = None  # the token was accepted
            session = HostSession(transport, ctx)
            code = await session.run()
            if session.exit_code is not None:
                return session.exit_code
            if code == CLOSE_REVOKED:
                log.error("this host was revoked in Emperor; stopping (exit 78). Re-pair with: emperor-hermes host connect CODE")
                return EXIT_REVOKED
            # A session that got its welcome resets the backoff, except when Emperor closed it for
            # sending too fast: then keep backing off.
            if session.welcome is not None and code != CLOSE_RATE_LIMITED:
                attempt = 0
                slow_attempt = 0
            if code == CLOSE_REPLACED:
                now = clock()
                replaced_at = [t for t in replaced_at if now - t < DUPLICATE_WINDOW_SEC] + [now]
                if len(replaced_at) >= 3:
                    replaced_at = []
                    delay = DUPLICATE_WAIT_SEC
                    log.error("ANOTHER DAEMON USES THIS HOST'S TOKEN (replaced 3 times in 10 minutes). Waiting 15 minutes. "
                              "Run emperor-hermes host disconnect on the other machine, or revoke and re-pair.")
                else:
                    delay = REPLACED_WAIT_SEC * (0.75 + 0.5 * rng())
                    log.warning("another connection of this host replaced this one; retrying in %.0f s", delay)
            elif code == CLOSE_FINGERPRINT:
                delay = slow_backoff_delay(slow_attempt, rng)
                slow_attempt += 1
                log.error("EMPEROR SAYS THIS IS NOT THE MACHINE IT PAIRED (fingerprint mismatch: /etc/machine-id changed, "
                          "or hostd.env was copied). Retrying in %.0f s; re-pair this machine to fix it.", delay)
            else:
                delay = backoff_delay(attempt, rng)
                attempt += 1
                log.warning("connection closed (%s); reconnecting in %.0f s", code, delay)
            await sleep(delay)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a bug in one session must not end the daemon
            delay = backoff_delay(attempt, rng)
            attempt += 1
            log.exception("unexpected error; reconnecting in %.0f s", delay)
            await sleep(delay)
    return 0
