"""Emperor runtime controls mapped onto the gateway (D10).

- Stop (a message's delivery state became `cancelled`): drop it from the scheduler queue, or
  interrupt the running turn that answers it (`session.interrupt`, `prompt.cancel` if Hermes
  still has it queued).
- Kill / replace (`GET /agents/control` commands, `metadataJson.runtimeControl.action`): drop
  every queued message, interrupt every running turn, retire every thread's generation (the next
  message starts a fresh session, like 0.3 wiping `sessions`), run the runtime's hook (W4 pauses
  objectives), then acknowledge each command.
- Thread-scoped replace (`runtimeControl.scope == "thread"`, private direct-chat mode: one person's
  own direct thread): only the command's thread is touched. Its queued messages created before the
  command are dropped, its running turn is interrupted, its session generation is retired; every
  other thread (other people's chats) keeps running. Kill and unscoped replace stay agent-wide.
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


def _control(command: Mapping[str, Any]) -> Mapping[str, Any]:
    meta = command.get("metadataJson") or command.get("metadata") or {}
    control = meta.get("runtimeControl") if isinstance(meta, Mapping) else None
    return control if isinstance(control, Mapping) else {}


def command_action(command: Mapping[str, Any]) -> Optional[str]:
    action = _control(command).get("action")
    return str(action) if action else None


def command_thread_scope(command: Mapping[str, Any]) -> Optional[str]:
    """The thread a scoped replace is limited to, or None for an agent-wide command."""
    thread_id = str(command.get("threadId") or command.get("thread_id") or "")
    if command_action(command) == "replace" and _control(command).get("scope") == "thread" and thread_id:
        return thread_id
    return None


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
                 on_thread_reset: Optional[Callable[[str], Awaitable[None]]] = None,
                 logger: Optional[logging.Logger] = None) -> None:
        self._scheduler = scheduler
        self._runner = runner
        self._sessions = sessions
        self._emperor = emperor
        self._on_kill = on_kill
        self._on_thread_reset = on_thread_reset
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
        if all(command_thread_scope(c) for c in kills):
            for command in kills:
                await self._apply_thread_replace(command, outcome)
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
            await self._ack(command, outcome)
        self._log.info("control %s: interrupted=%d dropped=%d retired=%d", action, len(outcome.interrupted_threads),
                       len(outcome.dropped_messages), len(outcome.retired_threads))
        return outcome

    async def _apply_thread_replace(self, command: Mapping[str, Any], outcome: ControlOutcome) -> None:
        thread_id = command_thread_scope(command) or ""
        outcome.actions.append("replace")
        dropped = self._scheduler.clear_thread(thread_id, before=command.get("createdAt"))
        outcome.dropped_messages.extend(m.id for m in dropped)
        if await self._runner.interrupt(thread_id, "replace"):
            outcome.interrupted_threads.append(thread_id)
        if self._sessions.bump_generation(thread_id, "replace") is not None:
            outcome.retired_threads.append(thread_id)
        await self._sessions.save()  # the fresh session is persisted before the acknowledgement
        await self._sessions.close_retired()
        if self._on_thread_reset is not None:
            await self._on_thread_reset(thread_id)
        await self._ack(command, outcome)
        self._log.info("control replace (thread %s): interrupted=%d dropped=%d", thread_id,
                       int(thread_id in outcome.interrupted_threads), len(dropped))

    async def _ack(self, command: Mapping[str, Any], outcome: ControlOutcome) -> None:
        command_id = command.get("id")
        if not command_id:
            return
        try:
            await self._emperor.ack_control_command(str(command_id))
            outcome.acked.append(str(command_id))
        except Exception as exc:  # acked again on the next poll
            self._log.warning("control ack %s failed: %s", command_id, exc)
