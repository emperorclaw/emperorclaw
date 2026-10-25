"""Run ledger (agent_runs) and usage reporting, fed from the turn's real usage (D16).

One run per admission. With `run-events: 1` the run row is created by the first events batch
(its `run` header), so no separate start POST is sent; an older server that only advertises
`runs: 1` gets the start POST. The finish PATCH carries `prompt.receipt.result` usage, the exit
reason and timing. Reporting is best-effort: a slow or failing ledger never blocks, fails or
repeats a turn (circuit breaker after 3 consecutive failures, 5 minute cooldown, one queued retry
for a transient finish failure, a 4xx is never retried).
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Mapping, Optional

from .interfaces import Turn, TurnOutcome, TurnResult

RUNS_CAPABILITY = "runs: 1"
RUN_EVENTS_CAPABILITY = "run-events: 1"
LEDGER_TIMEOUT_S = 5
BREAKER_THRESHOLD = 3
BREAKER_COOLDOWN_S = 5 * 60
EXIT_REASON_MAX = 120
PROVIDER_CREDITS_ERROR = "provider_credits_exhausted: HTTP 402"


def iso(ts: Optional[float] = None) -> str:
    moment = datetime.fromtimestamp(time.time() if ts is None else ts, timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def is_credits_failure(text: Optional[str]) -> bool:
    import re
    return bool(text) and re.search(r"insufficient credits|credits? (?:are |is )?exhausted|billing or credits"
                                    r"|out of credits|\bHTTP 402\b|error code: 402\b|status(?:=| )402\b",
                                    str(text), re.IGNORECASE) is not None


def error_classification(result: TurnResult) -> Optional[str]:
    """A short, secret-safe error: a classification, never exception or model text."""
    if result.outcome in (TurnOutcome.COMPLETED, TurnOutcome.CANCELLED):
        return None
    if is_credits_failure(result.failure_reason) or is_credits_failure(result.exit_reason):
        return PROVIDER_CREDITS_ERROR
    code = result.error_code or result.outcome.value
    return str(code)[:120]


def start_payload(turn: Turn, *, agent_id: str, runtime_id: str, bridge_version: str, started_at: float,
                  task_id: Optional[str] = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": turn.run_id, "agentId": agent_id, "runtimeId": runtime_id,
                               "runtimeKind": "hermes", "bridgeVersion": bridge_version,
                               "triggerKind": turn.trigger_kind, "startedAt": iso(started_at)}
    if turn.trigger_kind == "message" and turn.message_ids:
        payload["triggerMessageId"] = turn.message_ids[-1]
    if turn.thread_id:
        payload["threadId"] = turn.thread_id
    if task_id:
        payload["taskId"] = task_id
    return payload


def finish_payload(result: TurnResult, *, reply_message_id: Optional[str] = None, events_dropped: int = 0,
                   compactions: Optional[int] = None, ended_at: Optional[float] = None,
                   status_override: Optional[str] = None, error_override: Optional[str] = None) -> dict[str, Any]:
    """PATCH /agents/runs/{id} body (finishRunSchema, run-usage 2). Unset fields are omitted."""
    usage = result.usage
    payload: dict[str, Any] = {"status": status_override or result.outcome.ledger_status, "endedAt": iso(ended_at)}
    exit_reason = (result.exit_reason or "")[:EXIT_REASON_MAX] or None
    for key, value in (("durationMs", result.duration_ms), ("inputTokens", usage.input_tokens),
                       ("outputTokens", usage.output_tokens), ("costCents", usage.cost_cents),
                       ("toolCalls", result.tool_calls), ("cacheReadTokens", usage.cache_read_tokens),
                       ("cacheWriteTokens", usage.cache_write_tokens), ("reasoningTokens", usage.reasoning_tokens),
                       ("apiCalls", usage.api_calls), ("model", (usage.model or "")[:100] or None),
                       ("provider", (usage.provider or "")[:100] or None), ("exitReason", exit_reason),
                       ("queueMs", result.queue_ms), ("firstTokenMs", result.first_token_ms),
                       ("compactions", compactions), ("replyMessageId", reply_message_id),
                       ("error", error_override or error_classification(result))):
        if value is not None:
            payload[key] = max(0, value) if isinstance(value, int) and not isinstance(value, bool) else value
    if events_dropped:
        payload["eventsDropped"] = int(events_dropped)
    return payload


def abandoned_payload(status: str, error: str) -> dict[str, Any]:
    """Finish for a run whose admission never ran (superseded by -rN, or given up), so no ledger
    row is left `running` (review M1)."""
    return {"status": status, "endedAt": iso(), "error": error[:120]}


def usage_report(agent_id: str, result: TurnResult, fallback_model: str = "") -> Optional[dict[str, Any]]:
    """POST /agents/report-usage body from the receipt usage (kept for the company budget)."""
    usage = result.usage
    if not (usage.input_tokens or usage.output_tokens):
        return None
    body: dict[str, Any] = {"agentId": agent_id, "inputTokens": int(usage.input_tokens or 0),
                            "outputTokens": int(usage.output_tokens or 0)}
    model = usage.model or fallback_model
    if model:
        body["model"] = model
    if usage.cost_cents is not None:
        body["costCents"] = usage.cost_cents
    return body


class LedgerBreaker:
    """Opens after N consecutive failures and skips every ledger call for a cooldown window."""

    def __init__(self, threshold: int = BREAKER_THRESHOLD, cooldown: float = BREAKER_COOLDOWN_S,
                 now: Callable[[], float] = time.time, logger: Optional[logging.Logger] = None) -> None:
        self._threshold = threshold
        self._cooldown = cooldown
        self._now = now
        self._log = logger or logging.getLogger("emperor_bridge.ledger")
        self._failures = 0
        self._open_until = 0.0

    @property
    def open(self) -> bool:
        return self._open_until > 0

    def should_skip(self) -> bool:
        if self._open_until <= 0:
            return False
        if self._now() >= self._open_until:
            self._open_until, self._failures = 0.0, 0
            self._log.info("run ledger circuit breaker closed; resuming ledger reporting")
            return False
        return True

    def record_success(self) -> None:
        self._failures = 0

    def record_failure(self) -> None:
        self._failures += 1
        if self._open_until <= 0 and self._failures >= self._threshold:
            self._open_until = self._now() + self._cooldown
            self._log.warning("run ledger circuit breaker open after %d failures; skipping ledger calls for %ds",
                              self._failures, int(self._cooldown))


Request = Callable[..., Awaitable[Any]]


def _retryable(exc: BaseException) -> bool:
    status = getattr(exc, "status_code", None)
    return not (isinstance(status, int) and 400 <= status < 500)


class RunLedger:
    """Best-effort start/finish reporting for one agent. Never raises."""

    def __init__(self, request: Request, *, capabilities: Callable[[], frozenset[str]],
                 logger: Optional[logging.Logger] = None, breaker: Optional[LedgerBreaker] = None,
                 agent_id: str = "") -> None:
        self._request = request
        self._capabilities = capabilities
        # Named on every finish: a company-wide token acts as this agent, which a run in a
        # person's private direct thread needs for its replyMessageId to be accepted.
        self._query = {"agentId": agent_id} if agent_id else None
        self._log = logger or logging.getLogger("emperor_bridge.ledger")
        self.breaker = breaker or LedgerBreaker(logger=self._log)
        self._pending: dict[str, Mapping[str, Any]] = {}
        self._failure_logged = False

    @property
    def enabled(self) -> bool:
        caps = self._capabilities()
        return RUNS_CAPABILITY in caps or RUN_EVENTS_CAPABILITY in caps

    @property
    def needs_start_post(self) -> bool:
        caps = self._capabilities()
        return RUNS_CAPABILITY in caps and RUN_EVENTS_CAPABILITY not in caps

    def _failed(self, where: str, exc: BaseException) -> None:
        self.breaker.record_failure()
        if not self._failure_logged:
            self._failure_logged = True
            self._log.warning("run ledger %s failed (best-effort, continuing): %s", where, exc)

    def _ok(self) -> None:
        self.breaker.record_success()
        self._failure_logged = False

    async def start(self, payload: Mapping[str, Any]) -> bool:
        if not self.needs_start_post or self.breaker.should_skip():
            return False
        try:
            await self._request("POST", "/agents/runs", dict(payload), timeout=LEDGER_TIMEOUT_S)
        except Exception as exc:
            self._failed("start", exc)
            return False
        self._ok()
        return True

    async def finish(self, run_id: str, payload: Mapping[str, Any]) -> bool:
        if not self.enabled or self.breaker.should_skip():
            return False
        try:
            await self._request("PATCH", f"/agents/runs/{run_id}", dict(payload), self._query,
                                timeout=LEDGER_TIMEOUT_S)
        except Exception as exc:
            self._failed("finish", exc)
            if _retryable(exc):
                self._pending[run_id] = dict(payload)
            return False
        self._pending.pop(run_id, None)
        self._ok()
        return True

    async def retry_pending(self) -> None:
        """One more try for each finish that failed transiently; a second failure drops it."""
        pending, self._pending = self._pending, {}
        for run_id, payload in pending.items():
            if self.breaker.should_skip():
                return
            try:
                await self._request("PATCH", f"/agents/runs/{run_id}", dict(payload), self._query,
                                    timeout=LEDGER_TIMEOUT_S)
                self._ok()
            except Exception as exc:
                self._failed("finish retry", exc)


async def flush_usage(request: Request, pending: list[dict[str, Any]]) -> int:
    """POST queued usage reports in order; a refusal (4xx) is dropped, an outage keeps the rest."""
    sent = 0
    while pending:
        try:
            await request("POST", "/agents/report-usage", pending[0], timeout=10)
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            if isinstance(status, int) and status < 500:
                pending.pop(0)
                continue
            return sent
        pending.pop(0)
        sent += 1
    return sent


class BudgetGate:
    """The budget gate before every turn: GET /agents/{id} (`executionAllowed`, `budgetStatus`).
    Cached 30 s when allowed, 10 s when denied; on a failed check the last answer holds for 5
    minutes, then it fails closed."""

    def __init__(self, request: Request, agent_id: str, *, logger: Optional[logging.Logger] = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._request, self._agent_id, self._clock = request, agent_id, clock
        self._log = logger or logging.getLogger("emperor_bridge.ledger")
        self._checked_at, self._allowed, self._good_at = -1e9, True, clock()

    async def allowed(self) -> bool:
        now = self._clock()
        if now - self._checked_at < (30 if self._allowed else 10):
            return self._allowed
        self._checked_at = now
        try:
            payload = await self._request("GET", f"/agents/{self._agent_id}", timeout=10)
        except Exception as exc:
            if now - self._good_at > 300:
                self._allowed = False
            self._log.warning("budget check failed (%s); %s", exc, "keeping the last answer" if self._allowed else "deny")
            return self._allowed
        agent = payload.get("agent", payload) if isinstance(payload, Mapping) else {}
        self._allowed = agent.get("executionAllowed") is not False and agent.get("budgetStatus") != "paused"
        self._good_at = now
        if not self._allowed:
            self._log.warning("dispatch blocked: %s", agent.get("budgetBlockReason") or "budget check denied")
        return self._allowed
