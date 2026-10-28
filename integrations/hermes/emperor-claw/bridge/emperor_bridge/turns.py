"""One turn: turn file -> prompt.submit -> events -> message.complete -> prompt.receipt (D5-D16).

`TurnRunner.run` returns a TurnResult once the admission is settled. Errors raised before Hermes
admitted the prompt propagate (nothing ran; the caller may retry). After admission `run` always
returns a result: completed, cancelled (our stop), timeout (idle), or failed. Restart path
(D15): SIGTERM-interrupted or SIGKILL-`unknown` turns (after `prompt.resolve_unknown`) settle as
failed/`runtime_restart`, with `retry_advised` only when no tool ran (`sawTool`, persisted at the
first `tool.start`) and this was the first attempt.
"""
from __future__ import annotations

from types import MappingProxyType

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

from . import turn_context
from .events import EventMapper
from .gateway.sessions import SessionManager
from .interfaces import (AdmissionConflict, AgentIdentity, EmperorEvent, EventSinkPort, GatewayEvent,
                         GatewayLinkPort, GatewayUnavailable, RecoveredTurn, RpcError, RpcTimeout, SessionPolicy,
                         ThreadSession, Turn, TurnConfig, TurnOutcome, TurnResult, TurnStore, UsageLedger)

SUBMIT_RETRY_WINDOW_S = 120.0
_TERMINAL_KIND = MappingProxyType({TurnOutcome.COMPLETED: "turn.completed", TurnOutcome.CANCELLED: "turn.interrupted",
                  TurnOutcome.TIMEOUT: "turn.interrupted", TurnOutcome.FAILED: "turn.failed"})


def _iso(ts: Optional[float] = None) -> str:
    moment = datetime.fromtimestamp(ts if ts is not None else time.time(), timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def usage_from_receipt(receipt: Mapping[str, Any], complete: Mapping[str, Any]) -> UsageLedger:
    """D16: ledger fields from `prompt.receipt.result`; fall back to receipt.usage / complete.usage."""
    result = receipt.get("result") if isinstance(receipt.get("result"), Mapping) else {}
    short = receipt.get("usage") if isinstance(receipt.get("usage"), Mapping) else {}
    live = complete.get("usage") if isinstance(complete.get("usage"), Mapping) else {}

    def pick(*values: Any) -> Any:
        return next((v for v in values if v is not None), None)

    return UsageLedger(
        input_tokens=pick(result.get("input_tokens"), short.get("input_tokens"), live.get("input")),
        output_tokens=pick(result.get("output_tokens"), short.get("output_tokens"), live.get("output")),
        cache_read_tokens=result.get("cache_read_tokens"), cache_write_tokens=result.get("cache_write_tokens"),
        reasoning_tokens=pick(result.get("reasoning_tokens"), live.get("reasoning")),
        api_calls=pick(result.get("api_calls"), live.get("calls")),
        model=pick(result.get("model"), live.get("model")), provider=result.get("provider"),
        cost_status=result.get("cost_status"), estimated_cost_usd=result.get("estimated_cost_usd"))


@dataclass
class _Tracker:
    turn: Turn
    session: ThreadSession
    record: dict[str, Any]
    mapper: EventMapper
    started_mono: float
    admission_id: Optional[str] = None
    execution_generation: Optional[int] = None
    buffered: list[GatewayEvent] = field(default_factory=list)
    complete: Optional[GatewayEvent] = None
    settled_receipt: Optional[Mapping[str, Any]] = None
    done: asyncio.Event = field(default_factory=asyncio.Event)
    last_activity: float = 0.0
    interrupt_reason: Optional[str] = None
    interrupt_sent_at: Optional[float] = None
    restart_seen: bool = False
    restart_path: bool = False


class TurnRunner:
    def __init__(self, link: GatewayLinkPort, sessions: SessionManager, store: TurnStore, sink: EventSinkPort, *,
                 agent: AgentIdentity, config: TurnConfig = TurnConfig(), logger: Optional[logging.Logger] = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._link = link
        self._sessions = sessions
        self._store = store
        self._sink = sink
        self._agent = agent
        self._config = config
        self._log = logger or logging.getLogger("emperor_bridge.turns")
        self._clock = clock
        self._by_session: dict[str, _Tracker] = {}
        self._by_thread: dict[str, _Tracker] = {}
        self._background: set[asyncio.Task] = set()
        link.add_event_listener(self._on_event)
        sessions.add_resync_listener(self._on_resync)

    # ---- public ---------------------------------------------------------------------------

    def is_running(self, thread_id: str) -> bool:
        return thread_id in self._by_thread

    def active_threads(self) -> list[str]:
        return list(self._by_thread)

    def thread_for_message(self, message_id: str) -> Optional[str]:
        for thread_id, tracker in self._by_thread.items():
            if message_id in tracker.turn.message_ids or message_id == tracker.turn.trigger_id:
                return thread_id
        return None

    def run_header(self, turn: Turn, started_at: Optional[str] = None) -> dict[str, Any]:
        header = {"id": turn.run_id, "agentId": self._agent.agent_id, "runtimeId": self._agent.runtime_id,
                  "runtimeKind": "hermes", "bridgeVersion": self._agent.bridge_version,
                  "triggerKind": turn.trigger_kind, "threadId": turn.thread_id, "startedAt": started_at or _iso()}
        if turn.trigger_kind == "message" and turn.message_ids:
            header["triggerMessageId"] = turn.message_ids[-1]
        return header

    async def run(self, turn: Turn) -> TurnResult:
        if turn.thread_id in self._by_thread:
            raise RuntimeError(f"thread {turn.thread_id} already has a turn in flight")
        started_wall = time.time()
        rec = await self._sessions.ensure(turn.thread_id, turn.policy)
        record = {"runId": turn.run_id, "threadId": turn.thread_id, "messageIds": list(turn.message_ids),
                  "triggerId": turn.trigger_id, "attempt": turn.attempt, "triggerKind": turn.trigger_kind,
                  "admissionId": None, "executionGeneration": None, "status": "submitted",
                  "nextEventSeq": 0, "sawTool": False, "startedAt": _iso(started_wall),
                  "sessionGeneration": rec.generation}
        prior = self._store.get_turn(turn.submission_id)
        if prior and prior.get("status") == "settled":
            raise AdmissionConflict(f"a settled admission already exists for {turn.submission_id}")
        if prior:  # exact resubmit after a bridge crash: keep the persisted progress
            record.update({k: prior[k] for k in ("admissionId", "nextEventSeq", "sawTool", "startedAt") if k in prior})
        self._sink.open_run(turn.run_id, self.run_header(turn, record["startedAt"]), next_seq=record["nextEventSeq"])
        tracker = self._track(turn, rec, record)
        position_ms = round((started_wall - turn.queued_at) * 1000) if turn.queued_at else None
        self._emit(tracker, tracker.mapper.bridge_event(
            "turn.queued", data={"position": turn.queue_position, "coalesced": len(turn.message_ids),
                                 "waitMs": position_ms}))
        self._write_turn_file(turn, rec)
        try:
            admission = await self._submit(tracker)
        except BaseException:
            self._untrack(tracker)
            turn_context.clear(self._agent.profile.profile_home, turn.thread_id, turn.submission_id)
            self._store.drop_turn(turn.submission_id)
            self._sink.close_run(turn.run_id)
            raise
        tracker.admission_id = admission["admission_id"]
        record.update(admissionId=tracker.admission_id)
        self._store.put_turn(turn.submission_id, record)
        # Drain the events that raced ahead of the submit answer before any await: from here on
        # `_on_event` processes live events directly, and a turn that completes during the save
        # (fast turn, replay after a reconnect) would otherwise drop them (message.start included).
        buffered, tracker.buffered = tracker.buffered, []
        for event in buffered:
            if event.admission_id == tracker.admission_id:
                self._process(tracker, event)
        await self._store.save()
        if admission.get("status") == "terminal" and not tracker.done.is_set():
            await self._reconcile(tracker)  # an exact resubmit of an already settled admission
        if tracker.interrupt_reason and tracker.interrupt_sent_at is None:
            await self._send_interrupt(tracker)
        return await self._wait_and_settle(tracker)

    async def interrupt(self, thread_id: str, reason: str = "stop") -> bool:
        """Stop the thread's running (or Hermes-queued) admission. True when a turn was found."""
        tracker = self._by_thread.get(thread_id)
        if tracker is None or tracker.done.is_set():
            return False
        tracker.interrupt_reason = tracker.interrupt_reason or reason
        if tracker.admission_id is not None:
            await self._send_interrupt(tracker)
        return True

    async def recover(self, records: Mapping[str, Mapping[str, Any]]) -> list[RecoveredTurn]:
        """Bridge restart: settle every persisted admission (D15). Runs them concurrently."""
        jobs = [self._recover_one(sid, dict(rec)) for sid, rec in records.items()
                if rec.get("status") in ("submitted", "running")]
        return list(await asyncio.gather(*jobs))

    # ---- submit / wait / settle -----------------------------------------------------------

    def _track(self, turn: Turn, rec: ThreadSession, record: dict[str, Any]) -> _Tracker:
        mapper = EventMapper(clock=self._clock)
        mapper.saw_tool = bool(record.get("sawTool"))
        now = self._clock()
        tracker = _Tracker(turn=turn, session=rec, record=record, mapper=mapper, started_mono=now, last_activity=now)
        self._by_session[rec.session_id or ""] = tracker
        self._by_thread[turn.thread_id] = tracker
        self._sessions.mark_active(turn.thread_id, True)
        self._store.put_turn(turn.submission_id, record)
        return tracker

    def _untrack(self, tracker: _Tracker) -> None:
        self._by_session.pop(tracker.session.session_id or "", None)
        if self._by_thread.get(tracker.turn.thread_id) is tracker:
            self._by_thread.pop(tracker.turn.thread_id, None)
        self._sessions.mark_active(tracker.turn.thread_id, False)

    def _write_turn_file(self, turn: Turn, rec: ThreadSession) -> None:
        message_id = turn.answers_message_id if turn.trigger_kind == "message" else turn.reply_message_id
        if not message_id:
            turn_context.clear(self._agent.profile.profile_home, turn.thread_id)
            return
        turn_context.write(self._agent.profile.profile_home, turn.thread_id, turn_context.TurnContext(
            thread_id=turn.thread_id, session_generation=rec.generation, message_id=message_id,
            run_id=turn.run_id, submission_id=turn.submission_id, message_ids=turn.message_ids,
            expires_at=turn_context.expiry_from_now(self._config.turn_file_ttl_s)))

    async def _submit(self, tracker: _Tracker) -> Mapping[str, Any]:
        turn = tracker.turn
        deadline = self._clock() + SUBMIT_RETRY_WINDOW_S
        reattached = False
        while True:
            params: dict[str, Any] = {"session_id": tracker.session.session_id, "submission_id": turn.submission_id,
                                      "text": turn.text}
            if turn.api_text and turn.api_text != turn.text:
                params["api_text"] = turn.api_text
            if turn.author is not None:
                params["turn_author"] = turn.author.to_wire()
            if turn.display_kind:
                params["display_kind"] = turn.display_kind
            tracker.mapper.submitted_at = self._clock()
            try:
                return await self._link.turns.call("prompt.submit", params, timeout=self._config.rpc_timeout_s)
            except RpcError as exc:
                if exc.reason == "admission_conflict":
                    raise AdmissionConflict(str(exc)) from exc
                if exc.reason != "permission_denied" or reattached:
                    raise
                reattached = True  # the socket was replaced and the session is no longer attached
                self._sessions.invalidate(turn.thread_id)
                rec = await self._sessions.ensure(turn.thread_id, turn.policy)
                self._by_session.pop(tracker.session.session_id or "", None)
                tracker.session = rec
                self._by_session[rec.session_id or ""] = tracker
            except (RpcTimeout, GatewayUnavailable):
                if self._clock() > deadline:
                    raise  # submission_id makes the retry idempotent (same admission_id)
                await asyncio.sleep(0.5)

    async def _wait_and_settle(self, tracker: _Tracker) -> TurnResult:
        cfg = self._config
        while not tracker.done.is_set():
            try:
                await asyncio.wait_for(tracker.done.wait(), cfg.tick_s)
            except asyncio.TimeoutError:
                pass
            now = self._clock()
            for event in tracker.mapper.tick(now):
                self._emit(tracker, event)
            if not self._link.connected:
                tracker.last_activity = now  # a WiFi drop is not model idleness
                continue
            if tracker.interrupt_reason is None and cfg.idle_timeout_s > 0 \
                    and now - tracker.last_activity > cfg.idle_timeout_s:
                tracker.interrupt_reason = "idle_timeout"
                await self._send_interrupt(tracker)
            elif tracker.interrupt_sent_at is not None and now - tracker.interrupt_sent_at > cfg.interrupt_grace_s:
                tracker.interrupt_sent_at = now
                await self._reconcile(tracker)
        return await self._settle(tracker)

    async def _settle(self, tracker: _Tracker) -> TurnResult:
        turn = tracker.turn
        receipt = tracker.settled_receipt or await self._fetch_receipt(tracker) or {}
        complete = dict(tracker.complete.payload) if tracker.complete else {}
        result = receipt.get("result") if isinstance(receipt.get("result"), Mapping) else {}
        exit_reason = result.get("turn_exit_reason")
        failure = result.get("failure_reason") or complete.get("failure_reason")
        outcome_name = receipt.get("outcome") or complete.get("outcome")
        status = complete.get("status")
        error_code, retry = None, False
        if outcome_name == "completed" and status in (None, "complete"):
            outcome = TurnOutcome.COMPLETED
        elif outcome_name in ("interrupted", "cancelled") or status == "interrupted":
            shutdown = "gateway_shutdown" in str(exit_reason or "") or tracker.restart_seen
            if tracker.interrupt_reason == "idle_timeout":
                outcome, error_code = TurnOutcome.TIMEOUT, "idle_timeout"
            elif tracker.interrupt_reason:
                outcome = TurnOutcome.CANCELLED
            elif shutdown:
                outcome, error_code = TurnOutcome.FAILED, "runtime_restart"
                retry = not tracker.mapper.saw_tool and turn.attempt == 0
            else:
                outcome, error_code = TurnOutcome.CANCELLED, "interrupted"
        else:
            outcome, error_code = TurnOutcome.FAILED, ("hermes_failed" if outcome_name else "no_receipt")
        now = self._clock()
        mapper = tracker.mapper
        usage = usage_from_receipt(receipt, complete)
        live_usage = mapper.last_usage or {}
        tr = TurnResult(
            outcome=outcome, final_text=str(result.get("final_response") or complete.get("text") or ""),
            usage=usage, exit_reason=exit_reason, failure_reason=failure, error_code=error_code,
            retry_advised=retry, admission_id=tracker.admission_id,
            execution_generation=tracker.execution_generation, duration_ms=round((now - tracker.started_mono) * 1000),
            queue_ms=round((mapper.started_at - mapper.submitted_at) * 1000)
            if mapper.started_at is not None and mapper.submitted_at is not None else None,
            first_token_ms=round((mapper.first_token_at - mapper.submitted_at) * 1000)
            if mapper.first_token_at is not None and mapper.submitted_at is not None else None,
            steps=mapper.steps, tool_calls=mapper.tool_calls, saw_tool=mapper.saw_tool,
            context_used=live_usage.get("context_used", tracker.session.context_used),
            restart_path=tracker.restart_path, receipt=dict(receipt))
        for event in mapper.finish():
            self._emit(tracker, event)
        self._emit(tracker, mapper.bridge_event(
            _TERMINAL_KIND[outcome], status="ok" if outcome is TurnOutcome.COMPLETED else
            ("interrupted" if outcome in (TurnOutcome.CANCELLED, TurnOutcome.TIMEOUT) else "error"),
            duration_ms=tr.duration_ms, summary=error_code,
            data={"exitReason": exit_reason, "failureReason": failure, "steps": mapper.steps}))
        self._untrack(tracker)
        turn_context.clear(self._agent.profile.profile_home, turn.thread_id, turn.submission_id)
        tracker.record.update(status="settled", nextEventSeq=self._sink.next_seq(turn.run_id),
                              sawTool=mapper.saw_tool, outcome=outcome.value)
        self._store.put_turn(turn.submission_id, tracker.record)
        tracker.session.last_turn_at = _iso()
        self._sessions.persist(tracker.session)
        await self._store.save()
        self._log.info("turn.timing thread=%s run=%s outcome=%s queue_ms=%s first_token_ms=%s duration_ms=%s "
                       "restart_path=%d", turn.thread_id, turn.run_id, outcome.value, tr.queue_ms,
                       tr.first_token_ms, tr.duration_ms, int(tr.restart_path))
        return tr

    async def _fetch_receipt(self, tracker: _Tracker) -> Optional[Mapping[str, Any]]:
        for attempt in range(5):
            try:
                return await self._link.turns.call("prompt.receipt", {
                    "session_id": tracker.session.session_id, "admission_id": tracker.admission_id,
                    "include_result": True}, timeout=self._config.rpc_timeout_s)
            except (GatewayUnavailable, RpcTimeout) as exc:
                self._log.warning("prompt.receipt failed (%s), attempt %d", exc, attempt + 1)
                await asyncio.sleep(min(5.0, 0.5 * (2 ** attempt)))
            except RpcError as exc:
                self._log.warning("prompt.receipt refused: %s", exc)
                return None
        return None

    # ---- events, interrupts, restart path -------------------------------------------------

    def _emit(self, tracker: _Tracker, event: EmperorEvent) -> None:
        self._sink.emit(tracker.turn.run_id, event)

    def _on_event(self, event: GatewayEvent) -> None:
        tracker = self._by_session.get(event.session_id or "")
        if tracker is None:
            return
        if tracker.admission_id is None:
            if event.admission_id:
                tracker.buffered.append(event)
            return
        if event.admission_id == tracker.admission_id:
            self._process(tracker, event)

    def _process(self, tracker: _Tracker, event: GatewayEvent) -> None:
        if tracker.done.is_set():
            return
        tracker.last_activity = self._clock()
        if event.execution_generation is not None:
            tracker.execution_generation = event.execution_generation
        if event.type == "message.start":
            tracker.record.update(status="running", executionGeneration=event.execution_generation)
            self._store.put_turn(tracker.turn.submission_id, tracker.record)
        had_tool = tracker.mapper.saw_tool
        for mapped in tracker.mapper.map(event):
            self._emit(tracker, mapped)
        if tracker.mapper.saw_tool and not had_tool:
            tracker.record["sawTool"] = True  # D15: must survive a gateway SIGKILL
            self._store.put_turn(tracker.turn.submission_id, tracker.record)
            self._spawn(self._store.save())
        if event.type in ("approval.request", "clarify.request"):
            self._spawn(self._auto_answer(tracker, event))
        elif event.type == "message.complete":
            tracker.complete = event
            tracker.done.set()

    def _spawn(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _auto_answer(self, tracker: _Tracker, event: GatewayEvent) -> None:
        """D11 backstop: yolo sessions should never ask; answer anyway within a second."""
        p = event.payload
        params = {"session_id": tracker.session.session_id, "prompt_id": p.get("prompt_id"),
                  "execution_generation": p.get("execution_generation", event.execution_generation)}
        if event.type == "approval.request":
            method, params["choice"] = "approval.respond", "once"
        else:
            method, params["answer"] = "clarify.respond", self._config.clarify_answer
        try:
            await self._link.turns.call(method, params, timeout=self._config.rpc_timeout_s)
        except Exception as exc:
            self._log.warning("%s failed: %s", method, exc)

    async def _send_interrupt(self, tracker: _Tracker) -> None:
        tracker.interrupt_sent_at = self._clock()
        sid = tracker.session.session_id
        try:
            if tracker.execution_generation is None:  # still queued inside Hermes
                await self._link.turns.call("prompt.cancel", {"session_id": sid, "admission_id": tracker.admission_id},
                                            timeout=self._config.rpc_timeout_s)
            else:
                await self._link.turns.call("session.interrupt", {
                    "session_id": sid, "execution_generation": tracker.execution_generation},
                    timeout=self._config.rpc_timeout_s)
        except RpcError as exc:
            if exc.reason in ("stale_generation", "unknown_execution", "not_found"):
                await self._reconcile(tracker)  # D10: already settled
            else:
                self._log.warning("interrupt failed: %s", exc)
        except (GatewayUnavailable, RpcTimeout) as exc:
            self._log.warning("interrupt not delivered yet (%s); the receipt poll will follow", exc)

    async def _on_resync(self, rec: ThreadSession, mode: str, snapshot: Mapping[str, Any]) -> None:
        tracker = self._by_session.get(rec.session_id or "")
        if tracker is None or tracker.done.is_set():
            return
        tracker.last_activity = self._clock()
        tracker.restart_path = tracker.restart_path or mode != "replayed"
        if mode == "restarted":
            tracker.restart_seen = True
        if mode != "replayed":
            await self._reconcile(tracker)

    async def _reconcile(self, tracker: _Tracker) -> None:
        """Ask the receipt; resolve `unknown` (SIGKILL) and settle terminal admissions."""
        if tracker.admission_id is None or tracker.done.is_set():
            return
        receipt = await self._fetch_receipt(tracker)
        if receipt is None:
            return
        if receipt.get("status") == "unknown":
            tracker.restart_seen = True
            generation = receipt.get("execution_generation") or tracker.execution_generation \
                or tracker.session.execution_generation
            resolved: Optional[Mapping[str, Any]] = None
            try:  # unpauses the session FIFO; answers with the now-terminal AdmissionStatus
                resolved = await self._link.turns.call("prompt.resolve_unknown", {
                    "session_id": tracker.session.session_id, "admission_id": tracker.admission_id,
                    "execution_generation": generation}, timeout=self._config.rpc_timeout_s)
            except RpcError as exc:
                self._log.warning("prompt.resolve_unknown refused: %s", exc)
            if isinstance(resolved, Mapping) and resolved.get("status") == "terminal":
                receipt = resolved
            else:
                receipt = await self._fetch_receipt(tracker) or receipt
        if receipt.get("status") == "terminal":
            tracker.settled_receipt = receipt
            tracker.done.set()

    async def _recover_one(self, submission_id: str, record: dict[str, Any]) -> RecoveredTurn:
        thread_id = str(record.get("threadId") or "")
        rec = self._sessions.get(thread_id)
        if not record.get("admissionId") or rec is None or not rec.session_id:
            self._store.drop_turn(submission_id)  # never admitted: the caller re-dispatches it
            return RecoveredTurn(submission_id, record, None)
        turn = Turn(thread_id=thread_id, trigger_id=str(record.get("triggerId") or ""), text="", api_text="",
                    policy=SessionPolicy(system_prompt=""), message_ids=tuple(record.get("messageIds") or ()),
                    attempt=int(record.get("attempt") or 0), agent_id=self._agent.agent_id,
                    trigger_kind=str(record.get("triggerKind") or "message"))
        self._sink.open_run(turn.run_id, self.run_header(turn, record.get("startedAt")),
                            next_seq=int(record.get("nextEventSeq") or 0))
        tracker = self._track(turn, rec, record)
        tracker.admission_id = str(record["admissionId"])
        tracker.execution_generation = record.get("executionGeneration")
        tracker.restart_path = True
        try:
            await self._sessions.resync(thread_id)
            if not tracker.done.is_set():
                await self._reconcile(tracker)
        except (GatewayUnavailable, RpcTimeout, RpcError) as exc:
            self._log.warning("recovery of %s deferred: %s", submission_id, exc)
        result = await self._wait_and_settle(tracker)
        return RecoveredTurn(submission_id, tracker.record, result)
