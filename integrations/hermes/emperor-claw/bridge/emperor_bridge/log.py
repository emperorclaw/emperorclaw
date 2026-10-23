"""Logging, the timing lines (design 5.8) and the deleted-variable warnings.

Every line is UTC-stamped (the watchdog and QA correlate bridge lines with systemd and gateway
logs) and names the agent profile, because one shared-mode process hosts several agents.

Timing lines:
- ``rpc method=<m> ws=turns|maintenance ms=<n>`` for every gateway RPC (``TimedLink``);
- ``turn.timing`` from the core (queue/first token/duration, ``restart_path``) and
  ``turn.delivery`` from the runtime (pickup = message created -> dispatched, reply delivery).
"""
from __future__ import annotations

import logging
import sys
import time
from typing import Any, Iterable, Mapping, Optional, Sequence

from .interfaces import GatewayEvent, GatewayIdentity

LOGGER_ROOT = "emperor_bridge"
_INFO_RPCS = frozenset({"prompt.submit", "prompt.cancel", "prompt.receipt", "prompt.resolve_unknown",
                        "session.create", "session.resume", "session.mutate", "session.interrupt",
                        "session.events.since"})

# Variables of bridge 0.3 that 0.9 no longer reads: value -> what replaced it (None = gone).
DELETED_ENV_VARS: Mapping[str, Optional[str]] = {
    "HERMES_BIN": "the gateway (D1); nothing to set",
    "HERMES_TOOLSETS": "EMPEROR_CLAW_HERMES_TOOLSETS",
    "HERMES_HOME": "HERMES_PROFILE / --profiles",
    "HERMES_INSTALL_DIR": "HERMES_CHECKOUT",
    "EMPEROR_HERMES_GOAL_PYTHON": "HERMES_PYTHON",
    "EMPEROR_CLAW_HERMES_PROFILE": "HERMES_PROFILE",
    "EMPEROR_CLAW_HERMES_POLL_SECONDS": None,
    "EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS": "EMPEROR_CLAW_HERMES_TURN_TIMEOUT_SECONDS",
    "EMPEROR_CLAW_HERMES_IDLE_TIMEOUT_SECONDS": "EMPEROR_CLAW_HERMES_TURN_IDLE_TIMEOUT_SECONDS",
    "EMPEROR_CLAW_HERMES_TIMEOUT_GRACE_SECONDS": None,
    "EMPEROR_CLAW_HERMES_ORPHAN_GRACE_SECONDS": None,
    "EMPEROR_CLAW_HERMES_SESSION_BUSY_BASE_SECONDS": None,
    "EMPEROR_CLAW_HERMES_SESSION_BUSY_MAX_SECONDS": None,
    "EMPEROR_CLAW_HERMES_SESSION_BUSY_FRESH_AFTER": None,
    "EMPEROR_CLAW_HERMES_SESSION_MAX_TURNS": "EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS",
    "EMPEROR_CLAW_HERMES_SESSION_MAX_HOURS": "EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS",
    "EMPEROR_CLAW_HERMES_DIRECT_SESSION_MAX_TURNS": "EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS",
    "EMPEROR_CLAW_HERMES_DIRECT_SESSION_MAX_HOURS": "EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS",
    "EMPEROR_CLAW_STATIC_BLOCK_REFRESH_MINUTES": None,
    "EMPEROR_CLAW_HERMES_PREDISPATCH_WORKERS": None,
    "EMPEROR_CLAW_OPEN_TASKS_LIMIT": None,
    "EMPEROR_CLAW_MAIN_CHAT_CONTEXT_LIMIT": None,
    "EMPEROR_CLAW_MAIN_CHAT_CONTEXT_MAX_CHARS": None,
    "EMPEROR_CLAW_MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS": None,
    "EMPEROR_CLAW_REASONING_SOURCE": "Hermes reasoning events (always on)",
    "EMPEROR_CLAW_REASONING_HISTORY": None,
    "EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE": None,
    "EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS": "GET /api/mcp/runtime/profile-defaults (applied by the installer)",
}


class _UtcFormatter(logging.Formatter):
    converter = time.gmtime

    def formatTime(self, record: logging.LogRecord, datefmt: Optional[str] = None) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z"


def setup_logging(level: str = "INFO", stream: Any = None) -> None:
    """One stdout handler for the whole process (systemd/docker collect stdout)."""
    root = logging.getLogger(LOGGER_ROOT)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(_UtcFormatter("[%(asctime)s] [emperor-hermes] %(name)s %(levelname)s %(message)s"))
    root.addHandler(handler)
    root.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    root.propagate = False


def agent_logger(profile: str, part: str = "") -> logging.Logger:
    name = f"{LOGGER_ROOT}.{profile or 'default'}"
    return logging.getLogger(f"{name}.{part}" if part else name)


def warn_deleted_env(sources: Iterable[tuple[str, Mapping[str, str]]], logger: logging.Logger,
                     already: set[str]) -> list[str]:
    """Warn once per variable (across the process env and every profile .env)."""
    warned = []
    for origin, env in sources:
        for name, replacement in DELETED_ENV_VARS.items():
            if name in env and name not in already:
                already.add(name)
                warned.append(name)
                hint = f"use {replacement}" if replacement else "it has no effect anymore"
                logger.warning("%s sets %s, which bridge 0.9 no longer reads: %s", origin, name, hint)
    return warned


def format_turn_delivery(message_id: str, *, created_at: Optional[float], dispatched_at: float,
                         delivered_at: float, outcome: str, queue_ms: Optional[int], first_token_ms: Optional[int],
                         api_calls: Optional[int], tool_calls: int, restart_path: bool, parked: bool) -> str:
    """One measurable line per answered message. Pure. Unknown phases are omitted, never guessed."""
    parts = [f"turn.delivery msg={message_id} outcome={outcome}"]
    if created_at is not None:
        parts.append(f"pickup={max(0.0, dispatched_at - created_at):.2f}s")
    if queue_ms is not None:
        parts.append(f"queue_ms={queue_ms}")
    if first_token_ms is not None:
        parts.append(f"first_token_ms={first_token_ms}")
    parts.append(f"total={max(0.0, delivered_at - dispatched_at):.2f}s")
    if api_calls is not None:
        parts.append(f"calls={api_calls}")
    parts.append(f"tools={tool_calls} restart_path={int(restart_path)} parked={int(parked)}")
    return " ".join(parts)


class TimedChannel:
    """Wraps one RpcChannel and logs ``rpc method=<m> ws=<socket> ms=<n>`` per call (design 5.8)."""

    def __init__(self, inner: Any, name: str, logger: logging.Logger) -> None:
        self._inner = inner
        self.name = name
        self._log = logger

    async def call(self, method: str, params: Optional[Mapping[str, Any]] = None, *, timeout: float = 30.0) -> Any:
        started = time.monotonic()
        status = "ok"
        try:
            return await self._inner.call(method, params, timeout=timeout)
        except BaseException as exc:
            status = type(exc).__name__
            raise
        finally:
            level = logging.INFO if method in _INFO_RPCS else logging.DEBUG
            self._log.log(level, "rpc method=%s ws=%s ms=%.1f status=%s", method, self.name,
                          (time.monotonic() - started) * 1000, status)


class TimedLink:
    """A GatewayLinkPort proxy whose two channels log RPC timing. Everything else is delegated."""

    def __init__(self, link: Any, logger: logging.Logger) -> None:
        self._link = link
        self.turns = TimedChannel(link.turns, "turns", logger)
        self.maintenance = TimedChannel(link.maintenance, "maintenance", logger)

    @property
    def identity(self) -> Optional[GatewayIdentity]:
        return self._link.identity

    @property
    def connected(self) -> bool:
        return self._link.connected

    @property
    def fatal_error(self) -> Optional[str]:
        return getattr(self._link, "fatal_error", None)

    def add_event_listener(self, listener: Any) -> None:
        self._link.add_event_listener(listener)

    def add_reconnect_listener(self, listener: Any) -> None:
        self._link.add_reconnect_listener(listener)

    def inject_events(self, events: Sequence[GatewayEvent]) -> None:
        self._link.inject_events(events)

    def hold_session(self, session_id: str) -> None:
        self._link.hold_session(session_id)

    def release_session(self, session_id: str) -> None:
        self._link.release_session(session_id)

    def seed_cursor(self, session_id: str, replay_epoch: Optional[str], seq: int) -> None:
        self._link.seed_cursor(session_id, replay_epoch, seq)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._link, name)
