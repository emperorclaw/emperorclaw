"""Inbound messages for one AgentRuntime: the sync long-poll loop and the per-message intake.

H3: the server always returns this agent's still-open targeted direct messages (queued/seen/acting)
whatever the cursor, so a running turn, a deferred retry or a parked reply comes back on every
sync. Those are "repeats": they never mark the state dirty and, when a pass returns nothing but
repeats quickly, the loop backs off (up to IDLE_BACKOFF_MAX_S) instead of spinning. A pass that
the server held open (long-poll) or that brought anything new resets the backoff. M7: while the
server reports `hasMore`, the next page is fetched at once.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from .emperor_api import Verdict, classify, kept_fields, mark_inflight, parse_iso, retry_entries, thread_of
from .scheduler import InboundMessage

POLL_PAUSE_S = 0.3
IDLE_BACKOFF_MAX_S = 5.0
LONG_POLL_HELD_S = 5.0
REPEAT_REASONS = frozenset({"seen", "retry-not-due", "reply-in-outbox"})


def next_sleep(outcomes: list[str], *, has_more: bool, elapsed_s: float, backoff_s: float) -> tuple[float, float]:
    """(seconds to sleep, next backoff) after one sync pass. Pure."""
    progressed = any(o != "repeat" for o in outcomes)
    if has_more and progressed:  # a page of repeats only would loop on the same page forever
        return 0.0, POLL_PAUSE_S
    if not outcomes or progressed or elapsed_s >= LONG_POLL_HELD_S:
        return POLL_PAUSE_S, POLL_PAUSE_S
    grown = min(IDLE_BACKOFF_MAX_S, max(1.0, backoff_s * 2))
    return grown, grown


def due_retry_ids(rt: Any, now: float) -> list[str]:
    """Retry ids worth asking for: not running here and past their backoff."""
    return [m for m, e in retry_entries(rt.state.data).items()
            if m not in rt._accepted and float((e or {}).get("nextRetryAt") or 0) <= now]


async def sync_loop(rt: Any, sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
    error_backoff, idle_backoff = 1.0, POLL_PAUSE_S
    while not rt._stopping:
        if rt.standby_reason or rt.health.get("fatal"):
            await sleep(2)
            continue
        data = rt.state.data
        started = time.monotonic()
        try:
            payload = await rt.client.sync(data.get("lastSeenAt"), due_retry_ids(rt, time.time()))
            error_backoff = 1.0
        except Exception as exc:
            rt._set_error(f"message sync failed: {exc}")
            await sleep(error_backoff)
            error_backoff = min(30.0, error_backoff * 2)
            continue
        rt.context.remember_threads(payload.get("threads"))
        outcomes = [await intake(rt, m) for m in payload.get("messages") or [] if isinstance(m, dict)]
        if advance_cursor(rt, payload.get("nextSince")):
            outcomes.append("new")  # the server skipped an answered page: that is progress
        await rt.state.save_if_dirty()
        pause, idle_backoff = next_sleep(outcomes, has_more=bool(payload.get("hasMore")),
                                         elapsed_s=time.monotonic() - started, backoff_s=idle_backoff)
        await sleep(pause)


def advance_cursor(rt: Any, next_since: Any) -> bool:
    """Move `lastSeenAt` to the server's `nextSince` (end of a page) when it is later (M7)."""
    data = rt.state.data
    target, current = parse_iso(next_since), parse_iso(data.get("lastSeenAt"))
    if target is None or (current is not None and target <= current):
        return False
    data["lastSeenAt"] = str(next_since)
    rt.state.mark_dirty()
    return True


async def intake(rt: Any, message: dict[str, Any]) -> str:
    """Classify and queue one synced message. Returns "dispatch", "repeat" or "new"."""
    data, message_id = rt.state.data, str(message.get("id") or "")
    if message_id in rt._accepted:
        return "repeat"
    verdict = classify(message, agent_id=rt.identity.agent_id, agent_name=rt.cfg.agent_name, data=data,
                       started_at=rt.started_at, loop_guard_max_turns=rt.cfg.loop_guard_max_turns,
                       has_parked_reply=rt.outbox.has_parked)
    created_ts, last_ts = parse_iso(message.get("createdAt")), parse_iso(data.get("lastSeenAt"))
    if created_ts is not None and message_id not in retry_entries(data) and (last_ts is None or created_ts > last_ts):
        data["lastSeenAt"] = message["createdAt"]  # compared as instants, never as strings (LOW-3)
        verdict = Verdict(verdict.action, verdict.reason, mutated=True)
    if verdict.mutated:
        rt.state.mark_dirty()
    if verdict.action == "loop_guard":
        entry = data.get("loopGuard", {}).get(thread_of(message), {})
        if not entry.get("notified"):
            entry["notified"] = True
            rt.state.mark_dirty()
            rt.log.warning("loop guard tripped in thread %s; pausing until a human writes", thread_of(message))
            await rt.replies.post_text(message, f"{rt.cfg.agent_name}: pausing replies in this thread — too many "
                                       "consecutive agent turns without a human message. Send a new instruction "
                                       "to resume.")
        return "new"
    if verdict.action != "dispatch":
        return "repeat" if verdict.reason in REPEAT_REASONS and not verdict.mutated else "new"
    mark_inflight(data, message_id)
    rt.state.mark_dirty()
    rt._accepted[message_id] = thread_of(message)
    result = rt.scheduler.submit(InboundMessage(message_id, thread_of(message) or "team", raw=kept_fields(message),
                                                received_at=time.time()))
    if not result.accepted:
        rt._accepted.pop(message_id, None)
    rt.log.info("accepted message %s thread=%s position=%s coalesced=%s", message_id, thread_of(message),
                result.position, result.coalesced)
    return "dispatch"
