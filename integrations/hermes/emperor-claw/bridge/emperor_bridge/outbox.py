"""Reply outbox: a finished reply is written to disk before the POST that delivers it.

A turn is expensive and, once it settled, over: its text only exists here. A failed POST must
never re-run the prompt (the operator would get silence, then a second, different answer). So the
reply is parked in ``<profile_home>/emperor/outbox/<messageId>.json`` and the POST alone is
retried until it lands. The Idempotency-Key is the turn's submission id (D5: ``emp-<msgId>``,
``-r<n>`` for retries): stable across bridge restarts, so a retry whose earlier attempt was stored
is not stored twice. A refusal (any 4xx, 429 included) spends a budget of ``max_attempts``; no
answer or a 5xx never does. A given-up entry is kept as ``.failed`` for ``redeliver``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence

from .emperor_api import (clear_retry, environment_wait_exhausted, is_soft_failure, remember_seen, schedule_retry,
                          sender_type_of, thread_of, thread_type_of)
from .interfaces import Turn, TurnOutcome, TurnResult
from .ledger import PROVIDER_CREDITS_ERROR, PROVIDER_REASONS, failure_notice_reason, usage_report

Send = Callable[[Mapping[str, Any], str], Awaitable[Optional[str]]]
Delivered = Callable[[dict[str, Any], Optional[str]], Awaitable[None]]
GivenUp = Callable[[dict[str, Any]], Awaitable[None]]


def build_entry(*, message_id: str, thread_id: str, agent_id: str, text: str, idempotency_key: str,
                thread_type: Optional[str] = None, also_resolves: Sequence[str] = (),
                ledger_finish: Optional[Mapping[str, Any]] = None, now: Optional[float] = None) -> dict[str, Any]:
    """The parked-reply record. Pure. Never invents a thread kind (that is how agent-to-agent
    replies used to land in an operator DM); with replyToMessageId the server derives the thread."""
    body: dict[str, Any] = {"thread_id": thread_id, "agentId": agent_id, "text": text, "targetAgentId": None,
                            "replyToMessageId": message_id}
    if also_resolves:
        body["alsoResolvesMessageIds"] = [m for m in also_resolves if m and m != message_id]
    if thread_type:
        body["thread_type"] = thread_type
    entry: dict[str, Any] = {"key": message_id or "unknown", "message_id": message_id, "body": body,
                             "message_ref": {"id": message_id, "threadId": thread_id}, "thread_type": thread_type,
                             "idempotency_key": idempotency_key, "created_at": time.time() if now is None else now,
                             "attempts": 0, "next_at": 0.0}
    if ledger_finish:
        entry["ledger_finish"] = dict(ledger_finish)
    return entry


class Outbox:
    def __init__(self, directory: Path, *, retry_base_s: int = 15, retry_max_s: int = 900, max_attempts: int = 8,
                 logger: Optional[logging.Logger] = None,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self.dir = Path(directory)
        self._base = retry_base_s
        self._max = retry_max_s
        self._max_attempts = max_attempts
        self._log = logger or logging.getLogger("emperor_bridge.outbox")
        self._sleep = sleep
        self._lock = asyncio.Lock()

    # ---- files -----------------------------------------------------------------------------

    def path_for(self, key: str) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(key))
        return self.dir / f"{safe}.json"

    def _write(self, path: Path, entry: Mapping[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(entry, handle, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def put(self, entry: dict[str, Any]) -> dict[str, Any]:
        """Persist before the POST. Raises OSError (the caller then delivers from memory)."""
        self._write(self.path_for(entry["key"]), entry)
        return entry

    def save(self, entry: Mapping[str, Any]) -> None:
        try:
            self._write(self.path_for(str(entry.get("key") or "")), entry)
        except OSError as exc:
            self._log.warning("outbox entry %s not rewritten: %s", entry.get("key"), exc)

    def forget(self, entry: Mapping[str, Any]) -> None:
        for path in (self.path_for(str(entry.get("key") or "")),
                     self.path_for(str(entry.get("key") or "")).with_suffix(".failed")):
            try:
                path.unlink()
            except OSError:
                pass

    def has_parked(self, message_id: str) -> bool:
        return bool(message_id) and self.path_for(message_id).exists()

    def files(self, *, include_failed: bool = True) -> list[Path]:
        if not self.dir.is_dir():
            return []
        found = list(self.dir.glob("*.json"))
        if include_failed:
            found += list(self.dir.glob("*.failed"))
        return sorted(found)

    @staticmethod
    def load(path: Path) -> Optional[dict[str, Any]]:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def import_legacy(self, legacy_dir: Optional[Path]) -> int:
        """Move a 0.3 outbox's parked replies into this outbox (once; never overwrites)."""
        if not legacy_dir or not Path(legacy_dir).is_dir() or Path(legacy_dir).resolve() == self.dir.resolve():
            return 0
        moved = 0
        for path in sorted(list(Path(legacy_dir).glob("*.json")) + list(Path(legacy_dir).glob("*.failed"))):
            target = self.dir / path.name
            if target.exists():
                continue
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                os.replace(path, target)
                moved += 1
            except OSError as exc:
                self._log.warning("legacy outbox entry %s not imported: %s", path.name, exc)
        if moved:
            self._log.info("imported %d parked replies from the 0.3 outbox %s", moved, legacy_dir)
        return moved

    # ---- delivery --------------------------------------------------------------------------

    def _backoff(self, attempts: int) -> float:
        return min(self._max, self._base * (2 ** max(0, min(attempts - 1, 6))))

    async def deliver(self, entry: dict[str, Any], send: Send, on_delivered: Delivered, *, attempts: int = 3) -> Optional[str]:
        """POST one parked reply, retrying only the POST. Returns the stored reply id (None when
        the server deduplicated it or the text was empty). Raises the last error."""
        if not entry.get("idempotency_key"):
            entry["idempotency_key"] = str(uuid.uuid4())  # parked by an older bridge: pin it first
            self.save(entry)
        last: Optional[BaseException] = None
        for attempt in range(1, max(1, attempts) + 1):
            try:
                text = str((entry.get("body") or {}).get("text") or "")
                reply_id = await send(entry.get("body") or {}, str(entry["idempotency_key"])) if text else None
            except Exception as exc:
                last = exc
                if attempt < attempts:
                    delay = self._backoff(attempt)
                    self._log.warning("reply for %s POST failed (%s); retrying in %ss", entry.get("message_id"),
                                      exc, delay)
                    await self._sleep(delay)
                continue
            self.forget(entry)
            self._log.info("reply for %s delivered as %s", entry.get("message_id"), reply_id or "<deduplicated>")
            await on_delivered(entry, reply_id)
            return reply_id
        assert last is not None
        raise last

    async def flush(self, send: Send, on_delivered: Delivered, on_given_up: GivenUp, *,
                    budget_s: float = 60.0) -> int:
        """Retry parked replies whose backoff expired. Returns how many landed."""
        async with self._lock:
            started, delivered = time.monotonic(), 0
            for path in self.files(include_failed=False):
                if budget_s and time.monotonic() - started > budget_s:
                    break
                entry = self.load(path)
                if entry is None:
                    self._log.warning("unreadable outbox entry %s", path.name)
                    continue
                if float(entry.get("next_at") or 0) > time.time():
                    continue
                try:
                    await self.deliver(entry, send, on_delivered, attempts=1)
                    delivered += 1
                except Exception as exc:
                    await self._record_failure(path, entry, exc, on_given_up)
            return delivered

    async def _record_failure(self, path: Path, entry: dict[str, Any], exc: BaseException, on_given_up: GivenUp) -> None:
        attempts = int(entry.get("attempts") or 0) + 1
        entry["attempts"] = attempts
        if not is_soft_failure(exc):
            entry["hard_attempts"] = int(entry.get("hard_attempts") or 0) + 1
        entry["last_error"] = str(exc)[:500]
        entry["next_at"] = time.time() + self._backoff(attempts)
        self.save(entry)
        if int(entry.get("hard_attempts") or 0) < self._max_attempts:
            self._log.warning("reply for %s still undelivered (attempt %d): %s", entry.get("message_id"), attempts,
                              entry["last_error"])
            return
        failed = path.with_suffix(".failed")
        try:
            os.replace(path, failed)
        except OSError:
            failed = path
        self._log.error("reply for %s GIVEN UP after %s refusals; text kept at %s (redeliver with "
                        "`python -m emperor_bridge redeliver %s`): %s", entry.get("message_id"),
                        entry.get("hard_attempts"), failed, entry.get("message_id"), entry["last_error"])
        await on_given_up(entry)

    def find(self, message_id: str) -> Optional[Path]:
        for path in self.files():
            entry = self.load(path)
            if path.stem == message_id or (entry and str(entry.get("message_id")) == message_id):
                return path
        return None

    def requeue(self, path: Path) -> dict[str, Any]:
        """Operator redeliver: a `.failed` entry goes back into the queue, due now."""
        entry = self.load(path) or {}
        target = self.path_for(str(entry.get("key") or path.stem))
        if path != target:
            try:
                os.replace(path, target)
            except OSError:
                target = path
        entry["next_at"] = 0.0
        entry["hard_attempts"] = 0
        self.save(entry)
        return entry


# ---------------------------------------------------------------------------------------------
# Turn outcome -> Emperor (reply, notice, chat status, ledger finish)
# ---------------------------------------------------------------------------------------------

RESTART_NOTICE = ("My runtime restarted while I was working on this, so it stopped before finishing. "
                  "Send it again if you still need it.")
CREDITS_REASON = PROVIDER_REASONS[PROVIDER_CREDITS_ERROR]


def give_up_notice(reason: Optional[str]) -> str:
    return f"I couldn't complete this request{f' ({reason})' if reason else ''}. Send it again if you still need it."


class ReplyDesk:
    """Everything a settled (or never started) turn tells Emperor. One per AgentRuntime."""

    def __init__(self, *, client: Any, outbox: "Outbox", ledger: Any, data: dict[str, Any],
                 save: Callable[[], Awaitable[None]], agent_id: str, retry: Any, llm_model: str,
                 drop_goal_step: Callable[[], None], spawn: Callable[[Any], None], logger: logging.Logger) -> None:
        self.client, self.outbox, self.ledger = client, outbox, ledger
        self._data, self._save, self.agent_id, self._retry = data, save, agent_id, retry
        self._llm_model, self._drop_goal_step, self._spawn, self.log = llm_model, drop_goal_step, spawn, logger
        self.pending_usage: list[dict[str, Any]] = []

    async def deliver(self, turn: Turn, raws: list[dict[str, Any]], result: TurnResult,
                      finish: dict[str, Any]) -> tuple[Optional[str], bool]:
        """Reply (completed), notice (failed, human senders) or nothing (stopped); ledger finish."""
        trigger, data = raws[-1], self._data
        thread_id = thread_of(trigger) or turn.thread_id
        human = sender_type_of(trigger) != "agent" and not trigger.get("goalTurn")
        answers = str(trigger.get("replyToMessageId") or trigger.get("id")) if trigger.get("goalTurn") else str(trigger["id"])
        if result.outcome is TurnOutcome.COMPLETED:
            text = result.final_text
            report = usage_report(self.agent_id, result, self._llm_model)
            if report:
                self.pending_usage.append(report)
        elif result.outcome is TurnOutcome.CANCELLED:
            text = ""
        else:
            # Provider problems (credits, key, model, rate limit, unreachable) name their cause and fix.
            reason = failure_notice_reason(result)
            text = RESTART_NOTICE if result.error_code == "runtime_restart" else give_up_notice(reason)
            text = text if human else ""
            self._spawn(self.status(thread_id, answers, typing=False, execution_state="cancelled",
                                     reason=reason or result.error_code))
        entry = build_entry(message_id=answers, thread_id=thread_id, agent_id=self.agent_id, text=text,
                            idempotency_key=turn.submission_id, thread_type=thread_type_of(trigger) or None,
                            also_resolves=[str(r["id"]) for r in raws[:-1]],
                            ledger_finish={"run_id": turn.run_id, "payload": finish})
        for raw in raws:
            clear_retry(data, str(raw["id"]))
            remember_seen(data, str(raw["id"]))
        if not text:
            await self.ledger.finish(turn.run_id, finish)
            if result.outcome is TurnOutcome.CANCELLED:
                self._spawn(self.status(thread_id, None, typing=False))
            return None, False
        try:
            self.outbox.put(entry)
        except OSError as exc:
            self.log.warning("outbox unavailable (%s); delivering %s from memory", exc, answers)
        try:
            return await self.outbox.deliver(entry, self.send, self.on_delivered), False
        except Exception as exc:
            self.log.warning("reply for %s parked after POST failure (%s); retrying the POST only", answers, exc)
            self._spawn(self.status(thread_id, None, typing=False))
            return None, True

    async def park(self, turn: Turn, raws: list[dict[str, Any]], result: TurnResult,
                   finish: dict[str, Any]) -> None:
        """Write a completed reply to the outbox without POSTing it (standby, LOW-1). The
        housekeeping flush delivers it once this runtime is no longer a duplicate runtime."""
        trigger, data = raws[-1], self._data
        thread_id = thread_of(trigger) or turn.thread_id
        answers = str(trigger.get("replyToMessageId") or trigger.get("id")) if trigger.get("goalTurn") else str(trigger["id"])
        text = result.final_text
        report = usage_report(self.agent_id, result, self._llm_model)
        if report:
            self.pending_usage.append(report)
        entry = build_entry(message_id=answers, thread_id=thread_id, agent_id=self.agent_id, text=text,
                            idempotency_key=turn.submission_id, thread_type=thread_type_of(trigger) or None,
                            also_resolves=[str(r["id"]) for r in raws[:-1]],
                            ledger_finish={"run_id": turn.run_id, "payload": finish})
        for raw in raws:
            clear_retry(data, str(raw["id"]))
            remember_seen(data, str(raw["id"]))
        if not text:
            await self.ledger.finish(turn.run_id, finish)
            return
        try:
            self.outbox.put(entry)
        except OSError as exc:
            self.log.warning("outbox unavailable (%s); parked reply for %s kept in memory", exc, answers)
        self.log.info("reply for %s parked while in standby", answers)

    async def send(self, body: dict[str, Any], key: str) -> Optional[str]:
        return await self.client.send_message(body, idempotency_key=key)

    async def on_delivered(self, entry: dict[str, Any], reply_id: Optional[str]) -> None:
        ledger = entry.get("ledger_finish") or {}
        if ledger.get("run_id"):
            payload = dict(ledger.get("payload") or {})
            if reply_id:
                payload["replyMessageId"] = reply_id
            await self.ledger.finish(str(ledger["run_id"]), payload)
        ref = entry.get("message_ref") or {}
        if not str(ref.get("id") or "").startswith("goal-"):
            await self.status(str(ref.get("threadId") or ""), str(ref.get("id") or ""), typing=False,
                               execution_state="resolved")

    async def on_given_up(self, entry: dict[str, Any]) -> None:
        ledger = entry.get("ledger_finish") or {}
        if ledger.get("run_id"):
            await self.ledger.finish(str(ledger["run_id"]), {**(ledger.get("payload") or {}), "status": "failed",
                                                              "error": "ReplyUndeliverable"})
        ref = entry.get("message_ref") or {}
        await self.status(str(ref.get("threadId") or ""), str(ref.get("id") or ""), typing=False,
                           execution_state="failed")

    async def defer(self, raws: list[dict[str, Any]], *, environment: bool, reason: str,
                    error: Optional[BaseException] = None, gateway: bool = False) -> bool:
        """The turn never started: back off (environment waits never spend the attempt budget). A
        gateway that is restarting is retried within seconds, not on the 45 s Emperor-outage curve.
        Returns True when the trigger message was given up."""
        data, cfg, trigger = self._data, self._retry, raws[-1]
        gave_up = False
        waits = {"wait_floor_s": 2, "wait_cap_s": 30} if gateway else {}
        for raw in raws:
            if raw.get("goalTurn"):
                self._drop_goal_step()
                continue
            message_id = str(raw["id"])
            attempts = schedule_retry(data, message_id, base_s=cfg.retry_base_s, max_s=cfg.retry_max_s,
                                      environment=environment, **waits)
            exhausted = environment and environment_wait_exhausted(data, message_id, cfg.max_environment_wait_s)
            if exhausted or (not environment and attempts >= cfg.max_retry_attempts):
                clear_retry(data, message_id)
                remember_seen(data, message_id)
                gave_up = gave_up or raw is trigger
                if raw is trigger and sender_type_of(raw) != "agent":
                    await self.post_text(raw, give_up_notice("the runtime environment stayed unavailable"
                                                              if exhausted else None))
                await self.status(thread_of(raw), message_id, typing=False, execution_state="cancelled",
                                   reason=reason)
                self.log.error("message %s given up after %d attempts: %s", message_id, attempts, error or reason)
            else:
                await self.status(thread_of(raw), message_id, typing=False, execution_state="queued")
                self.log.warning("message %s deferred (%s, %s %d): %s", message_id, reason,
                                 "wait" if environment else "attempt", attempts, error or reason)
        await self._save()
        return gave_up

    async def announce(self, trigger: dict[str, Any], turn: Turn) -> None:
        await self.status(turn.thread_id, str(trigger["id"]), mark_read=True, execution_state="seen")
        await self.status(turn.thread_id, str(trigger["id"]), typing=True, execution_state="acting")

    async def status(self, thread_id: str, message_id: Optional[str], **kwargs: Any) -> None:
        try:
            await self.client.chat_status(thread_id, message_id=message_id, **kwargs)
        except Exception as exc:
            self.log.info("chat status for %s not sent: %s", message_id or thread_id, exc)

    async def post_text(self, message: dict[str, Any], text: str) -> None:
        body = {"thread_id": thread_of(message), "agentId": self.agent_id, "text": text,
                "targetAgentId": None, "replyToMessageId": message.get("id")}
        if thread_type_of(message):
            body["thread_type"] = thread_type_of(message)
        try:
            await self.client.send_message(body, transport_retry=False)
        except Exception as exc:
            self.log.info("notice for %s not posted: %s", message.get("id"), exc)
