"""Bridge process: hosts 1..n AgentRuntimes in one asyncio loop (design 5.1, D21).

Per agent the wiring is GatewayLink -> SessionManager -> TurnRunner -> Scheduler(dispatch) ->
Compactor(is_busy=runner.is_running) -> ControlPlane(on_kill=pause objectives). Per turn:
flush the run's events, deliver the reply (outbox first), finish the ledger, compact while the run
is still open, close the run. A restart-lost tool-free turn is retried once (`batch.retry()`).

SIGTERM: stop dispatch, then drain <= 30 s (standalone/shared) or stop the supervised gateway at
once (managed: its own drain governs in-flight turns; the next boot recovers them, D15).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
import time
import uuid
from typing import Any, Optional

from . import intake, recovery, supervisor as supervisor_mod
from .compaction import Compactor
from .config import AgentConfig, ConfigError, HostConfig, host_fingerprint, load_agent_configs
from .context import ContextBuilder, compose_api_text, parse_server_capabilities
from .controls import ControlPlane
from .emperor_api import (EmperorClient, Transport, bound_retries, clear_retry, is_environment_failure, parse_iso,
                          resolve_agent_id, sender_type_of, split_control_commands, thread_type_of)
from .events import EventSink
from .gateway.client import GatewayLink
from .gateway.discovery import GatewayDiscovery
from .gateway.sessions import SessionManager
from .goals import GOAL_MESSAGE_PREFIX, NativeGoals, Objectives
from .health import registration_body, standby_reason, write_health
from .interfaces import (AdmissionConflict, AgentIdentity, CompactionConfig, EventSinkConfig, GatewayIncompatible,
                         GatewayUnavailable, RpcTimeout, SchedulerConfig, Topology, Turn, TurnAuthor,
                         TurnConfig, TurnOutcome, TurnResult)
from .ledger import BudgetGate, RunLedger, abandoned_payload, finish_payload, flush_usage, start_payload
from .log import TimedLink, agent_logger, format_turn_delivery, setup_logging
from .outbox import Outbox, ReplyDesk
from .scheduler import InboundMessage, Scheduler, TurnBatch
from .state import BridgeState, state_path_for, utc_now_iso
from .turns import TurnRunner
from .version import BRIDGE_VERSION

DRAIN_S = 30.0
COLD_START_LOOKBACK_S = 120
STANDBY_REREGISTER_S = 30.0
HEALTH_INTERVAL_S = 15.0


class AgentRuntime:
    """One Emperor agent: its client, state, gateway link, scheduler and loops. No module globals."""

    def __init__(self, cfg: AgentConfig, host: HostConfig) -> None:
        self.cfg, self.host = cfg, host
        self.log = agent_logger(cfg.profile_name)
        self.client = EmperorClient(cfg.api_url, cfg.api_token, agent_id=cfg.agent_id, logger=self.log, transport=Transport(
            cfg.transport_attempts, cfg.transport_backoff_s, cfg.transport_backoff_max_s, cfg.transport_budget_s))
        self.started_at = time.time()
        self.health: dict[str, Any] = {"registered": False, "duplicateRuntime": None, "sharedHostOk": None,
                                       "gatewayTopology": cfg.topology.value, "lastError": None}
        self.standby_reason: Optional[str] = None
        self._tasks: list[asyncio.Task] = []
        self._accepted: dict[str, str] = {}  # queued or running message id -> thread id
        self._stopping = False
        self._health_interval_s = HEALTH_INTERVAL_S

    # ---- boot ------------------------------------------------------------------------------

    async def prepare(self) -> None:
        cfg = self.cfg
        agent_id = cfg.agent_id or await resolve_agent_id(self.client, cfg.agent_name, cfg.agent_role)
        self.client.agent_id = agent_id
        self.state = BridgeState.load(state_path_for(cfg.profile_home), legacy_path=cfg.legacy_state_path,
                                      agent_id=agent_id, runtime_id=cfg.runtime_id)
        data = self.state.data
        data["runtimeId"] = data.get("runtimeId") or f"hermes-{cfg.hostname}-{cfg.profile_name}-{uuid.uuid4().hex[:8]}"
        if not data.get("lastSeenAt"):  # cold start: do not miss what was sent just before boot
            data["lastSeenAt"] = utc_now_iso(time.time() - COLD_START_LOOKBACK_S)
        data.setdefault("dispatches", {})
        await self.state.save()
        self.identity = AgentIdentity(agent_id, cfg.agent_name, data["runtimeId"], BRIDGE_VERSION, cfg.target)
        self.outbox = Outbox(cfg.outbox_dir, retry_base_s=cfg.outbox_retry_base_s, retry_max_s=cfg.outbox_retry_max_s,
                             max_attempts=cfg.outbox_max_attempts, logger=self.log)
        self.outbox.import_legacy(cfg.legacy_outbox_dir)
        self.link_raw = GatewayLink(GatewayDiscovery(cfg.target), logger=agent_logger(cfg.profile_name, "gateway"))
        self.link = TimedLink(self.link_raw, agent_logger(cfg.profile_name, "rpc"))
        self.sink = EventSink(self.client, EventSinkConfig(flush_ms=cfg.event_flush_ms), logger=self.log)
        self.sessions = SessionManager(self.link, self.state, agent_id=agent_id, profile_home=cfg.profile_home,
                                       logger=agent_logger(cfg.profile_name, "sessions"))
        self.runner = TurnRunner(
            self.link, self.sessions, self.state, self.sink, agent=self.identity,
            config=TurnConfig(idle_timeout_s=cfg.turn_idle_timeout_s), logger=agent_logger(cfg.profile_name, "turns"))
        self.scheduler = Scheduler(self._dispatch, SchedulerConfig(cfg.max_parallel_turns, cfg.followup_mode),
                                   logger=self.log)
        self.compactor = Compactor(self.link, self.sessions, self.sink, is_busy=self.runner.is_running,
                                   config=CompactionConfig(after_tokens=cfg.compact_after_tokens), logger=self.log)
        self.context = ContextBuilder.for_agent(self.client, cfg, agent_id, logger=self.log)
        self.budget = BudgetGate(self.client.request, agent_id, logger=self.log)
        self.ledger = RunLedger(self.client.request, capabilities=lambda: self.context.capabilities, logger=self.log,
                                agent_id=agent_id)
        self.objectives = Objectives(
            request=self.client.request, data=data, save=self.state.save, agent_id=agent_id, logger=self.log,
            native=NativeGoals(python=cfg.hermes_python, checkout=cfg.hermes_checkout, profile_home=cfg.profile_home),
            session_for=lambda t: (self.sessions.get(t).session_id if self.sessions.get(t) else None),
            submit_step=self._submit_goal_step, budget_ok=self.budget.allowed,
            thread_busy=lambda t: self.scheduler.is_busy(t) or self.scheduler.has_pending(t))
        self.replies = ReplyDesk(client=self.client, outbox=self.outbox, ledger=self.ledger, data=data,
                                 save=self.state.save, agent_id=agent_id, retry=cfg, llm_model=cfg.llm_model,
                                 drop_goal_step=self._drop_goal_step, spawn=self._spawn, logger=self.log)
        self.controls = ControlPlane(self.scheduler, self.runner, self.sessions, self.client,
                                     on_kill=lambda _action: self.objectives.pause_all(),
                                     on_thread_reset=self._thread_reset, logger=self.log)
        self.write_health()

    async def start(self) -> None:
        while True:
            try:
                await self.link_raw.start()
                break
            except GatewayIncompatible as exc:  # never dispatch against it; keep reporting and retrying
                self._set_error(f"gateway incompatible: {exc}", fatal=True)
                await asyncio.sleep(30)
        self.health.pop("fatal", None)
        await self.register(boot=True)
        await self.sink.start()
        await self.context.refresh()
        for name, coro in (("sync", intake.sync_loop(self)), ("control", self._control_loop()),
                           ("housekeeping", self._housekeeping_loop()), ("health", self._health_loop())):
            self._tasks.append(asyncio.create_task(coro, name=f"{self.cfg.profile_name}-{name}"))
        # Recovery runs after the loops are up: a turn that never settles must not block
        # sync/control/housekeeping or the heartbeat (H2). Recovered threads are reserved so a
        # new message queues behind them instead of colliding.
        self._spawn(recovery.recover(self))  # a failure is logged by the done-callback (review H2)
        self.log.info("started agent=%s agentId=%s runtime=%s topology=%s hermes=%s", self.cfg.agent_name,
                      self.identity.agent_id, self.identity.runtime_id, self.cfg.topology.value,
                      self.link.identity.code_version if self.link.identity else "?")

    # ---- registration, standby, health -----------------------------------------------------

    async def register(self, *, boot: bool = False) -> None:
        body = registration_body(runtime_id=self.identity.runtime_id, agent_id=self.identity.agent_id,
                                 hostname=self.cfg.hostname, topology=self.cfg.topology, identity=self.link.identity,
                                 started_at=self.started_at, fingerprint=host_fingerprint())
        delay, deadline = 5.0, time.monotonic() + 900
        while True:
            try:
                response = await self.client.register(body)
                break
            except Exception as exc:
                self._set_error(f"register failed: {exc}")
                if not boot or time.monotonic() > deadline:
                    return  # a refresh keeps the last capabilities
                await asyncio.sleep(delay)
                delay = min(60.0, delay * 2)
        response = response if isinstance(response, dict) else {}
        caps, guide = parse_server_capabilities(response)
        self.context.set_capabilities(caps, guide)
        self.health.update(registered=True, duplicateRuntime=response.get("duplicateRuntime"),
                           sharedHostOk=response.get("sharedHostOk"), bridge=response.get("bridge"))
        reason = standby_reason(response, allow_duplicate=self.cfg.allow_duplicate_runtime, topology=self.cfg.topology)
        self._set_standby(reason)
        self.write_health()

    def _set_standby(self, reason: Optional[str]) -> None:
        if reason and reason != self.standby_reason:
            self.log.error("standby: %s; not dispatching", reason)
            self.scheduler.pause()
        elif not reason and self.standby_reason:
            self.log.info("standby cleared; dispatching again")
            self.scheduler.resume()
        self.standby_reason = reason
        self.health["standby"] = reason

    def _set_error(self, message: str, *, fatal: bool = False) -> None:
        self.log.warning("%s", message)
        self.health["lastError"] = message[:300]
        if fatal:
            self.health["fatal"] = True
        self.write_health()

    def write_health(self) -> None:
        ident = self.link.identity if hasattr(self, "link") else None
        fatal = getattr(getattr(self, "link_raw", None), "fatal_error", None)
        if fatal:
            self.health.update(fatal=True, lastError=f"gateway: {fatal}"[:300])
        sched = getattr(self, "scheduler", None)
        write_health(self.cfg.health_path, {
            **self.health, "agentId": getattr(getattr(self, "identity", None), "agent_id", self.cfg.agent_id),
            "runtimeId": getattr(getattr(self, "identity", None), "runtime_id", None), "profile": self.cfg.profile_name,
            "gatewayReady": bool(self.link.connected) if hasattr(self, "link") else False,
            "hermesVersion": ident.code_version if ident else None,
            "inFlight": len(sched.in_flight()) if sched else 0, "queued": sched.queued_count() if sched else 0})

    # ---- intake ----------------------------------------------------------------------------

    def _submit_goal_step(self, step: dict[str, Any]) -> bool:
        if self.standby_reason:
            return False
        accepted = self.scheduler.submit(InboundMessage(step["id"], step["threadId"], raw=step)).accepted
        if accepted:
            self._accepted[step["id"]] = step["threadId"]
        return accepted

    # ---- dispatch (Scheduler callback) -----------------------------------------------------

    async def _dispatch(self, batch: TurnBatch) -> Optional[TurnBatch]:
        follow_up: Optional[TurnBatch] = None
        try:
            follow_up = await self._dispatch_batch(batch)
            return follow_up
        finally:
            if follow_up is None:  # a retry keeps running in the same slot: keep tracking its messages
                for message in batch.messages:
                    self._accepted.pop(message.id, None)

    async def _thread_reset(self, thread_id: str) -> None:
        """A thread-scoped replace: pause the objective only when it lives in that thread."""
        goal = self.objectives.goal
        if goal and goal.get("threadId") == thread_id:
            await self.objectives.pause_all("Objective paused by Replace in its thread.")

    def _drop_goal_step(self) -> None:
        """A queued objective step that will not run now; the objective loop queues it again."""
        if self.objectives.goal:
            self.objectives.goal.pop("stepQueued", None)

    async def _dispatch_batch(self, batch: TurnBatch) -> Optional[TurnBatch]:
        goal = [m for m in batch.messages if m.raw.get("goalTurn")]
        messages = [m for m in batch.messages if not m.raw.get("goalTurn")] or goal
        if goal and messages is not goal:
            self._drop_goal_step()
            batch = TurnBatch(batch.thread_id, tuple(messages), batch.attempt, batch.position, batch.queued_at)
        raws = [dict(m.raw) for m in batch.messages]
        trigger = raws[-1]
        if not await self.budget.allowed():
            await self.replies.defer(raws, environment=True, reason="budget unavailable")
            return None
        turn, task_hash = await self._build_turn(batch, raws, is_goal=bool(goal) and messages is goal)
        data = self.state.data
        data["dispatches"][turn.submission_id] = {"threadId": batch.thread_id, "attempt": batch.attempt,
                                                  "messages": raws, "dispatchedAt": time.time()}
        await self.state.save()
        if turn.trigger_kind == "message":
            self._spawn(self.replies.announce(trigger, turn))
        self._spawn(self.ledger.start(start_payload(turn, agent_id=self.identity.agent_id,
                                                     runtime_id=self.identity.runtime_id,
                                                     bridge_version=BRIDGE_VERSION, started_at=time.time())))
        try:
            result = await self.runner.run(turn)
        except asyncio.CancelledError:
            raise
        except AdmissionConflict as exc:  # M1: never defer the same submission id again
            data["dispatches"].pop(turn.submission_id, None)
            self.state.drop_turn(turn.submission_id)
            await self.ledger.finish(turn.run_id, abandoned_payload("cancelled", "admission_conflict"))
            if batch.attempt < self.cfg.max_retry_attempts:
                self.log.warning("%s; resubmitting as -r%d", exc, batch.attempt + 1)
                return batch.retry()
            await self.replies.defer(raws, environment=False, reason="admission_conflict", error=exc)
            return None
        except Exception as exc:  # never admitted: nothing ran, nothing was spent
            data["dispatches"].pop(turn.submission_id, None)
            gateway = isinstance(exc, (GatewayUnavailable, RpcTimeout))
            if await self.replies.defer(raws, environment=gateway or is_environment_failure(exc),
                                        reason=type(exc).__name__, error=exc, gateway=gateway):
                await self.ledger.finish(turn.run_id, abandoned_payload("failed", f"not_admitted: {type(exc).__name__}"))
            return None  # a deferred retry reuses this submission id, and so this run
        return await self._settle(batch, turn, raws, result, task_hash=task_hash)

    async def _build_turn(self, batch: TurnBatch, raws: list[dict[str, Any]], *,
                          is_goal: bool) -> tuple[Turn, Optional[str]]:
        trigger = raws[-1]
        thread_id = batch.thread_id
        detail = self.context.thread_details.get(thread_id) or {}
        thread_type = thread_type_of(trigger) or str(detail.get("type") or "") or "direct"
        await self.context.refresh()
        previous = self.sessions.get(thread_id)
        policy = self.context.policy(thread_id, thread_type, previous.create_params if previous else None)
        first_turn = self.sessions.plan(thread_id, policy).session_id is None
        delta, task_hash = await self.context.delta(
            trigger, last_task_hash=None if first_turn or previous is None else previous.last_task_set_hash,
            coalesced=len(raws), goal_turn=is_goal)
        seed = "" if is_goal or not first_turn else await self.context.seed(thread_id, {str(r.get("id")) for r in raws})
        text, api_text = compose_api_text(raws, delta, seed)
        sender_id = str(trigger.get("senderId") or sender_type_of(trigger) or "human")
        author = TurnAuthor(id=sender_id, name=str(trigger.get("senderName") or sender_id)[:80],
                            is_bot=sender_type_of(trigger) == "agent")
        if is_goal:
            return Turn(thread_id=thread_id, trigger_id=str(trigger["id"]), text=text, api_text=api_text, policy=policy,
                        author=author, attempt=batch.attempt, agent_id=self.identity.agent_id, trigger_kind="objective",
                        queue_position=batch.position, queued_at=batch.queued_at), task_hash
        return Turn(thread_id=thread_id, trigger_id=str(trigger["id"]), text=text, api_text=api_text, policy=policy,
                    message_ids=tuple(str(r["id"]) for r in raws), author=author, attempt=batch.attempt,
                    agent_id=self.identity.agent_id, queue_position=batch.position, queued_at=batch.queued_at), task_hash

    async def _settle(self, batch: TurnBatch, turn: Turn, raws: list[dict[str, Any]], result: TurnResult,
                      *, task_hash: Optional[str] = None) -> Optional[TurnBatch]:
        trigger, data = raws[-1], self.state.data
        dispatched_at = float((data["dispatches"].get(turn.submission_id) or {}).get("dispatchedAt") or time.time())
        await self.sink.flush(turn.run_id)  # events land before the reply and the ledger finish
        if result.retry_advised:
            await self.ledger.finish(turn.run_id, finish_payload(result, events_dropped=self.sink.dropped(turn.run_id)))
            self._close(turn)
            self.log.info("turn %s lost to a gateway restart before any tool ran; retrying once", turn.submission_id)
            return batch.retry()
        finish = finish_payload(result, events_dropped=self.sink.dropped(turn.run_id),
                                compactions=self.compactor.compactions.get(turn.thread_id))
        if self.standby_reason:  # standby must never answer (LOW-1): park a reply, post no notice
            if result.outcome is TurnOutcome.COMPLETED:
                await self.replies.park(turn, raws, result, finish)
            else:
                await self.ledger.finish(turn.run_id, finish)
            reply_id, parked = None, True
        else:
            reply_id, parked = await self.replies.deliver(turn, raws, result, finish)
        await self._after_turn(turn, raws, result)
        rec = self.sessions.get(turn.thread_id)
        if rec is not None and task_hash is not None:  # the next delta reports tasks only when this set changes
            rec.last_task_set_hash = task_hash
            self.sessions.persist(rec)
        # M5, D13/S-17: compaction runs in the background, after the slot (and the parallel cap) is
        # released; a follow-up on this thread is dispatched at once and queues inside Hermes behind
        # the compress. The run stays open until its compaction events are flushed.
        self._close(turn, keep_run=rec is not None)
        if rec is not None:
            self._spawn(self._compact_after(turn, rec, result))
        self.log.info("%s", format_turn_delivery(
            str(trigger.get("id")), created_at=parse_iso(trigger.get("createdAt")), dispatched_at=dispatched_at,
            delivered_at=time.time(), outcome=result.outcome.value, queue_ms=result.queue_ms,
            first_token_ms=result.first_token_ms, api_calls=result.usage.api_calls, tool_calls=result.tool_calls,
            restart_path=result.restart_path, parked=parked))
        return None

    async def _compact_after(self, turn: Turn, rec: Any, result: TurnResult) -> None:
        try:
            await self.compactor.maybe_compact(rec, context_used=result.context_used, run_id=turn.run_id)
        finally:
            await self.sink.flush(turn.run_id)
            self.sink.close_run(turn.run_id)

    def _close(self, turn: Turn, *, keep_run: bool = False) -> None:
        if not keep_run:
            self.sink.close_run(turn.run_id)
        self.state.drop_turn(turn.submission_id)
        self.state.data["dispatches"].pop(turn.submission_id, None)
        self.state.mark_dirty()
        self._spawn(self.state.save())

    async def _after_turn(self, turn: Turn, raws: list[dict[str, Any]], result: TurnResult) -> None:
        trigger = raws[-1]
        try:
            if trigger.get("goalTurn"):
                await self.objectives.after_step(str(trigger["id"]), result.final_text,
                                                 result.outcome is TurnOutcome.COMPLETED)
            elif result.outcome is TurnOutcome.COMPLETED:
                await self.objectives.record_external_turn(turn.thread_id, result.final_text)
        except Exception as exc:  # the reply is delivered: objective bookkeeping never requeues it
            self.log.warning("objective bookkeeping after %s failed: %s", trigger.get("id"), exc)

    def _spawn(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.append(task)
        task.add_done_callback(self._reap)

    def _reap(self, task: asyncio.Task) -> None:
        if task in self._tasks:
            self._tasks.remove(task)
        if not task.cancelled() and task.exception() is not None:
            self.log.warning("background task failed: %r", task.exception())

    # ---- recovery, controls, housekeeping --------------------------------------------------

    async def _control_loop(self) -> None:
        while not self._stopping:
            busy = bool(self._accepted)
            try:
                payload = await self.client.control()
                await self._apply_controls(payload)
                for message_id in [m for m in self._accepted if not m.startswith(GOAL_MESSAGE_PREFIX)][:10]:
                    if (await self.client.control(message_id)).get("cancelled") is True:
                        await self._stop_message(message_id)
            except Exception as exc:
                self.log.debug("control poll failed: %s", exc)
            await asyncio.sleep(1.0 if busy else 4.0)

    async def _apply_controls(self, payload: Any) -> None:
        stops, kills = split_control_commands(payload)
        for command in stops:  # a per-message stop command
            await self._stop_message(str(command["messageId"]))
            with contextlib.suppress(Exception):
                await self.client.ack_control_command(str(command["id"]))
        if kills:
            outcome = await self.controls.apply(kills)
            for message_id in outcome.dropped_messages:
                self._accepted.pop(message_id, None)
                clear_retry(self.state.data, message_id)  # M2: never re-fetch a killed message
            if outcome.dropped_messages:
                self.state.mark_dirty()

    async def _stop_message(self, message_id: str) -> None:
        if await self.controls.stop_message(message_id):
            self.log.info("operator stopped message %s", message_id)
            if self.runner.thread_for_message(message_id) is None:  # it was only queued: gone now
                self._accepted.pop(message_id, None)
            clear_retry(self.state.data, message_id)  # M2: the inflight retry entry dies with the stop
            self.state.mark_dirty()

    async def _housekeeping_loop(self) -> None:
        last = {"heartbeat": 0.0, "register": time.monotonic(), "outbox": 0.0, "goals": 0.0,
                "retries": 0.0, "prune": 0.0, "archive": 0.0}
        while not self._stopping:
            now = time.monotonic()
            try:
                if now - last["heartbeat"] >= 60:
                    last["heartbeat"] = now
                    await self.client.heartbeat(len(self.scheduler.in_flight()), self.identity.runtime_id)
                refresh = STANDBY_REREGISTER_S if self.standby_reason else self.cfg.capability_refresh_s
                if refresh and now - last["register"] >= refresh:
                    last["register"] = now
                    await self.register()
                await self.ledger.retry_pending()
                await flush_usage(self.client.request, self.replies.pending_usage)
                if now - last["outbox"] >= 15 and not self.standby_reason:
                    last["outbox"] = now
                    await self.outbox.flush(self.replies.send, self.replies.on_delivered, self.replies.on_given_up)
                if now - last["goals"] >= 5 and not self.standby_reason:
                    last["goals"] = now
                    await self.objectives.process_commands(active_threads=tuple(self.scheduler.in_flight()))
                    await self.objectives.run_next()
                if now - last["retries"] >= 300:
                    last["retries"] = now
                    if bound_retries(self.state.data):
                        self.state.mark_dirty()
                if now - last["prune"] >= 3600:  # M8: idle thread records and retired sessions
                    last["prune"] = now
                    if self.state.prune_threads(keep=set(self.scheduler.in_flight())):
                        self.state.mark_dirty()
                if self.sessions.retired() and now - last["archive"] >= 60:
                    last["archive"] = now
                    await self.sessions.close_retired()
                await self.state.save_if_dirty()
            except Exception as exc:
                self.log.warning("housekeeping step failed: %s", exc)
            await asyncio.sleep(2.0)

    async def _health_loop(self) -> None:
        """Write health.json on its own cadence, independent of housekeeping (M4): a slow outbox
        flush or goal subprocess can never make health go stale beyond HEALTH_INTERVAL_S."""
        while not self._stopping:
            try:
                self.write_health()
            except Exception as exc:
                self.log.warning("health write failed: %s", exc)
            await asyncio.sleep(self._health_interval_s)

    # ---- shutdown --------------------------------------------------------------------------

    async def stop_dispatch(self) -> None:
        self._stopping = True
        self.scheduler.pause()
        for task in list(self._tasks):
            if task.get_name().startswith(f"{self.cfg.profile_name}-"):
                task.cancel()

    async def drain(self, timeout: float) -> bool:
        return await self.scheduler.drain(timeout)

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.sink.stop(final_flush=True), 10)
        with contextlib.suppress(Exception):
            await self.state.save()
        with contextlib.suppress(Exception):
            self.client.close()
        with contextlib.suppress(Exception):
            await self.link_raw.close()
        self.health["stoppedAt"] = time.time()
        self.write_health()


class BridgeHost:
    """The process: config, logging, optional managed supervisor, n AgentRuntimes, signals."""

    def __init__(self, host: HostConfig) -> None:
        self.host = host
        self.log = logging.getLogger("emperor_bridge.host")
        self.runtimes: list[AgentRuntime] = []
        self.supervisor: Optional[supervisor_mod.GatewaySupervisor] = None
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self) -> int:
        configs = load_agent_configs(self.host, self.log)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, self.request_stop)
        sup_task: Optional[asyncio.Task] = None
        if self.host.topology is Topology.MANAGED:
            self.supervisor = supervisor_mod.GatewaySupervisor(supervisor_mod.SupervisorConfig.from_env(dict(self.host.env)))
            await self.supervisor.start()
            sup_task = asyncio.create_task(self.supervisor.run(), name="gateway-supervisor")
        self.runtimes = [AgentRuntime(cfg, self.host) for cfg in configs]
        starters = [asyncio.create_task(self._boot(rt)) for rt in self.runtimes]
        waits = [asyncio.create_task(self._stop.wait())] + ([sup_task] if sup_task else [])
        done, _ = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        rc = 0
        if sup_task in done and sup_task.exception() is not None:
            self.log.error("gateway supervisor gave up: %s", sup_task.exception())
            rc = 1
        await self.shutdown(starters)
        return rc

    async def _boot(self, runtime: AgentRuntime) -> None:
        try:
            await runtime.prepare()
            await runtime.start()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            runtime.log.exception("agent %s failed to start: %s", runtime.cfg.profile_name, exc)
            runtime.health.update(fatal=True, lastError=f"start failed: {exc}"[:300])
            with contextlib.suppress(Exception):
                runtime.write_health()

    async def shutdown(self, starters: list[asyncio.Task]) -> None:
        self.log.info("stopping: dispatch off")
        for task in starters:
            task.cancel()
        ready = [rt for rt in self.runtimes if hasattr(rt, "scheduler")]
        for rt in ready:
            await rt.stop_dispatch()
        if self.supervisor is not None:  # managed: the gateway drains its own turns (D3, W6)
            await self.supervisor.stop("bridge stopping")
        else:
            drained = await asyncio.gather(*(rt.drain(DRAIN_S) for rt in ready), return_exceptions=True)
            if not all(d is True for d in drained):
                self.log.warning("drain timed out after %.0f s; open turns are recovered on the next start", DRAIN_S)
        await asyncio.gather(*(rt.close() for rt in ready), return_exceptions=True)
        self.log.info("stopped")


def run(profiles: Optional[str] = None) -> int:
    try:
        host = HostConfig.from_env(profiles=profiles)
    except ConfigError as exc:
        setup_logging()
        logging.getLogger("emperor_bridge").error("configuration error: %s", exc)
        return 2
    setup_logging(host.log_level)
    try:
        return asyncio.run(BridgeHost(host).run())
    except ConfigError as exc:
        logging.getLogger("emperor_bridge").error("configuration error: %s", exc)
        return 2

