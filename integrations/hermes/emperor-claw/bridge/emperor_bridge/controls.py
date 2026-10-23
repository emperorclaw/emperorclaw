"""Emperor runtime controls mapped onto the gateway (D10).

- Stop (a message's delivery state became `cancelled`): drop it from the scheduler queue, or
  interrupt the running turn that answers it (`session.interrupt`, `prompt.cancel` if Hermes
  still has it queued).
- Kill / replace (`GET /agents/control` commands, `metadataJson.runtimeControl.action`): drop
  every queued message, interrupt every running turn, retire every thread's generation (the next
  message starts a fresh session, like 0.3 wiping `sessions`), run the runtime's hook (W4 pauses
  objectives), then acknowledge each command.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Mapping, Optional

from .gateway.sessions import SessionManager
from .interfaces import EmperorPort
from .scheduler import Scheduler
from .turns import TurnRunner

KILL_ACTIONS = frozenset({"kill", "replace"})


def command_action(command: Mapping[str, Any]) -> Optional[str]:
    meta = command.get("metadataJson") or command.get("metadata") or {}
    control = meta.get("runtimeControl") if isinstance(meta, Mapping) else None
    action = (control or {}).get("action") if isinstance(control, Mapping) else None
    return str(action) if action else None


@dataclass
class ControlOutcome:
    actions: list[str] = field(default_factory=list)
    interrupted_threads: list[str] = field(default_factory=list)
    dropped_messages: list[str] = field(default_factory=list)
    acked: list[str] = field(default_factory=list)
    retired_threads: list[str] = field(default_factory=list)


class ControlPlane:
    def __init__(self, scheduler: Scheduler, runner: TurnRunner, sessions: SessionManager, emperor: EmperorPort, *,
                 on_kill: Optional[Callable[[str], Awaitable[None]]] = None,
                 logger: Optional[logging.Logger] = None) -> None:
        self._scheduler = scheduler
        self._runner = runner
        self._sessions = sessions
        self._emperor = emperor
        self._on_kill = on_kill
        self._log = logger or logging.getLogger("emperor_bridge.controls")

    async def stop_message(self, message_id: str) -> bool:
        """The message was cancelled in Emperor. True when something was dropped or interrupted."""
        if self._scheduler.cancel(message_id):
            return True
        thread_id = self._runner.thread_for_message(message_id)
        if thread_id is None:
            return False
        return await self._runner.interrupt(thread_id, "stop")

    async def apply(self, payload: Mapping[str, Any] | Iterable[Mapping[str, Any]]) -> ControlOutcome:
        """Apply a `GET /agents/control` payload (or its `commands` list)."""
        commands = list(payload.get("commands") or []) if isinstance(payload, Mapping) else list(payload)
        outcome = ControlOutcome()
        kills = [c for c in commands if command_action(c) in KILL_ACTIONS]
        if not kills:
            return outcome
        action = command_action(kills[-1]) or "kill"
        outcome.actions = [command_action(c) or "" for c in kills]
        outcome.dropped_messages = [m.id for m in self._scheduler.clear_pending()]
        threads = self._runner.active_threads()
        results = await asyncio.gather(*(self._runner.interrupt(t, action) for t in threads), return_exceptions=True)
        outcome.interrupted_threads = [t for t, r in zip(threads, results) if r is True]
        # Persist the fresh-session decision before acknowledging: a restart between these
        # writes must never resume the session the operator just stopped.
        outcome.retired_threads = self._sessions.bump_all(action)
        await self._sessions.save()
        await self._sessions.close_retired()  # M8: archive the retired idle sessions (rest: housekeeping)
        if self._on_kill is not None:
            await self._on_kill(action)
        for command in kills:
            command_id = command.get("id")
            if not command_id:
                continue
            try:
                await self._emperor.ack_control_command(str(command_id))
                outcome.acked.append(str(command_id))
            except Exception as exc:  # acked again on the next poll
                self._log.warning("control ack %s failed: %s", command_id, exc)
        self._log.info("control %s: interrupted=%d dropped=%d retired=%d", action, len(outcome.interrupted_threads),
                       len(outcome.dropped_messages), len(outcome.retired_threads))
        return outcome
