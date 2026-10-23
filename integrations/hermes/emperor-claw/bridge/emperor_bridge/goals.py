"""Persistent objectives (D18): Emperor's goal commands, decided by Hermes' native goal engine.

Emperor queues `runtimeGoalRequest` commands (start/pause/resume/clear) on GET /agents/goals; the
bridge applies them through ``hermes_goal_adapter.py`` (run on ``HERMES_PYTHON`` with
``PYTHONPATH=<checkout>``, ``cwd=<checkout>``, ``HERMES_HOME=<profile home>``) and acknowledges
with the resulting public state. The goal is keyed by the thread's Hermes **logical** session id;
a new generation of that thread migrates it (``previousSession``).

An objective step is an ordinary admission: the runtime queues it through the scheduler (one turn
per thread, ledger ``triggerKind: objective``) with no acknowledge-first and no turn-file message id.
After the step the reply is evaluated (``evaluate``: the native judge, contract ``goal_evaluate``);
the reply is persisted as ``pendingEvaluation`` first, so a restart judges the saved output instead
of running the model again. Everything durable is saved before it is acknowledged.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional

ADAPTER = Path(__file__).resolve().parent.parent / "hermes_goal_adapter.py"
PUBLIC_KEYS = ("status", "objective", "contract", "turnsUsed", "maxTurns", "message", "waiting")
GOAL_MESSAGE_PREFIX = "goal-"


class NativeGoalError(RuntimeError):
    """The native goal engine refused or is unavailable."""


def public_state(goal: Mapping[str, Any]) -> dict[str, Any]:
    return {**{k: goal.get(k) for k in PUBLIC_KEYS}, "ownerId": goal.get("senderId") or goal.get("ownerId")}


def goal_message_id(goal: Mapping[str, Any]) -> str:
    return f"{GOAL_MESSAGE_PREFIX}{str(goal.get('commandId') or 'x')[:12]}-t{int(goal.get('turnsUsed') or 0)}"


class NativeGoals:
    """Runs the adapter in Hermes' venv, one action per process."""

    def __init__(self, *, python: str, checkout: Path, profile_home: Path, timeout_s: float = 120.0,
                 adapter: Path = ADAPTER) -> None:
        self._python, self._checkout, self._home = python, Path(checkout), Path(profile_home)
        self._timeout, self._adapter = timeout_s, adapter

    async def __call__(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        env = {**os.environ, "PYTHONPATH": str(self._checkout), "HERMES_HOME": str(self._home),
               "HERMES_DISABLE_LAZY_INSTALLS": "1"}
        cwd = str(self._checkout) if self._checkout.is_dir() else None
        proc = await asyncio.create_subprocess_exec(
            self._python, str(self._adapter), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env, cwd=cwd)
        try:
            out, _err = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode()), self._timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise NativeGoalError("native goal adapter timed out") from None
        try:  # the adapter may log before its final JSON line
            data = json.loads(out.decode("utf-8", "replace").strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise NativeGoalError("native Hermes goal adapter failed; check HERMES_PYTHON/HERMES_CHECKOUT") from None
        if proc.returncode or data.get("status") == "unavailable":
            raise NativeGoalError(str(data.get("message") or "native objective unavailable"))
        return data


class Objectives:
    """The objective of one agent (state key ``objective``)."""

    def __init__(self, *, request: Callable[..., Awaitable[Any]], data: dict[str, Any],
                 save: Callable[[], Awaitable[None]], agent_id: str, native: Callable[[Mapping[str, Any]], Awaitable[dict]],
                 session_for: Callable[[str], Optional[str]], submit_step: Callable[[dict[str, Any]], bool],
                 budget_ok: Callable[[], Awaitable[bool]], thread_busy: Callable[[str], bool],
                 logger: Optional[logging.Logger] = None) -> None:
        self._request, self._data, self._save = request, data, save
        self._agent_id = agent_id
        self._native = native
        self._session_for, self._submit, self._budget_ok, self._busy = session_for, submit_step, budget_ok, thread_busy
        self._log = logger or logging.getLogger("emperor_bridge.goals")
        self._lock = asyncio.Lock()

    @property
    def goal(self) -> Optional[dict[str, Any]]:
        goal = self._data.get("objective")
        return goal if isinstance(goal, dict) else None

    async def _ack(self, command_id: str, goal: Mapping[str, Any]) -> None:
        try:
            await self._request("POST", "/agents/goals", {"commandId": command_id, "goal": public_state(goal)},
                                {"agentId": self._agent_id})
        except Exception as exc:
            self._log.info("goal acknowledgment pending: %s", exc)

    async def _publish(self, goal: Mapping[str, Any]) -> None:
        await self._ack(str(goal.get("commandId")), goal)

    # ---- commands --------------------------------------------------------------------------

    async def process_commands(self, *, active_threads: tuple[str, ...] = ()) -> bool:
        """Apply queued goal commands. True when one paused/cleared an objective mid-step."""
        try:
            payload = await self._request("GET", "/agents/goals", None, {"agentId": self._agent_id})
            self._data["goalTransportReady"] = True
        except Exception:
            self._data["goalTransportReady"] = False  # older servers keep plain messaging
            return False
        interrupted = False
        async with self._lock:
            for command in (payload or {}).get("commands") or []:
                interrupted = await self._apply(command, active_threads) or interrupted
        return interrupted

    async def _apply(self, command: Mapping[str, Any], active_threads: tuple[str, ...]) -> bool:
        meta = command.get("metadataJson") or {}
        request = meta.get("runtimeGoalRequest") or {} if isinstance(meta, Mapping) else {}
        action, current, command_id = request.get("action"), self.goal, str(command.get("id"))
        busy = bool(current) and current.get("threadId") in active_threads
        if current and command_id == current.get("commandId"):  # replayed: acknowledge again only
            await self._publish(current)
            return busy and current.get("status") in ("paused", "cleared")
        if busy and action in ("start", "resume"):
            await self._ack(command_id, {**public_state(current), "message":
                                         "Wait for current work to finish before starting or resuming an objective."})
            return False
        try:
            if action == "start" and current and current.get("status") == "active":
                raise NativeGoalError("Pause or clear the current objective before starting another")
            if action != "start" and not current:
                raise NativeGoalError("No persistent objective is set")
            if action == "start":
                thread_id = str(command.get("threadId") or "")
                session = self._session_for(thread_id) or f"emperor-goal-{uuid.uuid4()}"
                result = await self._native({"action": "start", "sessionId": session,
                                             "objective": request.get("objective", ""),
                                             "maxTurns": request.get("maxTurns", 20)})
                goal = {**result, "commandId": command_id, "sourceMessageId": command_id, "threadId": thread_id,
                        "senderId": command.get("senderId"), "firstTurn": True}
            else:
                result = await self._native({"action": action, "sessionId": current["sessionId"]})
                goal = {**current, **result, "commandId": command_id}
                if action == "resume":
                    goal["prompt"] = result.get("prompt") or result.get("objective", "")
            self._data["objective"] = goal
            await self._save()  # durable before acknowledging, pause/clear included
            await self._publish(goal)
            return busy and action in ("pause", "clear")
        except Exception as exc:
            if current and action in ("pause", "clear"):
                current.update(status="paused" if action == "pause" else "cleared", shouldContinue=False,
                               commandId=command_id,
                               message=f"Objective {action} applied; native state unavailable: {exc}"[:1000])
                await self._save()
                await self._publish(current)
                return busy
            await self._ack(command_id, {**(public_state(current) if current else {"status": "unavailable"}),
                                         "message": str(exc)[:1000]})
            return False

    async def pause_all(self, reason: str = "Objective paused by Stop or Replace.") -> None:
        goal = self.goal
        if not goal or goal.get("status") != "active":
            return
        goal.update(status="paused", message=reason, shouldContinue=False)
        await self._save()  # the local pause holds even if the native runtime cannot load its state
        try:
            await self._native({"action": "pause", "sessionId": goal["sessionId"]})
        except Exception as exc:
            self._log.info("native goal pause: %s", exc)
        await self._publish(goal)

    # ---- steps -----------------------------------------------------------------------------

    def _session_args(self, goal: Mapping[str, Any]) -> dict[str, Any]:
        current = self._session_for(str(goal.get("threadId") or "")) or goal["sessionId"]
        return {"sessionId": current, "previousSession": goal["sessionId"]}

    async def _evaluate(self, goal: dict[str, Any], response: str) -> None:
        result = await self._native({"action": "evaluate", **self._session_args(goal), "response": response})
        goal.update(result, firstTurn=False)
        goal.pop("pendingEvaluation", None)
        self._data["objective"] = goal
        await self._save()
        await self._publish(goal)

    async def run_next(self) -> Optional[str]:
        """Advance the active objective by at most one decision. Returns the queued step id, if any."""
        goal = self.goal
        if not self._data.get("goalTransportReady") or not goal or goal.get("status") != "active" \
                or goal.get("stepQueued") or self._busy(str(goal.get("threadId") or "")):
            return None
        async with self._lock:
            if not await self._budget_ok():
                await self.pause_all("Objective paused: agent or company budget is unavailable.")
                return None
            try:
                status = await self._native({"action": "status", **self._session_args(goal)})
                goal["sessionId"] = status.get("sessionId") or goal["sessionId"]
                if status.get("status") != "active" or status.get("waiting"):
                    goal.update(status)
                    await self._save()
                    await self._publish(goal)
                    return None
                if goal.get("pendingEvaluation"):
                    await self._evaluate(goal, str(goal["pendingEvaluation"]))
                    return None
                text = goal["objective"] if goal.get("firstTurn") else goal.get("prompt") or status.get("prompt")
                if not text:
                    raise NativeGoalError("Native objective has no continuation prompt")
                step = {"id": goal_message_id(goal), "threadId": goal["threadId"], "threadType": "direct",
                        "senderType": "human", "senderId": goal.get("senderId"), "text": text, "goalTurn": True,
                        "replyToMessageId": goal.get("sourceMessageId") or goal.get("commandId")}
                if not self._submit(step):
                    return None
                goal["stepQueued"] = step["id"]
                await self._save()
                return step["id"]
            except Exception as exc:
                goal.update(status="paused", message=f"Objective paused: {exc}"[:1000], shouldContinue=False)
                await self._save()
                await self._publish(goal)
                return None

    async def after_step(self, step_id: str, reply: Optional[str], completed: bool) -> None:
        """An objective step settled. A completed reply is judged; anything else pauses."""
        goal = self.goal
        if not goal or goal.get("stepQueued") != step_id:
            return
        goal.pop("stepQueued", None)
        if not completed:
            goal.update(status="paused", shouldContinue=False, message="Objective paused: the step did not complete.")
            await self._save()
            await self._publish(goal)
            return
        goal["pendingEvaluation"] = (reply or "")[:24000]
        await self._save()
        await self.process_commands()  # a human may have paused during the step: never undo it
        goal = self.goal
        if not goal or goal.get("status") != "active":
            return
        if not await self._budget_ok():
            await self.pause_all("Objective paused: agent or company budget is unavailable.")
            return
        try:
            await self._evaluate(goal, str(goal["pendingEvaluation"]))
        except Exception as exc:
            goal.update(status="paused", message=f"Objective paused: {exc}"[:1000], shouldContinue=False)
            await self._save()
            await self._publish(goal)

    async def record_external_turn(self, thread_id: str, reply: str) -> None:
        """A normal reply in the objective's thread also consumes (and is judged by) the goal."""
        goal = self.goal
        if not goal or goal.get("status") != "active" or goal.get("threadId") != thread_id:
            return
        if not await self._budget_ok():
            await self.pause_all("Objective paused: agent or company budget is unavailable.")
            return
        try:
            await self._evaluate(goal, reply)
        except Exception as exc:
            goal.update(status="paused", message=f"Objective paused: {exc}"[:1000])
            await self._save()
