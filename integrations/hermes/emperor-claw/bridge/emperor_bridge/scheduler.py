"""Per-thread single flight, coalesced follow-ups and a per-agent parallel cap (D9).

Messages for a thread queue while that thread has a turn in flight (or waits for a slot); when
the thread is dispatched, everything queued for it becomes one coalesced batch (the last message
is the trigger, the rest go to `alsoResolvesMessageIds`). Threads are served in arrival order
under `max_parallel_turns`. `pause()` = standby (duplicate runtime, D19): submits are kept but
nothing new starts. `steer` follow-ups stay off until contract test R-3 (falls back to coalesce).

The dispatch callback (W4) builds the Turn, runs it, delivers the reply, and may return a new
TurnBatch to run immediately in the same slot (e.g. a D15 `-r1` retry).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, Mapping, Optional

from .interfaces import SchedulerConfig, submission_id_for


@dataclass(frozen=True)
class InboundMessage:
    """One Emperor message routed to this agent. `raw` keeps the sync payload for W4."""

    id: str
    thread_id: str
    raw: Mapping[str, Any] = field(default_factory=dict)
    received_at: float = field(default_factory=time.time)


@dataclass(frozen=True)
class TurnBatch:
    thread_id: str
    messages: tuple[InboundMessage, ...]
    attempt: int = 0
    position: int = 0
    queued_at: float = 0.0

    @property
    def trigger(self) -> InboundMessage:
        return self.messages[-1]

    @property
    def message_ids(self) -> tuple[str, ...]:
        return tuple(m.id for m in self.messages)

    @property
    def submission_id(self) -> str:
        return submission_id_for(self.trigger.id, self.attempt)

    def retry(self) -> "TurnBatch":
        return replace(self, attempt=self.attempt + 1)


@dataclass(frozen=True)
class SubmitResult:
    accepted: bool
    position: int  # 0 = will start now, n = n threads ahead of it
    coalesced: bool  # joined messages already waiting for the same thread


Dispatch = Callable[[TurnBatch], Awaitable[Optional[TurnBatch]]]


class Scheduler:
    def __init__(self, dispatch: Dispatch, config: SchedulerConfig = SchedulerConfig(), *,
                 logger: Optional[logging.Logger] = None) -> None:
        self._dispatch = dispatch
        self._config = config
        self._log = logger or logging.getLogger("emperor_bridge.scheduler")
        self._pending: dict[str, deque[InboundMessage]] = {}
        self._ready: "OrderedDict[str, None]" = OrderedDict()  # threads waiting for a slot
        self._in_flight: dict[str, asyncio.Task] = {}
        self._known_ids: set[str] = set()  # queued or running message ids
        self._running_ids: dict[str, set[str]] = {}
        self._reserved: set[str] = set()  # threads busy recovering; follow-ups queue behind them
        self._submit_attempt: dict[str, int] = {}  # re-dispatch attempt per thread (submit_batch)
        self._paused = False
        self._closing = False
        self._idle = asyncio.Event()
        self._idle.set()
        if config.followup_mode == "steer":
            self._log.warning("EMPEROR_CLAW_HERMES_FOLLOWUP=steer is gated by contract test R-3; coalescing instead")

    # ---- queries --------------------------------------------------------------------------

    def is_busy(self, thread_id: str) -> bool:
        return thread_id in self._in_flight or thread_id in self._reserved

    def has_pending(self, thread_id: str) -> bool:
        return bool(self._pending.get(thread_id))

    def in_flight(self) -> list[str]:
        return list(self._in_flight)

    def queued_count(self) -> int:
        return sum(len(q) for q in self._pending.values())

    @property
    def paused(self) -> bool:
        return self._paused

    # ---- commands -------------------------------------------------------------------------

    def submit(self, message: InboundMessage) -> SubmitResult:
        if self._closing:
            return SubmitResult(False, -1, False)
        if message.id in self._known_ids:
            return SubmitResult(False, -1, False)  # already queued or running
        self._known_ids.add(message.id)
        queue = self._pending.setdefault(message.thread_id, deque())
        coalesced = bool(queue)
        queue.append(message)
        if message.thread_id not in self._in_flight and message.thread_id not in self._reserved:
            self._ready.setdefault(message.thread_id, None)
        position = list(self._ready).index(message.thread_id) if message.thread_id in self._ready else len(self._ready)
        self._pump()
        return SubmitResult(True, position, coalesced)

    def submit_batch(self, batch: TurnBatch) -> None:
        """Re-queue a whole batch at the front of its thread (recovery re-dispatch)."""
        queue = self._pending.setdefault(batch.thread_id, deque())
        for message in reversed(batch.messages):
            if message.id not in self._known_ids:
                self._known_ids.add(message.id)
                queue.appendleft(message)
        self._submit_attempt[batch.thread_id] = batch.attempt  # keep the retry suffix on re-dispatch
        if batch.thread_id not in self._in_flight and batch.thread_id not in self._reserved:
            self._ready[batch.thread_id] = None
            self._ready.move_to_end(batch.thread_id, last=False)
        self._pump()

    def cancel(self, message_id: str) -> bool:
        """Drop a queued (not yet dispatched) message. Running turns are stopped via controls."""
        for thread_id, queue in self._pending.items():
            for message in list(queue):
                if message.id == message_id:
                    queue.remove(message)
                    self._known_ids.discard(message_id)
                    if not queue:
                        self._ready.pop(thread_id, None)
                        self._submit_attempt.pop(thread_id, None)  # no retry left to re-dispatch
                    return True
        return False

    def clear_pending(self) -> list[InboundMessage]:
        """Drop every queued message (kill/replace). Returns what was dropped."""
        dropped = [m for q in self._pending.values() for m in q]
        for message in dropped:
            self._known_ids.discard(message.id)
        self._pending.clear()
        self._ready.clear()
        self._submit_attempt.clear()
        return dropped

    def clear_thread(self, thread_id: str, *, before: Any = None) -> list[InboundMessage]:
        """Drop one thread's queued messages (thread-scoped replace). With `before` (an ISO time),
        only those created before it: the replacing prompt itself may already be queued."""
        cutoff = _instant(before)
        queue = self._pending.get(thread_id) or deque()
        dropped = [m for m in queue if cutoff is None or (_instant(m.raw.get("createdAt")) or 0.0) < cutoff]
        for message in dropped:
            queue.remove(message)
            self._known_ids.discard(message.id)
        if not queue:
            self._pending.pop(thread_id, None)
            self._ready.pop(thread_id, None)
            self._submit_attempt.pop(thread_id, None)
        return dropped

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False
        self._pump()

    def reserve(self, thread_id: str) -> None:
        """Mark a thread busy while it is being recovered (no task yet). New submits queue
        behind it instead of colliding with the turn that is still settling."""
        self._reserved.add(thread_id)
        self._ready.pop(thread_id, None)
        self._idle.clear()

    def release(self, thread_id: str) -> None:
        self._reserved.discard(thread_id)
        if self._pending.get(thread_id) and thread_id not in self._in_flight:
            self._ready.setdefault(thread_id, None)
        if not self._in_flight and not self._reserved:
            self._idle.set()
        self._pump()

    async def drain(self, timeout: float) -> bool:
        """Stop accepting work and wait for in-flight turns. True when everything finished."""
        self._closing = True
        try:
            await asyncio.wait_for(self._idle.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    # ---- internals ------------------------------------------------------------------------

    def _pump(self) -> None:
        if self._paused or self._closing:
            return
        while self._ready and len(self._in_flight) < max(1, self._config.max_parallel_turns):
            thread_id, _ = self._ready.popitem(last=False)
            queue = self._pending.get(thread_id)
            if not queue or thread_id in self._reserved:
                continue  # a reserved (recovering) thread is re-readied by release()
            take = min(len(queue), max(1, self._config.max_coalesced))
            messages = tuple(queue.popleft() for _ in range(take))
            if not queue:
                self._pending.pop(thread_id, None)
            attempt = self._submit_attempt.pop(thread_id, 0)  # a re-dispatched retry keeps its -rN
            batch = TurnBatch(thread_id=thread_id, messages=messages, attempt=attempt,
                              position=len(self._in_flight), queued_at=messages[0].received_at)
            self._idle.clear()
            self._running_ids[thread_id] = set(batch.message_ids)
            self._in_flight[thread_id] = asyncio.get_running_loop().create_task(
                self._run(batch), name=f"turn-{thread_id}")

    async def _run(self, batch: Optional[TurnBatch]) -> None:
        thread_id = batch.thread_id if batch else ""
        try:
            while batch is not None:
                try:
                    batch = await self._dispatch(batch)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._log.exception("dispatch failed for thread %s", thread_id)
                    batch = None
        finally:
            self._in_flight.pop(thread_id, None)
            self._known_ids.difference_update(self._running_ids.pop(thread_id, set()))
            if self._pending.get(thread_id) and thread_id not in self._reserved:
                self._ready.setdefault(thread_id, None)
            if not self._in_flight and not self._reserved:
                self._idle.set()
            self._pump()


def _instant(value: Any) -> Optional[float]:
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() if value else None
    except ValueError:
        return None
