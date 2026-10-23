"""Bridge-restart recovery (D15) as a background job of one AgentRuntime (H2).

Runs after the sync/control/housekeeping/health loops are up, so an admission that never settles
cannot block the agent. Before the first await, every open admission's thread is reserved in the
scheduler and its message ids are marked accepted: a sync that lands meanwhile can neither start a
second copy of the same message nor collide with the settling turn. Each admission then recovers
on its own task. Whatever happens (a failed save, a crash in one recovery), every reservation is
released in a `finally`. Dispatch records without an admission (persisted right before a submit
that never happened) are simply run again, with their retry attempt.
"""
from __future__ import annotations

import asyncio
from typing import Any, Mapping

from .interfaces import Turn
from .scheduler import InboundMessage, TurnBatch


def _batch(thread_id: str, raws: list[dict[str, Any]], attempt: int) -> TurnBatch:
    return TurnBatch(thread_id, tuple(InboundMessage(str(r["id"]), thread_id, raw=r) for r in raws), attempt)


def _raws_for(data: Mapping[str, Any], submission_id: str, record: Mapping[str, Any]) -> list[dict[str, Any]]:
    saved = data["dispatches"].get(submission_id) or {}
    thread_id = str(record.get("threadId") or "")
    return saved.get("messages") or [{"id": m, "threadId": thread_id} for m in record.get("messageIds") or []]


async def recover(rt: Any) -> None:
    """Settle every open admission concurrently; re-dispatch what never started."""
    data, state = rt.state.data, rt.state
    jobs: list[tuple[str, dict[str, Any], list[dict[str, Any]]]] = []
    reserved: set[str] = set()
    for submission_id, record in state.open_turns().items():
        if record.get("status") not in ("submitted", "running"):
            continue
        thread_id = str(record.get("threadId") or "")
        raws = _raws_for(data, submission_id, record)
        if thread_id:  # synchronously, before any await (review H2: no duplicate copy via sync)
            rt.scheduler.reserve(thread_id)
            reserved.add(thread_id)
        for raw in raws:
            rt._accepted[str(raw["id"])] = thread_id
        jobs.append((submission_id, dict(record), raws))
    try:
        for submission_id in [sid for sid in data["dispatches"] if not state.get_turn(sid)]:
            saved = data["dispatches"].pop(submission_id)
            raws = saved.get("messages") or []
            if raws:  # persisted before submit, never admitted: run it again with its attempt
                thread_id = str(saved["threadId"])
                for raw in raws:
                    rt._accepted[str(raw["id"])] = thread_id
                rt.scheduler.submit_batch(_batch(thread_id, raws, int(saved.get("attempt") or 0)))
        await state.save()
        if jobs:
            await asyncio.gather(*(_recover_one(rt, sid, rec, raws) for sid, rec, raws in jobs),
                                 return_exceptions=True)
        await state.save()
    finally:
        for thread_id in reserved:  # idempotent: a settled thread was already released
            rt.scheduler.release(thread_id)


async def _recover_one(rt: Any, submission_id: str, record: Mapping[str, Any], raws: list[dict[str, Any]]) -> None:
    data = rt.state.data
    thread_id = str(record.get("threadId") or "")
    follow_up = None
    try:
        recovered = await rt.runner.recover({submission_id: record})
        item = recovered[0] if recovered else None
        if item is None or not raws:
            rt.state.drop_turn(submission_id)
            return
        saved = data["dispatches"].get(submission_id) or {}
        batch = _batch(thread_id, raws, int(record.get("attempt") or saved.get("attempt") or 0))
        if item.result is None:  # never admitted: dispatch again
            data["dispatches"].pop(submission_id, None)
            follow_up = batch
            return
        turn = Turn(thread_id=thread_id, trigger_id=str(record.get("triggerId") or raws[-1]["id"]), text="",
                    api_text="", policy=rt.context.policy(thread_id, "direct"),
                    message_ids=tuple(str(r["id"]) for r in raws) if record.get("triggerKind") == "message" else (),
                    attempt=batch.attempt, agent_id=rt.identity.agent_id,
                    trigger_kind=str(record.get("triggerKind") or "message"))
        follow_up = await rt._settle(batch, turn, raws, item.result)
    except Exception as exc:
        rt.log.warning("recovery of %s failed: %s", submission_id, exc)
    finally:
        if follow_up is not None:
            rt.scheduler.submit_batch(follow_up)  # queued first, so it runs before later follow-ups
        else:
            for raw in raws:
                rt._accepted.pop(str(raw["id"]), None)
        if thread_id:
            rt.scheduler.release(thread_id)
