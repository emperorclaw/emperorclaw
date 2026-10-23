"""Post-reply compaction (D13): compress on the maintenance socket, only while the thread is idle.

Called by the runtime after a reply was delivered. Runs `session.mutate operation:"compress"`
with fresh `expected_revision`/`expected_generation` from a maintenance-socket resume, timeout
660 s. A turn submitted meanwhile queues inside Hermes and runs right after (S-17), so the thread
queue is not held. `session_busy` is retried after the next settle, at most 3 times.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from .events import EventMapper
from .gateway.sessions import SessionManager
from .interfaces import (CompactionConfig, EventSinkPort, GatewayLinkPort, GatewayUnavailable, RpcError,
                         RpcTimeout, ThreadSession)


@dataclass(frozen=True)
class CompactionResult:
    thread_id: str
    status: str  # compressed | busy | failed
    duration_ms: int = 0
    before: Optional[int] = None
    message_count: Optional[int] = None
    revision: Optional[int] = None
    headline: Optional[str] = None


class Compactor:
    def __init__(self, link: GatewayLinkPort, sessions: SessionManager, sink: Optional[EventSinkPort], *,
                 is_busy: Callable[[str], bool], config: CompactionConfig = CompactionConfig(),
                 logger: Optional[logging.Logger] = None, clock: Callable[[], float] = time.monotonic) -> None:
        self._link = link
        self._sessions = sessions
        self._sink = sink
        self._is_busy = is_busy
        self._config = config
        self._log = logger or logging.getLogger("emperor_bridge.compaction")
        self._clock = clock
        self._busy_retries: dict[str, int] = {}
        self._running: set[str] = set()
        self.compactions: dict[str, int] = {}

    def wants(self, session: ThreadSession, context_used: Optional[int] = None) -> bool:
        if self._config.after_tokens <= 0 or not session.session_id:
            return False
        if session.thread_id in self._busy_retries:
            return True
        used = context_used if context_used is not None else session.context_used
        return used is not None and used >= self._config.after_tokens

    async def maybe_compact(self, session: ThreadSession, *, context_used: Optional[int] = None,
                            run_id: Optional[str] = None) -> Optional[CompactionResult]:
        thread_id = session.thread_id
        if not self.wants(session, context_used) or thread_id in self._running:
            return None
        if self._is_busy(thread_id):
            return self._note_busy(thread_id)
        self._running.add(thread_id)
        try:
            return await self._compress(session, context_used, run_id)
        finally:
            self._running.discard(thread_id)

    def _note_busy(self, thread_id: str) -> CompactionResult:
        tries = self._busy_retries.get(thread_id, 0) + 1
        if tries > self._config.max_busy_retries:
            self._busy_retries.pop(thread_id, None)
            self._log.info("compaction of %s given up after %d busy attempts", thread_id, tries - 1)
        else:
            self._busy_retries[thread_id] = tries
        return CompactionResult(thread_id, "busy")

    async def _compress(self, session: ThreadSession, context_used: Optional[int],
                        run_id: Optional[str]) -> CompactionResult:
        thread_id = session.thread_id
        before = context_used if context_used is not None else session.context_used
        mapper = EventMapper(clock=self._clock)
        started = self._clock()
        try:
            snapshot = await self._sessions.attach_maintenance(session)
            if snapshot.get("running") or snapshot.get("pending"):
                return self._note_busy(thread_id)
            self._emit(run_id, mapper.bridge_event("compaction.start", data={"before": before}))
            result = await self._link.maintenance.call("session.mutate", {
                "session_id": session.session_id, "request_id": f"compress-{uuid.uuid4()}",
                "expected_revision": int(snapshot.get("revision") or 0),
                "expected_generation": int(snapshot.get("execution_generation") or 0),
                "operation": "compress", "payload": {"partial": True, "keep_last": self._config.keep_last}},
                timeout=self._config.timeout_s)
        except RpcError as exc:
            if exc.reason in ("session_busy", "revision_conflict", "stale_generation"):
                self._emit(run_id, mapper.bridge_event("compaction.end", status="interrupted", summary=exc.reason,
                                                        data={"before": before}))
                return self._note_busy(thread_id)
            return self._failed(session, run_id, mapper, before, started, str(exc))
        except (GatewayUnavailable, RpcTimeout) as exc:
            return self._failed(session, run_id, mapper, before, started, str(exc))
        duration = round((self._clock() - started) * 1000)
        self._busy_retries.pop(thread_id, None)
        self.compactions[thread_id] = self.compactions.get(thread_id, 0) + 1
        session.revision = int(result.get("revision") or session.revision)
        session.execution_generation = int(result.get("execution_generation") or session.execution_generation)
        session.context_used = None  # unknown until the next session.usage
        self._sessions.persist(session)
        await self._sessions.save()
        summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
        headline = summary.get("headline")
        self._emit(run_id, mapper.bridge_event("compaction.end", status="ok", duration_ms=duration, summary=headline,
                                                data={"before": before, "after": None,
                                                      "messageCount": result.get("message_count")}))
        self._log.info("compaction thread=%s ms=%d before=%s %s", thread_id, duration, before, headline or "")
        return CompactionResult(thread_id, "compressed", duration, before, result.get("message_count"),
                                session.revision, headline)

    def _failed(self, session: ThreadSession, run_id: Optional[str], mapper: EventMapper, before: Optional[int],
                started: float, reason: str) -> CompactionResult:
        self._log.warning("compaction of %s failed: %s", session.thread_id, reason)
        self._emit(run_id, mapper.bridge_event("compaction.end", status="error", summary=reason[:200],
                                                data={"before": before}))
        return CompactionResult(session.thread_id, "failed", round((self._clock() - started) * 1000), before)

    def _emit(self, run_id: Optional[str], event) -> None:
        if run_id and self._sink is not None:
            self._sink.emit(run_id, event)
