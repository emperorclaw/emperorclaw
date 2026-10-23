"""Hermes events -> Emperor run events (section 4.3), redaction, throttles, and the batching sink.

`EventMapper` is per run (one turn): it is stateful because of throttles and coalescing, and
it counts steps and tool calls for the terminal event. `EventSink` assigns the per-run seq,
batches every 500 ms / 50 events (section 5.5), keeps at most `spool_cap` events per agent in
memory (droppable kinds go first, counted into `eventsDropped`) and sends the `run` header with
the first batch of each run (the endpoint upserts it).
"""
from __future__ import annotations

from types import MappingProxyType

import asyncio
import contextlib
import json
import logging
import re
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

from .interfaces import (BridgeError, DROPPABLE_EVENT_KINDS, EmperorEvent, EmperorPort, EmperorUnavailable,
                         EventSinkConfig, GatewayEvent, RunGone, RunNotFound)

TOOL_SUMMARY_MAX = 120
TOOL_PREVIEW_MAX = 160
REASONING_MAX = 500
NOTICE_MAX = 200
DATA_MAX_BYTES = 2048

REASONING_WINDOW_S = 1.5
NOTICE_INTERVAL_S = 2.0
STATUS_INTERVAL_S = 2.0
USAGE_INTERVAL_S = 5.0
PROGRESS_INTERVAL_S = 2.0
PREPARE_GRACE_S = 2.0

IGNORED_TYPES = frozenset({"message.delta", "message.interim", "thinking.delta", "session.info", "todo.updated",
                           "gateway.ready", "sessions.changed", "platforms.changed", "session.updated",
                           "message.complete", "session.title", "notification.show", "notification.clear"})

_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}"), r"\1 [redacted]"),
    (re.compile(r"\b(sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}"), "[redacted-key]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[redacted-jwt]"),
    (re.compile(r"(?i)((?:api[_-]?key|secret|password|passwd|token|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]{4,}"),
     r"\1[redacted]"),
    (re.compile(r"(?i)\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^\s:@/]+:[^\s@/]+@"), r"\1://[redacted]@"),
    (re.compile(r"\b[A-Fa-f0-9]{40,}\b"), "[redacted-hex]"),
)


def redact(text: Any, limit: int) -> Optional[str]:
    """Secret-scrubbed, single-spaced, truncated text (None for empty)."""
    if text is None:
        return None
    value = str(text)
    for pattern, replacement in _REDACTIONS:
        value = pattern.sub(replacement, value)
    value = re.sub(r"\s+", " ", value).strip()
    if not value:
        return None
    return value if len(value) <= limit else value[: max(1, limit - 1)] + "…"


def first_line(value: Any) -> str:
    if isinstance(value, Mapping):
        value = value.get("error") or value.get("output") or json.dumps(value)[:400]
    text = str(value or "")
    with contextlib.suppress(ValueError, TypeError):  # tool results are often JSON objects
        parsed = json.loads(text)
        if isinstance(parsed, Mapping):
            text = str(parsed.get("error") or parsed.get("message") or parsed.get("content") or text)
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def bounded_data(data: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    clean = {k: v for k, v in data.items() if v is not None}
    if not clean:
        return None
    if len(json.dumps(clean, ensure_ascii=False).encode("utf-8")) <= DATA_MAX_BYTES:
        return clean
    shrunk = {k: (redact(v, 200) if isinstance(v, str) else v) for k, v in clean.items()
              if isinstance(v, (str, int, float, bool))}
    if len(json.dumps(shrunk, ensure_ascii=False).encode("utf-8")) <= DATA_MAX_BYTES:
        return shrunk
    return {"truncated": True}


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class _Throttle:
    """At most one emission per interval: leading edge immediately, latest pending on `due`."""

    def __init__(self, interval_s: float) -> None:
        self.interval = interval_s
        self.last = float("-inf")
        self.pending: Optional[EmperorEvent] = None

    def offer(self, event: EmperorEvent, now: float) -> Optional[EmperorEvent]:
        if now - self.last >= self.interval:
            self.last, self.pending = now, None
            return event
        self.pending = event
        return None

    def due(self, now: float) -> Optional[EmperorEvent]:
        if self.pending is not None and now - self.last >= self.interval:
            event, self.pending, self.last = self.pending, None, now
            return event
        return None

    def drain(self) -> Optional[EmperorEvent]:
        event, self.pending = self.pending, None
        return event


@dataclass
class _ReasoningBuffer:
    text: str = ""
    started: float = 0.0
    key: str = ""
    seen_delta: bool = False


@dataclass
class EventMapper:
    """Maps one turn's GatewayEvents. Call `map` per event, `tick` periodically, `finish` once."""

    clock: Callable[[], float] = time.monotonic
    wall: Callable[[], str] = iso_now
    submitted_at: Optional[float] = None
    steps: int = 0
    tool_calls: int = 0
    saw_tool: bool = False
    first_token_at: Optional[float] = None
    started_at: Optional[float] = None
    last_usage: Optional[Mapping[str, Any]] = None
    _bridge_n: int = 0
    _reasoning: _ReasoningBuffer = field(default_factory=_ReasoningBuffer)
    _throttles: dict[str, _Throttle] = field(default_factory=dict)
    _prepare: Optional[tuple[float, EmperorEvent]] = None

    # ---- helpers --------------------------------------------------------------------------

    def _throttle(self, key: str, interval: float) -> _Throttle:
        return self._throttles.setdefault(key, _Throttle(interval))

    def _event(self, ev: GatewayEvent, kind: str, **fields: Any) -> EmperorEvent:
        key = f"{ev.replay_epoch}:{ev.seq}" if ev.seq is not None else self._next_bridge_key(kind)
        data = fields.pop("data", None)
        return EmperorEvent(kind=kind, ts=self.wall(), source_key=key,
                            data=bounded_data(data) if data else None, **fields)

    def _next_bridge_key(self, kind: str) -> str:
        self._bridge_n += 1
        return f"bridge:{kind}:{self._bridge_n}"

    def bridge_event(self, kind: str, **fields: Any) -> EmperorEvent:
        """An event the bridge makes itself (turn.queued, terminal events, compaction.*)."""
        data = fields.pop("data", None)
        return EmperorEvent(kind=kind, ts=self.wall(), source_key=self._next_bridge_key(kind),
                            data=bounded_data(data) if data else None, **fields)

    # ---- mapping --------------------------------------------------------------------------

    def map(self, ev: GatewayEvent) -> list[EmperorEvent]:
        now = self.clock()
        out: list[EmperorEvent] = []
        handler = _HANDLERS.get(ev.type)
        if handler is not None:
            handler(self, ev, now, out)
        elif ev.type.startswith("subagent."):
            self._subagent(ev, out)
        out.extend(self.tick(now))
        return out

    def tick(self, now: Optional[float] = None) -> list[EmperorEvent]:
        now = self.clock() if now is None else now
        out: list[EmperorEvent] = []
        if self._prepare is not None and now - self._prepare[0] >= PREPARE_GRACE_S:
            out.append(self._prepare[1])
            self._prepare = None
        if self._reasoning.text and now - self._reasoning.started >= REASONING_WINDOW_S:
            out.append(self._flush_reasoning())
        for throttle in self._throttles.values():
            event = throttle.due(now)
            if event is not None:
                out.append(event)
        return out

    def finish(self) -> list[EmperorEvent]:
        """Release everything pending (the trailing usage, reasoning, notices). Drops a stale prepare."""
        out: list[EmperorEvent] = []
        self._prepare = None
        if self._reasoning.text:
            out.append(self._flush_reasoning())
        for throttle in self._throttles.values():
            event = throttle.drain()
            if event is not None:
                out.append(event)
        return out

    def _flush_reasoning(self) -> EmperorEvent:
        buf = self._reasoning
        text = buf.text[-REASONING_MAX:]
        event = EmperorEvent(kind="reasoning", ts=self.wall(), source_key=buf.key, summary=redact(text, REASONING_MAX))
        buf.text, buf.key = "", ""
        return event

    def _on_start(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        self.started_at = now
        queue_ms = round((now - self.submitted_at) * 1000) if self.submitted_at is not None else None
        out.append(self._event(ev, "turn.started", data={"queueMs": queue_ms}))

    def _on_delta(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        if self.first_token_at is None and ev.payload.get("text"):
            self.first_token_at = now

    def _on_step(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        iteration = ev.payload.get("iteration")
        self.steps = max(self.steps + 1, iteration if isinstance(iteration, int) else 0)

    def _on_reasoning_delta(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        text = str(ev.payload.get("text") or "")
        if not text:
            return
        if self.first_token_at is None:
            self.first_token_at = now
        buf = self._reasoning
        if not buf.text:
            buf.started = now
        buf.seen_delta = True
        buf.text += text
        buf.key = f"{ev.replay_epoch}:{ev.seq}"

    def _on_reasoning_available(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        if self._reasoning.seen_delta:
            return
        self._reasoning.seen_delta = True  # one reasoning event per turn from this source
        out.append(self._event(ev, "reasoning", summary=redact(ev.payload.get("text"), REASONING_MAX)))

    def _on_tool_generating(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        name = ev.payload.get("name")
        self._prepare = (now, self._event(ev, "tool.prepare", tool_name=redact(name, 100)))

    def _on_tool_start(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        p = ev.payload
        self._prepare = None
        self.saw_tool = True
        self.tool_calls += 1
        out.append(self._event(ev, "tool.start", tool_name=redact(p.get("tool_name") or p.get("name"), 100),
                               tool_call_id=_str(p.get("tool_call_id") or p.get("tool_id")), status="running",
                               summary=redact(p.get("context"), TOOL_SUMMARY_MAX)))

    def _on_tool_complete(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        p = ev.payload
        is_error = bool(p.get("is_error"))
        duration = p.get("duration_s")
        preview = redact(first_line(p.get("result")), TOOL_PREVIEW_MAX) if is_error else None
        out.append(self._event(ev, "tool.end", tool_name=redact(p.get("tool_name") or p.get("name"), 100),
                               tool_call_id=_str(p.get("tool_call_id") or p.get("tool_id")),
                               status="error" if is_error else "ok",
                               duration_ms=round(float(duration) * 1000) if isinstance(duration, (int, float)) else None,
                               summary=redact(p.get("context"), TOOL_SUMMARY_MAX), data={"preview": preview}))

    def _on_tool_progress(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        p = ev.payload
        call = _str(p.get("tool_call_id") or p.get("tool_id")) or "?"
        event = self._event(ev, "tool.progress", tool_name=redact(p.get("name"), 100), tool_call_id=call,
                            status="running", summary=redact(p.get("message"), NOTICE_MAX),
                            data={"percent": p.get("percent")})
        self._emit_throttled(f"progress:{call}", PROGRESS_INTERVAL_S, event, now, out)

    def _on_print(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        event = self._event(ev, "notice", summary=redact(ev.payload.get("text"), NOTICE_MAX))
        if event.summary:
            self._emit_throttled("notice", NOTICE_INTERVAL_S, event, now, out)

    def _on_status(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        p = ev.payload
        event = self._event(ev, "status", summary=redact(p.get("text"), NOTICE_MAX), data={"kind": p.get("kind")})
        self._emit_throttled("status", STATUS_INTERVAL_S, event, now, out)

    def _on_usage(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        p = ev.payload
        u = p.get("usage") if isinstance(p.get("usage"), Mapping) else {}
        self.last_usage = u
        data = {"input": u.get("input"), "output": u.get("output"), "reasoning": u.get("reasoning"),
                "calls": u.get("calls"), "contextUsed": u.get("context_used"), "contextMax": u.get("context_max"),
                "contextPercent": u.get("context_percent"), "model": u.get("model"),
                "cacheRead": p.get("cache_read_tokens"), "cacheWrite": p.get("cache_write_tokens"),
                "costUsd": u.get("cost_usd")}
        self._emit_throttled("usage", USAGE_INTERVAL_S, self._event(ev, "usage", data=data), now, out)

    def _on_prompt(self, ev: GatewayEvent, now: float, out: list[EmperorEvent]) -> None:
        p = ev.payload
        kind = "approval.auto" if ev.type == "approval.request" else "clarify.auto"
        text = p.get("command") or p.get("question") or p.get("description") or p.get("text")
        out.append(self._event(ev, kind, summary=redact(text, NOTICE_MAX)))

    def _subagent(self, ev: GatewayEvent, out: list[EmperorEvent]) -> None:
        suffix = ev.type.split(".", 1)[1]
        p = ev.payload
        name = redact(p.get("name") or p.get("agent") or p.get("subagent"), 100)
        if suffix in ("start", "started", "spawn", "spawned"):
            out.append(self._event(ev, "subagent.start", summary=name, data={"name": name}))
        elif suffix in ("complete", "completed", "end", "ended", "finish", "finished", "done"):
            duration = p.get("duration_s")
            out.append(self._event(ev, "subagent.end", summary=name, data={"name": name},
                                   duration_ms=round(float(duration) * 1000) if isinstance(duration, (int, float)) else None))

    def _emit_throttled(self, key: str, interval: float, event: EmperorEvent, now: float,
                        out: list[EmperorEvent]) -> None:
        emitted = self._throttle(key, interval).offer(event, now)
        if emitted is not None:
            out.append(emitted)


def _str(value: Any) -> Optional[str]:
    return None if value in (None, "") else str(value)[:200]


_HANDLERS: Mapping[str, Callable[[EventMapper, GatewayEvent, float, list[EmperorEvent]], None]] = MappingProxyType({
    "message.start": EventMapper._on_start,
    "message.delta": EventMapper._on_delta,
    "agent.step": EventMapper._on_step,
    "reasoning.delta": EventMapper._on_reasoning_delta,
    "reasoning.available": EventMapper._on_reasoning_available,
    "tool.generating": EventMapper._on_tool_generating,
    "tool.start": EventMapper._on_tool_start,
    "tool.complete": EventMapper._on_tool_complete,
    "tool.progress": EventMapper._on_tool_progress,
    "agent.print": EventMapper._on_print,
    "status.update": EventMapper._on_status,
    "session.usage": EventMapper._on_usage,
    "approval.request": EventMapper._on_prompt,
    "clarify.request": EventMapper._on_prompt,
})


def map_frame(frame: Mapping[str, Any], mapper: EventMapper) -> list[EmperorEvent]:
    """Doc signature (section 5.1): map one raw `event` params object with a per-turn mapper."""
    return mapper.map(GatewayEvent.from_params(frame))


# ---------------------------------------------------------------------------------------------
# Sink
# ---------------------------------------------------------------------------------------------


@dataclass
class _RunQueue:
    header: dict[str, Any]
    next_seq: int = 0
    pending: deque = field(default_factory=deque)  # (kind, wire dict)
    header_sent: bool = False
    dropped: int = 0
    closing: bool = False
    gone: bool = False


class EventSink:
    """Implements interfaces.EventSinkPort on top of EmperorPort.post_run_events."""

    def __init__(self, emperor: EmperorPort, config: EventSinkConfig = EventSinkConfig(),
                 logger: Optional[logging.Logger] = None) -> None:
        self._emperor = emperor
        self._config = config
        self._log = logger or logging.getLogger("emperor_bridge.events")
        self._runs: dict[str, _RunQueue] = {}
        self._flush_lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None
        self._backoff_until = 0.0
        self._backoff = config.retry_initial_s
        self._wake = asyncio.Event()

    def open_run(self, run_id: str, header: Mapping[str, Any], *, next_seq: int = 0) -> None:
        queue = self._runs.get(run_id)
        if queue is None:
            self._runs[run_id] = _RunQueue(header=dict(header), next_seq=next_seq)
        else:
            queue.next_seq = max(queue.next_seq, next_seq)
            queue.closing = False

    def emit(self, run_id: str, event: EmperorEvent) -> None:
        queue = self._runs.get(run_id)
        if queue is None or queue.gone:
            return
        queue.pending.append((event.kind, event.to_wire(run_id, queue.next_seq)))
        queue.next_seq += 1
        self._enforce_cap()
        if len(queue.pending) >= self._config.batch_max:
            self._wake.set()

    def next_seq(self, run_id: str) -> int:
        queue = self._runs.get(run_id)
        return queue.next_seq if queue else 0

    def dropped(self, run_id: str) -> int:
        queue = self._runs.get(run_id)
        return queue.dropped if queue else 0

    def close_run(self, run_id: str) -> None:
        queue = self._runs.get(run_id)
        if queue is not None:
            queue.closing = True
            if not queue.pending:
                self._runs.pop(run_id, None)

    def pending_count(self) -> int:
        return sum(len(q.pending) for q in self._runs.values())

    def _enforce_cap(self) -> None:
        excess = self.pending_count() - self._config.spool_cap
        if excess <= 0:
            return
        for droppable_only in (True, False):
            for queue in self._runs.values():
                kept: deque = deque()
                while queue.pending:
                    kind, wire = queue.pending.popleft()
                    if excess > 0 and (not droppable_only or kind in DROPPABLE_EVENT_KINDS) \
                            and not kind.startswith("turn."):
                        queue.dropped += 1
                        excess -= 1
                        continue
                    kept.append((kind, wire))
                queue.pending = kept
            if excess <= 0:
                return

    async def flush(self, run_id: Optional[str] = None) -> bool:
        """Send everything pending (for one run or all). False when Emperor is unreachable."""
        async with self._flush_lock:
            ok = True
            for rid in ([run_id] if run_id else list(self._runs)):
                queue = self._runs.get(rid)
                if queue is None:
                    continue
                ok = await self._flush_run(rid, queue) and ok
                if queue.closing and not queue.pending:
                    self._runs.pop(rid, None)
            return ok

    async def _flush_run(self, run_id: str, queue: _RunQueue) -> bool:
        while queue.pending and not queue.gone:
            batch = self._take_batch(queue)
            header = None if queue.header_sent else queue.header
            try:
                try:
                    await self._emperor.post_run_events(run_id, batch, header)
                except RunNotFound:
                    await self._emperor.post_run_events(run_id, batch, queue.header)
            except RunGone:
                queue.gone = True
                queue.dropped += len(queue.pending)
                queue.pending.clear()
                return True
            except EmperorUnavailable as exc:
                self._log.warning("run events for %s parked: %s", run_id, exc)
                return False
            except BridgeError as exc:
                self._log.error("run events batch for %s rejected, dropped: %s", run_id, exc)
            queue.header_sent = True
            for _ in batch:
                queue.pending.popleft()
        return True

    def _take_batch(self, queue: _RunQueue) -> list[dict[str, Any]]:
        batch: list[dict[str, Any]] = []
        size = 0
        for _kind, wire in queue.pending:
            encoded = len(json.dumps(wire, ensure_ascii=False).encode("utf-8"))
            if batch and (len(batch) >= self._config.batch_max or size + encoded > self._config.body_max_bytes):
                break
            batch.append(wire)
            size += encoded
        return batch

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="event-sink")

    async def stop(self, *, final_flush: bool = True) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(BaseException):
                await self._task
            self._task = None
        if final_flush:
            await self.flush()

    async def _loop(self) -> None:
        interval = self._config.flush_ms / 1000.0
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), interval)
            self._wake.clear()
            if time.monotonic() < self._backoff_until:
                continue
            if await self.flush():
                self._backoff = self._config.retry_initial_s
            else:
                self._backoff_until = time.monotonic() + self._backoff
                self._backoff = min(self._config.retry_max_s, self._backoff * 2)
