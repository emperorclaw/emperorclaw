from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List


API_URL = os.environ.get("EMPEROR_CLAW_API_URL", "https://emperorclaw.malecu.eu").rstrip("/")
API_TOKEN = os.environ.get("EMPEROR_CLAW_API_TOKEN", "").strip()
AGENT_NAME = os.environ.get("EMPEROR_CLAW_AGENT_NAME", "Hermes")
AGENT_ROLE = os.environ.get("EMPEROR_CLAW_AGENT_ROLE", "operator")
AGENT_INSTRUCTIONS = os.environ.get("EMPEROR_CLAW_AGENT_INSTRUCTIONS", "").strip()
AGENT_ID = os.environ.get("EMPEROR_CLAW_AGENT_ID", "").strip()
RUNTIME_ID = os.environ.get("EMPEROR_CLAW_RUNTIME_ID", f"hermes-{socket.gethostname()}-{uuid.uuid4().hex[:8]}")
HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
# Toolsets handed to the Hermes CLI. The Emperor tools come from the plugin
# (plugins.enabled), NOT from a toolset, so naming the plugin here made Hermes
# warn `Unknown toolsets: emperor-claw` on every single turn — a line that then
# travelled into the agent's reply.
HERMES_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "web,terminal,code_execution").strip()
POLL_SECONDS = float(os.environ.get("EMPEROR_CLAW_HERMES_POLL_SECONDS", "5"))
# Optional absolute per-turn ceiling. Long-running operators legitimately need
# more than 10 or 20 minutes, so the default is unbounded. Stalls are bounded by
# the progress-aware idle timeout below instead of wall-clock duration.
HERMES_TIMEOUT_SECONDS = int(os.environ.get("EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS", "0"))
# Kill only after this much time with no observable runtime progress. Output is
# drained continuously (preventing a full stdout pipe from freezing Hermes),
# and writes to Hermes's agent log/session store renew this timer. Individual
# Hermes tools also have their own timeout, so 15 minutes leaves room for a
# slow tool to fail cleanly and hand control back to the model.
HERMES_IDLE_TIMEOUT_SECONDS = int(os.environ.get("EMPEROR_CLAW_HERMES_IDLE_TIMEOUT_SECONDS", "900"))
# Grace window after SIGTERM before SIGKILL on a timed-out turn: lets Hermes
# checkpoint/save its session transcript so the next dispatch can --resume
# instead of restarting the whole slow turn from scratch.
HERMES_TIMEOUT_GRACE_SECONDS = float(os.environ.get("EMPEROR_CLAW_HERMES_TIMEOUT_GRACE_SECONDS", "10"))

# Grace window before SIGKILL on an orphaned turn left behind by a bridge
# restart (see reap_orphan_turn): long enough for Hermes to finish a tool call
# and flush its session, short enough that the next message is not delayed.
ORPHAN_TURN_GRACE_SECONDS = float(os.environ.get("EMPEROR_CLAW_HERMES_ORPHAN_GRACE_SECONDS", "8"))
STATE_PATH = Path(os.environ.get("EMPEROR_CLAW_HERMES_STATE_PATH", Path.home() / ".hermes" / "emperor-bridge-state.json"))
RETRY_BASE_SECONDS = max(1, int(os.environ.get("EMPEROR_CLAW_HERMES_RETRY_BASE_SECONDS", "15")))
RETRY_MAX_SECONDS = max(RETRY_BASE_SECONDS, int(os.environ.get("EMPEROR_CLAW_HERMES_RETRY_MAX_SECONDS", "300")))
MAX_RETRY_ATTEMPTS = max(1, int(os.environ.get("EMPEROR_CLAW_HERMES_MAX_RETRY_ATTEMPTS", "3")))
# Transport-level resilience. A burst of getaddrinfo failures (systemd-resolved
# returning EAI_AGAIN/SERVFAIL for a few hundred ms) or one stalled TLS
# handshake used to abort the whole loop iteration: the exception unwound past
# the heartbeat and the message sync that follow it, so the agent looked mute
# for the duration of the burst. Two short re-resolves turn that into a
# sub-second delay. Real HTTP answers (HTTPError) are never retried here, and
# the attempt is bounded so a hard outage still fails fast and loudly.
# Bursts are not sub-second: the USB wifi (rtw88_8822bu) stalls the whole link
# for ~9-11 s when its firmware loses tx reports, which fails DNS and TLS
# together. A ~1 s budget is therefore too small; the defaults below cover one
# full observed stall while the total budget keeps a real outage bounded.
TRANSPORT_ATTEMPTS = max(1, int(os.environ.get("EMPEROR_CLAW_HERMES_TRANSPORT_ATTEMPTS", "6")))
TRANSPORT_BACKOFF_SECONDS = max(0.0, float(os.environ.get("EMPEROR_CLAW_HERMES_TRANSPORT_BACKOFF_SECONDS", "0.5")))
TRANSPORT_BACKOFF_MAX_SECONDS = max(TRANSPORT_BACKOFF_SECONDS, float(os.environ.get("EMPEROR_CLAW_HERMES_TRANSPORT_BACKOFF_MAX_SECONDS", "3")))
TRANSPORT_TOTAL_BUDGET_SECONDS = max(TRANSPORT_BACKOFF_SECONDS, float(os.environ.get("EMPEROR_CLAW_HERMES_TRANSPORT_TOTAL_BUDGET_SECONDS", "25")))
# Session-ownership contention (SESSION_NOT_OWNED / SESSION_COORDINATION_UNAVAILABLE)
# is NOT a bad prompt: another live process holds the session lease. The
# 2026-10-21 failure: a 20-minute CLI turn owned the session, the bridge resumed
# the same id, was refused three times inside ~75 s and cancelled the message
# visibly -- the agent looked mute. Contention therefore gets its own, far
# longer backoff curve and never consumes the poison-prompt budget above.
# After SESSION_BUSY_FRESH_AFTER waits the turn is retried on a fresh session
# (static block re-primed) rather than deferred forever behind a wedged owner.
SESSION_BUSY_BASE_SECONDS = max(5, int(os.environ.get("EMPEROR_CLAW_HERMES_SESSION_BUSY_BASE_SECONDS", "45")))
SESSION_BUSY_MAX_SECONDS = max(
    SESSION_BUSY_BASE_SECONDS, int(os.environ.get("EMPEROR_CLAW_HERMES_SESSION_BUSY_MAX_SECONDS", "600"))
)
SESSION_BUSY_FRESH_AFTER = max(1, int(os.environ.get("EMPEROR_CLAW_HERMES_SESSION_BUSY_FRESH_AFTER", "3")))
# Environment waits never spend the attempt budget, so without a ceiling a
# failure that only looks environmental (a provider that keeps timing out) would
# retry a paid turn every <=600 s forever. Past this many seconds since the
# message's first dispatch attempt the bridge gives up visibly instead.
MAX_ENVIRONMENT_WAIT_SECONDS = max(
    60, int(os.environ.get("EMPEROR_CLAW_HERMES_MAX_ENVIRONMENT_WAIT_SECONDS", "86400"))
)
SESSION_CONTENTION_REASONS = frozenset(
    {"SESSION_NOT_OWNED", "SESSION_COORDINATION_UNAVAILABLE", "MAX_CONCURRENT_SESSIONS"}
)
# A transient network fault is the same class of problem: the environment is
# briefly broken, the prompt is fine. The 2026-10-21 incident also showed
# `Temporary failure in name resolution` bursts inside the bridges (name
# resolution answers in 18-24 ms outside the burst), and three fast retries
# inside such a burst retired the message. So DNS/TLS/socket/5xx failures wait
# on the long curve too instead of consuming the poison-prompt budget.
TRANSIENT_FAILURE_MARKERS = (
    "temporary failure in name resolution",
    "name or service not known",
    "nodename nor servname",
    "connection reset",
    "connection aborted",
    "connection refused",
    "remote end closed",
    "network is unreachable",
    "tls handshake",
    "ssl: ",
    "timed out",
    "timeout",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
)
DOCTRINE_RESOURCE_ID = os.environ.get("EMPEROR_CLAW_DOCTRINE_RESOURCE_ID", "").strip()
# Path to the operating guide prepended to every turn's system prompt. Unset,
# the bridge uses the packaged `operating-guide.md` next to its parent directory
# (the repo/image layout). Set this when a deployment does not mirror that tree —
# e.g. a flattened `emperor-bridge/` directory holding only the bridge script.
OPERATING_GUIDE_PATH = os.environ.get("EMPEROR_CLAW_OPERATING_GUIDE_PATH", "").strip()
# Context is included on every Hermes turn, including quick direct questions.
# Keep the default deliberately small: a larger corpus can always be retrieved
# by the agent through Emperor tools, while repeatedly injecting it makes one
# slow turn block this single-threaded bridge's entire message queue.
MAX_SHARED_RESOURCE_CHARS = int(os.environ.get("EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS", "6000"))
# Per-resource ceiling within that total. Left unset, the server applies its
# own default (8000 chars) regardless of how high MAX_SHARED_RESOURCE_CHARS
# is raised — a single long doctrine/playbook note can silently eat that
# whole per-resource cap and get truncated even with a generous total pool.
MAX_CHARS_PER_RESOURCE = int(os.environ.get("EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS_PER_RESOURCE", "0")) or None
# DM awareness: a direct message runs in its own Hermes session (keyed by the
# direct thread), so from a DM the agent never sees the shared team channel —
# ask it "what did you and X talk about?" and it draws a blank. When replying in
# a DM we inject a read-only digest of the recent team channel so it can answer.
# Set the limit to 0 to disable the injection entirely.
MAIN_CHAT_CONTEXT_LIMIT = int(os.environ.get("EMPEROR_CLAW_MAIN_CHAT_CONTEXT_LIMIT", "6"))
MAIN_CHAT_CONTEXT_MAX_CHARS = int(os.environ.get("EMPEROR_CLAW_MAIN_CHAT_CONTEXT_MAX_CHARS", "1800"))
MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS = int(os.environ.get("EMPEROR_CLAW_MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS", "300"))
# Rich replies (charts, KPI tiles, tabs, sandboxed HTML widgets). The server
# advertises support and ships the matching reply-format guide in its
# /runtime/register response; a server that doesn't is never sent rich blocks.
# Set EMPEROR_CLAW_RICH_REPLIES=off to keep an agent on plain Markdown.
RICH_REPLIES_ENABLED = os.environ.get("EMPEROR_CLAW_RICH_REPLIES", "on").strip().lower() not in {"0", "off", "false", "no"}
RICH_BLOCKS_CAPABILITY = "rich-blocks-v1"
# Run-ledger capability: a server advertising it accepts POST/PATCH /agents/runs.
# An older server never does, so an upgraded bridge skips ledger reporting
# entirely rather than erroring. Keep in step with the server's SERVER_CAPABILITIES.
RUNS_CAPABILITY = "runs: 1"
# Bridge release, reported to the run ledger (and in the User-Agent). Stays in
# step with plugin.yaml; bump both together on release.
BRIDGE_VERSION = "0.3.0"
# Context mode. `full` (default) keeps today's static block: the operating
# guide, the lookup/storage/messaging rules, the rich-reply guide, and the
# Company Brain bodies. `lean` swaps that pinned head for the server's Tier 0/1
# payload (kernel + knowledge index + always-block + roster) — available on
# demand, never always sent — but ONLY when the server advertises the
# capability. An older server is never sent lean context: the bridge logs once
# and stays on `full`.
CONTEXT_MODE = os.environ.get("EMPEROR_CLAW_CONTEXT_MODE", "full").strip().lower()
# Keep in step with the server's SERVER_CAPABILITIES (src/lib/rich-reply-guide.ts).
LEAN_CONTEXT_CAPABILITY = "lean-context: 1"
# The lean payload is fetched once per session and re-validated (If-None-Match)
# at most this often, so the pinned head stays byte-stable between checks.
LEAN_REVALIDATE_SECONDS = float(os.environ.get("EMPEROR_CLAW_LEAN_REVALIDATE_SECONDS", "600"))
# The dispatch loop is sequential: a slow or failing lean fetch must not stall
# every turn. Short timeout, and after a failure wait this long before retrying.
LEAN_FETCH_TIMEOUT_SECONDS = 5
LEAN_FAILURE_BACKOFF_SECONDS = 60
# Re-run the /runtime/register handshake this often, so a server upgraded
# after the bridge started is picked up without restarting the bridge.
CAPABILITY_REFRESH_SECONDS = float(os.environ.get("EMPEROR_CLAW_CAPABILITY_REFRESH_SECONDS", "600"))
# The optional rich-reply guide is convenience documentation, not task
# context. It must never dominate a lightweight chat turn.
MAX_REPLY_FORMAT_GUIDE_CHARS = 1600
# Loop guard: the @mention convention (reply once, then go silent) is a prompt
# convention, not a hard rule — an LLM can still misjudge a "closing" reply as
# needing another response. This is a mechanical backstop: once this agent has
# been triggered by this many consecutive agent-authored messages in the same
# team thread with no human message in between, stop invoking Hermes and post
# one pause notice instead, until a human message resets the counter.
LOOP_GUARD_MAX_AGENT_TURNS = int(os.environ.get("EMPEROR_CLAW_LOOP_GUARD_MAX_TURNS", "3"))
# Per-turn "acknowledge first" reminder on human-originated turns. Set
# EMPEROR_CLAW_HERMES_ACK_FIRST=0 to stop sending it (the guide text stays).
ACK_FIRST_ENABLED = os.environ.get("EMPEROR_CLAW_HERMES_ACK_FIRST", "1").strip().lower() not in {"0", "off", "false", "no"}

# ── Prompt economics: static/dynamic split ───────────────────────────────────
# The static block (operating guide, messaging/storage/lookup rules, roster,
# brain context, role instructions, memory) used to be sent as the user turn of
# every --resume'd wake, so it accumulated in the session history forever
# (quadratic growth). Now it is sent only on the first turn of a session; a
# resumed turn sends only the dynamic block. A session is re-primed when the
# static block's hash changes (doctrine/roster/brain edited).
SESSION_MAX_TURNS = int(os.environ.get("EMPEROR_CLAW_HERMES_SESSION_MAX_TURNS", "40"))
SESSION_MAX_HOURS = float(os.environ.get("EMPEROR_CLAW_HERMES_SESSION_MAX_HOURS", "24"))
# Direct human↔agent threads keep resuming but obey a larger cap.
DIRECT_SESSION_MAX_TURNS = int(os.environ.get("EMPEROR_CLAW_HERMES_DIRECT_SESSION_MAX_TURNS", "400"))
DIRECT_SESSION_MAX_HOURS = float(os.environ.get("EMPEROR_CLAW_HERMES_DIRECT_SESSION_MAX_HOURS", "168"))
# Static-block cache. Building the block costs several sequential API calls
# (roster, Company Brain, live profile) on every turn, yet a resumed session
# only ever uses its hash. A resumed turn therefore reuses the hash already
# recorded for its session and rebuilds the block in the background at most
# this often; a changed hash re-primes the session on the next turn. New
# sessions always build synchronously. 0 disables the cache (build every turn).
STATIC_BLOCK_REFRESH_SECONDS = max(
    0.0, float(os.environ.get("EMPEROR_CLAW_STATIC_BLOCK_REFRESH_MINUTES", "10")) * 60.0
)
# Independent pre-dispatch API calls (status, heartbeat, run start, context
# lookups) run on this many worker threads instead of one after another. 1
# restores the old strictly sequential behaviour.
PREDISPATCH_WORKERS = max(1, int(os.environ.get("EMPEROR_CLAW_HERMES_PREDISPATCH_WORKERS", "8")))
OPEN_TASKS_LIMIT = int(os.environ.get("EMPEROR_CLAW_OPEN_TASKS_LIMIT", "5"))
_OPEN_TASK_STATES = {"inbox", "in_progress", "review"}

# Cached agent LLM provider — read once at startup for documentation
_agent_llm_provider: str | None = None
_agent_llm_model: str | None = None
# Resolved once per process — the company's team thread is stable, and looking
# it up on every DM turn would add a needless round-trip.
_team_thread_id_cache: str | None = None


def log(message: str) -> None:
    """Timestamped log line.

    The timestamp is not decoration: the watchdog and QA correlate bridge
    events with per-profile state and systemd, and an undated line
    ("[emperor-hermes] session ... refused") is impossible to place.
    """
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{stamp}] [emperor-hermes] {message}", flush=True)


class ApiError(RuntimeError):
    """An HTTP error from the Emperor API, carrying the numeric status.

    The run ledger uses the status to tell a transient failure (timeout, 5xx)
    apart from a permanent one (4xx, e.g. a rejected payload), which is never
    retried. Subclasses RuntimeError so existing `except RuntimeError` callers
    keep working.
    """

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


_TRANSIENT_TRANSPORT_MARKERS = (
    "name resolution",
    "temporary failure",
    "timed out",
    "connection reset",
    "connection refused",
    "network is unreachable",
    "eof occurred",
    "broken pipe",
)


def _is_transient_transport_error(exc: BaseException) -> bool:
    """True for failures a retry can plausibly fix (DNS blip, timeout, reset).

    HTTPError is deliberately excluded: that is a real answer from the API.
    """
    reason = getattr(exc, "reason", None) or exc
    if isinstance(reason, socket.gaierror):
        return True
    if isinstance(reason, (socket.timeout, TimeoutError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return True
    text = str(reason).lower()
    return any(marker in text for marker in _TRANSIENT_TRANSPORT_MARKERS)


def _urlopen_retrying(req: urllib.request.Request, timeout: float, max_attempts: int | None = None):
    """urlopen with a short bounded retry on transient transport errors.

    Returns the open response; the caller owns the context manager. A retry
    that eventually succeeds is silent (the log stays as quiet as before); a
    retry that gives up logs once so the outage is still visible.
    """
    attempt = 1
    started = time.monotonic()
    while True:
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, OSError) as exc:
            remaining = TRANSPORT_TOTAL_BUDGET_SECONDS - (time.monotonic() - started)
            if (
                attempt >= (TRANSPORT_ATTEMPTS if max_attempts is None else max(1, max_attempts))
                or remaining <= 0
                or not _is_transient_transport_error(exc)
            ):
                if attempt > 1:
                    log(f"transport gave up after {attempt} attempts in {time.monotonic() - started:.1f}s: {exc}")
                raise
            delay = min(TRANSPORT_BACKOFF_MAX_SECONDS, TRANSPORT_BACKOFF_SECONDS * (2 ** (attempt - 1)), remaining)
            if delay > 0:
                time.sleep(delay)
            attempt += 1


def api(
    method: str,
    path: str,
    body: Dict[str, Any] | None = None,
    query: Dict[str, Any] | None = None,
    timeout: int = 30,
    *,
    transport_retry: bool = True,
    idempotency_key: str | None = None,
) -> Dict[str, Any]:
    if not API_TOKEN:
        raise RuntimeError("EMPEROR_CLAW_API_TOKEN is required")
    clean_path = "/" + path.lstrip("/")
    if not clean_path.startswith("/api/"):
        clean_path = "/api/mcp" + clean_path
    url = API_URL + clean_path
    if query:
        pairs = {key: value for key, value in query.items() if value not in (None, "")}
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)
    payload = None
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Accept": "application/json",
        "User-Agent": f"emperor-hermes-bridge/{BRIDGE_VERSION}",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        # A caller retrying the same logical write (the reply outbox) passes a
        # stable key so the server can recognise the retry; otherwise each call
        # is its own write.
        headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
    req = urllib.request.Request(url, data=payload, headers=headers, method=method.upper())
    try:
        with _urlopen_retrying(req, timeout, None if transport_retry else 1) as res:
            text = res.read().decode("utf-8", errors="replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"Emperor API {method} {path} failed {exc.code}: {text[:500]}", exc.code) from exc


_predispatch_pool: ThreadPoolExecutor | None = None
_predispatch_pool_lock = threading.Lock()


def _pool() -> ThreadPoolExecutor:
    global _predispatch_pool
    with _predispatch_pool_lock:
        if _predispatch_pool is None:
            _predispatch_pool = ThreadPoolExecutor(max_workers=PREDISPATCH_WORKERS, thread_name_prefix="emperor-predispatch")
        return _predispatch_pool


def submit_background(fn: Callable[[], Any]):
    """Start ``fn`` on the pre-dispatch pool and return its future."""
    return _pool().submit(fn)


def run_parallel(calls: Dict[str, Callable[[], Any]]) -> Dict[str, Any]:
    """Run independent calls concurrently and return their results by name.

    Every pre-dispatch API call is a full round trip to the control plane, and
    a turn used to make up to a dozen of them one after another before Hermes
    even started. These calls do not depend on each other, so they overlap.
    The first exception (in ``calls`` order) is re-raised once all calls have
    finished, which keeps the sequential semantics callers already rely on.
    Callers must never be pool workers themselves: a worker waiting on the
    pool it runs in can starve it.
    """
    if PREDISPATCH_WORKERS <= 1 or len(calls) <= 1:
        return {name: fn() for name, fn in calls.items()}
    futures = {name: _pool().submit(fn) for name, fn in calls.items()}
    results: Dict[str, Any] = {}
    first_exc: BaseException | None = None
    for name, future in futures.items():
        try:
            results[name] = future.result()
        except Exception as exc:  # noqa: BLE001 - re-raised below
            if first_exc is None:
                first_exc = exc
    if first_exc is not None:
        raise first_exc
    return results


def load_state() -> Dict[str, Any]:
    # Prefer the live file, then the last good backup, and preserve a corrupt
    # file instead of silently discarding all bridge state (sessions, thread
    # ownership, and the loop/cold-start guards all live here).
    for candidate in (STATE_PATH, STATE_PATH.with_name(STATE_PATH.name + ".bak")):
        if not candidate.exists():
            continue
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except Exception:
            try:
                os.replace(candidate, candidate.with_name(candidate.name + ".corrupt"))
            except OSError:
                pass
    return {"seen": [], "lastSeenAt": None}


def save_state(state: Dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temp file and atomically replace it: a crash mid-write must
    # never leave a truncated JSON file, which would wipe every session and
    # guard on the next load. Keep the previous file as .bak.
    tmp_path = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    tmp_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    if STATE_PATH.exists():
        try:
            os.replace(STATE_PATH, STATE_PATH.with_name(STATE_PATH.name + ".bak"))
        except OSError:
            pass
    os.replace(tmp_path, STATE_PATH)


def remember_seen(state: Dict[str, Any], message_id: str) -> bool:
    seen = list(state.get("seen") or [])
    if message_id in seen:
        return False
    seen.append(message_id)
    state["seen"] = seen[-1000:]
    return True


def retry_entries(state: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Return the durable retry ledger, tolerating state written by older bridges."""
    entries = state.get("retries")
    if not isinstance(entries, dict):
        entries = {}
        state["retries"] = entries
    return entries


def retry_due(state: Dict[str, Any], message_id: str, now: float | None = None) -> bool:
    entry = retry_entries(state).get(message_id)
    if not isinstance(entry, dict):
        return True
    return float(entry.get("nextRetryAt", 0) or 0) <= (time.time() if now is None else now)


def schedule_retry(
    state: Dict[str, Any],
    message_id: str,
    now: float | None = None,
    *,
    busy: bool = False,
    first_attempt_at: float | None = None,
) -> int:
    """Persist bounded exponential backoff so a broken runtime cannot spin or lose work.

    ``busy=True`` marks session-ownership contention: it backs off on a much
    longer curve (45 s doubling up to 600 s) and counts its own ``busyMisses``,
    because the owner that must release the session can be a human CLI turn that
    legitimately runs for 20+ minutes.

    A busy wait never increments ``attempts``: that counter is the poison-prompt
    budget that ends in a visible cancel, and only a genuine Hermes/model
    failure may spend it. (It used to increment on every wait too, so two
    environment waits plus one real failure retired a human's message.) The
    return value is the counter that moved: ``busyMisses`` for a wait,
    ``attempts`` otherwise.

    ``firstAttemptAt`` records the first dispatch attempt once and is never
    moved, so environment_wait_exhausted can bound the total wait.
    """
    current = retry_entries(state).get(message_id)
    current = current if isinstance(current, dict) else {}
    entry = dict(current)
    if not entry.get("firstAttemptAt"):
        entry["firstAttemptAt"] = first_attempt_at or (time.time() if now is None else now)
    if busy:
        misses = int(current.get("busyMisses", 0)) + 1
        entry["attempts"] = int(current.get("attempts", 0))
        entry["busyMisses"] = misses
        entry["busy"] = True
        delay = min(SESSION_BUSY_MAX_SECONDS, SESSION_BUSY_BASE_SECONDS * (2 ** min(misses - 1, 10)))
        entry["nextRetryAt"] = (time.time() if now is None else now) + delay
        retry_entries(state)[message_id] = entry
        return misses
    attempts = int(current.get("attempts", 0)) + 1
    entry["attempts"] = attempts
    entry.pop("busyMisses", None)
    entry.pop("busy", None)
    delay = min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** min(attempts - 1, 16)))
    entry["nextRetryAt"] = (time.time() if now is None else now) + delay
    retry_entries(state)[message_id] = entry
    return attempts


def environment_wait_exhausted(state: Dict[str, Any], message_id: str, now: float | None = None) -> bool:
    """True once a message has waited on the environment past the ceiling.

    Measured from the first dispatch attempt, not the last failure: the point
    is to bound how long one message can keep re-running a paid turn.
    """
    entry = retry_entries(state).get(message_id)
    if not isinstance(entry, dict):
        return False
    try:
        first = float(entry.get("firstAttemptAt") or 0)
    except (TypeError, ValueError):
        return False
    if first <= 0:
        return False
    return (time.time() if now is None else now) - first >= MAX_ENVIRONMENT_WAIT_SECONDS


def busy_misses(state: Dict[str, Any], message: Dict[str, Any]) -> int:
    """How many session-contention waits this message has already absorbed."""
    entry = retry_entries(state).get(str(message.get("id") or ""))
    if not isinstance(entry, dict):
        return 0
    try:
        return int(entry.get("busyMisses") or 0)
    except (TypeError, ValueError):
        return 0


_REFUSAL_REASON_RE = re.compile(r"hermes-refusal-reason:\s*([A-Z_]+)")


class SessionBusy(RuntimeError):
    """Another live process holds this session's lease; waiting is the fix."""

    def __init__(self, reason: str, detail: str = "") -> None:
        self.reason = reason or "SESSION_NOT_OWNED"
        self.detail = detail
        super().__init__(f"{self.reason}: session lease held by another live process" + (f" ({detail[:200]})" if detail else ""))


class HermesTurnFailed(RuntimeError):
    """Hermes exited non-zero. ``str()`` is the human-facing detail, which can
    be the model's own reply or stdout; ``stderr`` is Hermes's diagnostic
    stream. Only ``stderr`` may be used to classify the failure: a reply that
    happens to say "timed out" must not turn into an environment wait."""

    def __init__(self, detail: str, *, stderr: str = "") -> None:
        super().__init__(detail)
        self.stderr = stderr or ""


def parse_refusal_reason(*texts: str) -> str:
    """The machine-readable reason Hermes prints for a refused turn, if any.

    ``format_refusal_stderr`` in hermes_cli/active_sessions.py writes
    ``hermes-refusal-reason: <REASON>`` across the one-shot CLI boundary; the
    reason is the contract, the message beside it is for people.
    """
    for text in texts:
        match = _REFUSAL_REASON_RE.search(text or "")
        if match:
            return match.group(1)
    return ""


def is_session_contention(*texts: str) -> bool:
    """True when a failure means "wait for the other owner", not "bad prompt"."""
    reason = parse_refusal_reason(*texts)
    if reason:
        return reason in SESSION_CONTENTION_REASONS
    blob = " ".join(text or "" for text in texts)
    if "SESSION_NOT_OWNED" in blob or "SESSION_COORDINATION_UNAVAILABLE" in blob:
        return True
    return "Session store unavailable" in blob


def is_transient_failure(*texts: str) -> bool:
    """True when the failure is the environment blinking, not the prompt.

    Waiting is the correct response: the same message succeeds once DNS, the
    socket or the upstream 5xx recovers. See TRANSIENT_FAILURE_MARKERS.
    """
    blob = " ".join(text or "" for text in texts).lower()
    return any(marker in blob for marker in TRANSIENT_FAILURE_MARKERS)


def is_environment_failure(exc: BaseException) -> bool:
    """True when a failed turn says nothing about the prompt or the model.

    Environment failures (session contention, the Emperor API unreachable, DNS,
    a 5xx) wait on the long backoff and never spend the attempt budget, so they
    can never cancel a human's message. Only genuine Hermes/model failures do:
    a non-zero Hermes exit, a stall or wall-clock timeout, a provider refusal.
    The timeouts are checked first on purpose: their description says "timed
    out", which the transient-marker scan below would otherwise misread as a
    network blip and retry forever.

    A failed Hermes turn is classified on Hermes's stderr only, never on its
    stdout or the streamed reply: those carry model text, and a reply that
    mentions "connection refused" is not an outage. The remaining text scan
    only ever sees the bridge's own exceptions.
    """
    if isinstance(exc, (subprocess.TimeoutExpired, subprocess.CalledProcessError, TurnInterrupted)):
        return False
    if isinstance(exc, SessionBusy):
        return True
    if isinstance(exc, HermesTurnFailed):
        return is_session_contention(exc.stderr) or is_transient_failure(exc.stderr)
    if isinstance(exc, ApiError):
        status = exc.status_code or 0
        return status >= 500 or status in (408, 425, 429)
    if isinstance(exc, urllib.error.URLError) or isinstance(exc, (socket.gaierror, socket.timeout, ConnectionError)):
        return True
    description = describe_processing_error(exc)
    return is_session_contention(description) or is_transient_failure(description)


def _hermes_home() -> Path | None:
    """This runtime's HERMES_HOME, falling back to the configured profile."""
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if hermes_home:
        return Path(hermes_home)
    profile = os.environ.get("HERMES_PROFILE", "").strip() or os.environ.get("EMPEROR_CLAW_HERMES_PROFILE", "").strip()
    if profile:
        return Path.home() / ".hermes" / "profiles" / profile
    return None


def _proc_ppid(pid: int) -> int:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return int(fields[1])
    except (OSError, IndexError, ValueError):
        return 0


def _pid_is_ancestor_or_self(pid: int) -> bool:
    """True when ``pid`` is this process or one of its ancestors.

    Deliberately *not* "is a child of ours": sibling turns spawned by the same
    bridge are exactly the owners that cause SESSION_NOT_OWNED, so they must
    count as foreign. Only the bridge itself (and systemd above it) can never
    be the lease holder.
    """
    current = os.getpid()
    for _ in range(8):
        if current <= 1:
            return False
        if current == pid:
            return True
        current = _proc_ppid(current)
    return False


def describe_pid(pid: int) -> str:
    """`hermes chat, builder, 12m, unit` — who is holding a lease."""
    if pid <= 0:
        return "no pid"
    cmd = "hermes chat" if " chat " in f" {_proc_cmdline(pid)} " else (_proc_cmdline(pid).split("/")[-1][:40] or "?")
    profile = _proc_env(pid, "HERMES_PROFILE") or "?"
    age = "?"
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        start_ticks = int(fields[19])
        uptime = float(Path("/proc/uptime").read_text().split()[0])
        age = f"{int((uptime - start_ticks / os.sysconf('SC_CLK_TCK')) // 60)}m"
    except (OSError, IndexError, ValueError):
        pass
    try:
        unit = Path(f"/proc/{pid}/cgroup").read_text().strip().split("/")[-1].split(".service")[0]
    except OSError:
        unit = "?"
    ppid = _proc_ppid(pid)
    return f"{cmd}, profile {profile}, {age} old, unit {unit or '?'}, ppid {ppid}"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    # A zombie still answers kill(0); it owns nothing.
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return True


def _proc_cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def _proc_env(pid: int, key: str) -> str:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return ""
    prefix = key.encode() + b"="
    for chunk in raw.split(b"\0"):
        if chunk.startswith(prefix):
            return chunk[len(prefix):].decode("utf-8", "replace")
    return ""


def _bridge_home() -> str:
    return str(_hermes_home() or "")


def _is_supervisor(pid: int) -> bool:
    """True for init or the systemd user manager — where orphans are reparented.

    On this host an orphan is re-parented to `systemd --user` (pid 1712), not
    to pid 1: requiring `ppid == 1` would never match a real survivor.
    """
    if pid <= 1:
        return True
    cmd = _proc_cmdline(pid)
    return "systemd" in cmd and "--user" in cmd


def _own_turn_orphan(pid: int) -> bool:
    """True for an abandoned `hermes ... chat` turn belonging to this profile.

    Scope first: a normal `systemctl restart` is NOT what leaves these behind.
    The unit runs with `KillMode=control-group`, so systemd signals the whole
    cgroup and the turn dies with the bridge -- observed on four restarts with
    zero survivors. Survivors come from the paths that skip that signal: an
    OOM kill of the bridge, `kill` (or a crash) of the main pid alone, or a
    stop that times out into SIGKILL while the child is in its own session
    (`invoke_hermes` uses `start_new_session=True`). Such a turn keeps a write
    handle on `state.db`; the restarted bridge then takes the same message and
    the profile runs two writers -- the shape that retires a WAL. Only a
    reparented turn (ppid init / `systemd --user`) of our own HERMES_HOME
    qualifies, so a turn somebody is actively driving is never touched.
    """
    if pid <= 0 or pid == os.getpid() or _pid_is_ancestor_or_self(pid):
        return False
    cmd = _proc_cmdline(pid)
    if " chat " not in f" {cmd} " or "hermes" not in cmd.lower():
        return False
    if _proc_ppid(pid) != 1 and not _is_supervisor(_proc_ppid(pid)):
        return False
    home = _proc_env(pid, "HERMES_HOME")
    profile = _proc_env(pid, "HERMES_PROFILE")
    target = home or (str(Path.home() / ".hermes" / "profiles" / profile) if profile else "")
    return bool(target) and target == _bridge_home()


def reap_orphan_turn(pid: int, *, reason: str) -> bool:
    """Kill an abandoned turn of this profile; True when it was one."""
    if not _own_turn_orphan(pid):
        return False
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return True  # already gone
    deadline = time.time() + ORPHAN_TURN_GRACE_SECONDS
    while time.time() < deadline:
        if not _pid_alive(pid):
            break
        time.sleep(0.2)
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except OSError:
            pass
        log(f"orphan turn pid {pid} ignored SIGTERM -> SIGKILL")
    log(f"reaped orphan turn pid {pid} ({reason})")
    return True


def reap_orphan_turns() -> int:
    """Sweep abandoned turns of this profile at startup (see _own_turn_orphan).
    Linux only: without /proc there is no portable way to find them, so skip."""
    reaped = 0
    proc = Path("/proc")
    if not proc.is_dir():
        return 0
    for entry in proc.iterdir():
        if entry.name.isdigit() and reap_orphan_turn(int(entry.name), reason="bridge start"):
            reaped += 1
    if reaped:
        log(f"startup sweep reaped {reaped} orphan turn(s) of this profile")
    return reaped


def session_holder_pid(session_id: str) -> int | None:
    """Live foreign pid holding this session in the profile's lease registry.

    Hermes enforces one writer per session (``PER_SESSION_EXCLUSIVE_SUBMIT``), so
    a ``--resume`` while another live process owns that lease can only be
    refused. Deferring the message is strictly better than spending a retry on a
    turn that cannot start.
    """
    if not session_id:
        return None
    home = _hermes_home()
    if home is None:
        return None
    try:
        raw = json.loads((home / "runtime" / "active_sessions.json").read_text())
    except (OSError, ValueError):
        return None
    entries = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        if session_id not in {str(entry.get("session_id") or ""), str(metadata.get("live_session_id") or "")}:
            continue
        try:
            pid = int(entry.get("pid") or 0)
        except (TypeError, ValueError):
            continue
        if pid <= 0 or _pid_is_ancestor_or_self(pid):
            continue
        try:
            os.kill(pid, 0)
        except PermissionError:
            return pid  # alive, just owned by another user
        except OSError:
            continue  # stale lease: the refusal path still covers it
        return pid
    return None


def clear_retry(state: Dict[str, Any], message_id: str) -> None:
    retry_entries(state).pop(message_id, None)


def describe_processing_error(exc: BaseException) -> str:
    """Return a bounded, secret-safe log description.

    TimeoutExpired and CalledProcessError include the entire command in their
    default string. Our command contains the full model prompt, so logging the
    exception verbatim leaks doctrine/chat context and can add megabytes to a
    profile log.
    """
    if isinstance(exc, HermesIdleTimeout):
        return f"Hermes turn stalled after {exc.timeout} seconds without observable progress"
    if isinstance(exc, subprocess.TimeoutExpired):
        return f"Hermes turn timed out after {exc.timeout} seconds"
    if isinstance(exc, subprocess.CalledProcessError):
        return f"Hermes exited with status {exc.returncode}"
    text = str(exc).replace(API_TOKEN, "[REDACTED]") if API_TOKEN else str(exc)
    text = text.replace("\r", " ").replace("\n", " ")
    return text[:800] + ("…" if len(text) > 800 else "")


# Provider-side refusals no retry can fix: the account behind the agent's LLM
# key is out of credits. Hermes surfaces OpenRouter's 402 as e.g.
# "HTTP 402: Insufficient credits" / "Billing or credits exhausted".
_CREDITS_EXHAUSTED_RE = re.compile(
    r"insufficient credits|credits? (?:are |is )?exhausted|billing or credits|out of credits"
    r"|\bHTTP 402\b|error code: 402\b|status(?:=| )402\b",
    re.IGNORECASE,
)

PROVIDER_CREDITS_REASON = (
    "LLM provider out of credits (HTTP 402): add credits for this agent's API key, then retry"
)


def provider_failure_reason(exc: BaseException) -> str | None:
    """A fixed, secret-safe reason for a provider failure an operator must fix,
    or None. Only a known classification is ever returned, never the exception
    text, which can carry the agent's reply or tool output."""
    if isinstance(exc, (subprocess.TimeoutExpired, subprocess.CalledProcessError, TurnInterrupted)):
        # Their str() embeds the full prompt and says nothing about credits.
        return None
    if _CREDITS_EXHAUSTED_RE.search(str(exc)):
        return PROVIDER_CREDITS_REASON
    return None


def is_recoverable_direct_message(message: Dict[str, Any], delivery_state: str) -> bool:
    """Whether a locally-seen direct prompt is still executable server-side."""
    target = str(message.get("targetAgentId") or message.get("target_agent_id") or "")
    return target == AGENT_ID and delivery_state in {"queued", "seen", "acting"}


def _log_llm_guidance(provider: str) -> None:
    """Log which env var the user should set in Hermes for this provider."""
    provider_env_map = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "grok": "GROK_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
    }
    env_var = provider_env_map.get(provider.lower())
    if env_var:
        log(
            f"Agent configured for LLM provider: {provider}. "
            f"Set {env_var} in your environment or ~/.hermes/.env. "
            "API keys are managed in the agent runtime, not stored in EmperorClaw."
        )


_server_capabilities: List[str] = []
_reply_format_guide = ""
# Lean context, cached per agent with the server's ETag. Fetched once and
# re-validated at most every LEAN_REVALIDATE_SECONDS, so the lean content (and
# therefore the static hash) changes only when the server's payload does — the
# pinned first messages are not re-sent needlessly.
_lean_cache: Dict[str, Any] = {"agentId": "", "etag": "", "payload": None, "checkedAt": 0.0}
_lean_gate_logged = False
_lean_failure_logged = False


def ensure_runtime() -> None:
    global _server_capabilities, _reply_format_guide
    response = api("POST", "/runtime/register", body={
        "runtimeId": RUNTIME_ID,
        "name": f"Hermes on {socket.gethostname()}",
        "hostname": socket.gethostname(),
        "gatewayVersion": "hermes-agent",
        "capabilitiesJson": ["hermes-agent", "thread-reply", "emperor-tools", "rich-replies"],
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    had_rich = RICH_BLOCKS_CAPABILITY in _server_capabilities and bool(_reply_format_guide)
    _server_capabilities, _reply_format_guide = parse_server_capabilities(response)
    has_rich = RICH_BLOCKS_CAPABILITY in _server_capabilities and bool(_reply_format_guide)
    if has_rich != had_rich and _capability_logged:
        # The reply-format guide is part of the static block: a server that
        # just gained or lost rich replies must re-prime sessions now, not
        # after the static-block cache window.
        invalidate_static_block()
    if has_rich != had_rich or not _capability_logged:
        log(
            "server renders rich replies; reply-format guide loaded" if has_rich
            else "server does not advertise rich replies; agents will write plain Markdown"
        )
    _mark_capability_logged()


BOOT_REGISTER_DEADLINE_SECONDS = 900  # a boot must be able to outwait a wifi outage


def ensure_runtime_boot() -> None:
    """Register the runtime without turning a DNS burst into a crash loop.

    2026-10-21: `ensure_runtime()` was called unguarded at startup, so a bridge
    that booted inside a resolution burst died mid-register: `status=1/FAILURE`
    -> Restart=always -> crash loop (builder did exactly that at 23:30:20 and
    23:31:11Z). Registration now backs off instead of dying; only an API that is
    still unreachable after BOOT_REGISTER_DEADLINE_SECONDS exits, and systemd
    then restarting it is the honest outcome.
    """
    deadline = time.monotonic() + BOOT_REGISTER_DEADLINE_SECONDS
    started = time.monotonic()
    attempts = 0
    delay = 5.0
    next_report = 0.0
    while True:
        attempts += 1
        try:
            ensure_runtime()
            if attempts > 1:
                log(f"runtime registration recovered after {attempts} attempts in {time.monotonic() - started:.0f}s")
            return
        except Exception as exc:  # noqa: BLE001 - transient transport at boot
            elapsed = time.monotonic() - started
            if time.monotonic() >= deadline:
                log(f"runtime registration gave up: {attempts} attempts in {elapsed:.0f}s, last error: {exc}")
                raise
            if elapsed >= next_report:
                # One line per attempt at first, then a heartbeat every 120 s: a
                # slow boot has to read as "retrying", not as "hung". The single
                # summary line above is what an operator should key on.
                log(f"runtime registration failed ({exc}); attempts={attempts} elapsed={elapsed:.0f}s next retry in {delay:.0f}s")
                next_report = elapsed + 120.0
            time.sleep(delay)
            delay = min(delay * 2, 60.0)

_capability_logged = False


def _mark_capability_logged() -> None:
    global _capability_logged
    _capability_logged = True


def refresh_server_capabilities() -> None:
    """Periodic re-handshake; a failure keeps the last known capabilities."""
    try:
        ensure_runtime()
    except Exception as exc:
        log(f"capability refresh failed: {exc}")


def parse_server_capabilities(response: Any) -> tuple[List[str], str]:
    """Read the capability handshake from a /runtime/register response.

    Older servers return only `runtimeNode`, which yields ([], "") — the
    agent then keeps writing plain Markdown, which every Emperor renders.
    """
    if not isinstance(response, dict):
        return [], ""
    raw = response.get("serverCapabilities")
    capabilities = [str(c) for c in raw if isinstance(c, (str, int))] if isinstance(raw, list) else []
    guide = response.get("replyFormatGuide")
    guide = guide.strip()[:MAX_REPLY_FORMAT_GUIDE_CHARS] if isinstance(guide, str) else ""
    return capabilities, guide


def rich_replies_active() -> bool:
    """True when this server renders rich replies and sent the matching guide."""
    return RICH_REPLIES_ENABLED and RICH_BLOCKS_CAPABILITY in _server_capabilities and bool(_reply_format_guide)


def server_supports_runs() -> bool:
    """True when the server advertised the run-ledger capability.

    An older server that never sent it yields False, so the bridge reports no
    runs and makes zero extra ledger requests against it.
    """
    return RUNS_CAPABILITY in _server_capabilities


def server_supports_lean() -> bool:
    """True when the server advertised the lean-context capability."""
    return LEAN_CONTEXT_CAPABILITY in _server_capabilities


def lean_context_active() -> bool:
    """True when the operator asked for lean AND the server advertises it.

    A server that never sent the capability keeps today's full block; the
    bridge logs the downgrade once instead of on every turn.
    """
    global _lean_gate_logged
    if CONTEXT_MODE != "lean":
        return False
    if not server_supports_lean():
        if not _lean_gate_logged:
            log(
                "EMPEROR_CLAW_CONTEXT_MODE=lean but the server does not advertise "
                f"{LEAN_CONTEXT_CAPABILITY}; using full context"
            )
            _lean_gate_logged = True
        return False
    return True


def _get_with_etag(path: str, query: Dict[str, Any] | None = None, etag: str = "") -> tuple[int, Any, str]:
    """GET JSON with an optional If-None-Match, returning (status, payload, etag).

    A 304 is not an error, but urllib surfaces it as an HTTPError; it is
    returned as status 304 with no body so the caller can keep its cached
    payload instead of re-priming the session.
    """
    if not API_TOKEN:
        raise RuntimeError("EMPEROR_CLAW_API_TOKEN is required")
    clean_path = "/" + path.lstrip("/")
    if not clean_path.startswith("/api/"):
        clean_path = "/api/mcp" + clean_path
    url = API_URL + clean_path
    if query:
        pairs = {key: value for key, value in query.items() if value not in (None, "")}
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Accept": "application/json",
        "User-Agent": f"emperor-hermes-bridge/{BRIDGE_VERSION}",
    }
    if etag:
        headers["If-None-Match"] = etag
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _urlopen_retrying(req, LEAN_FETCH_TIMEOUT_SECONDS) as res:
            text = res.read().decode("utf-8", errors="replace")
            return res.status, (json.loads(text) if text else {}), (res.headers.get("ETag") or "")
    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            return 304, None, (exc.headers.get("ETag") or etag)
        text = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"Emperor API GET {path} failed {exc.code}: {text[:500]}", exc.code) from exc


def fetch_lean_context(force: bool = False) -> Dict[str, Any] | None:
    """The cached lean payload for this agent, refreshed over ETag.

    Fetched once and reused across turns, re-validated with If-None-Match at
    most every LEAN_REVALIDATE_SECONDS. A 304 keeps the cached payload, so the
    lean content — and therefore the static block's hash — changes only when it
    really changed. On a fetch error the last payload is returned; with no
    payload at all, None tells the caller to fall back to full mode this turn.
    """
    global _lean_failure_logged
    now = time.time()
    cached_agent = str(_lean_cache.get("agentId") or "")
    cached_payload = _lean_cache.get("payload")
    if (
        not force
        and cached_agent == AGENT_ID
        and isinstance(cached_payload, dict)
        and now - float(_lean_cache.get("checkedAt") or 0.0) < LEAN_REVALIDATE_SECONDS
    ):
        return cached_payload
    # No payload yet and a recent failure: stay on full context until the
    # backoff ends instead of retrying (and possibly blocking) on every turn.
    if (
        not force
        and not isinstance(cached_payload, dict)
        and now - float(_lean_cache.get("failedAt") or 0.0) < LEAN_FAILURE_BACKOFF_SECONDS
    ):
        return None

    etag = str(_lean_cache.get("etag") or "") if cached_agent == AGENT_ID else ""
    try:
        status, payload, new_etag = _get_with_etag("/context/lean", query={"agentId": AGENT_ID}, etag=etag)
    except Exception as exc:
        if not _lean_failure_logged:
            log(f"lean context fetch failed: {exc} — using the last cached payload or full context")
            _lean_failure_logged = True
        # Back off: count this attempt so the next turns don't each retry (and
        # possibly block on DNS) until LEAN_FAILURE_BACKOFF_SECONDS have passed.
        _lean_cache["checkedAt"] = now - max(0.0, LEAN_REVALIDATE_SECONDS - LEAN_FAILURE_BACKOFF_SECONDS)
        _lean_cache["failedAt"] = now
        return cached_payload if (cached_agent == AGENT_ID and isinstance(cached_payload, dict)) else None

    _lean_failure_logged = False  # log the next outage too
    if status == 304 and isinstance(cached_payload, dict):
        _lean_cache["checkedAt"] = now
        return cached_payload
    if not isinstance(payload, dict):
        return cached_payload if isinstance(cached_payload, dict) else None
    _lean_cache.update({"agentId": AGENT_ID, "etag": new_etag, "payload": payload, "checkedAt": now})
    return payload


def format_reply_guidance() -> str:
    """Formatting section of the turn prompt.

    `hermes chat -q` runs under Hermes' CLI platform hint, which tells the
    model Markdown does not render and to write plain text. That is wrong for
    Emperor, whose chat renders Markdown on every version — so this always
    corrects it, and adds the rich-block guide only when the server both
    supports it and sent one.
    """
    base = (
        "Formatting: your reply is shown in Emperor Claw's web chat, a graphical app, not a terminal. "
        "Markdown renders (tables, code blocks, links, lists), so use it; ignore any earlier note that says Markdown does not render."
    )
    if rich_replies_active():
        return base + "\n\n" + _reply_format_guide
    return base


_RICH_FENCE_RE = re.compile(
    r"^(?P<fence>`{3,}|~{3,})[ \t]*(?P<lang>chart|stats|kpi|tabs|html|widget|choices)\b[^\n]*\n(?P<body>.*?)^(?P=fence)[ \t]*$",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)


def _rich_block_label(lang: str, body: str) -> str:
    lang = lang.lower()
    title = ""
    if lang == "chart":
        try:
            spec = json.loads(body)
            title = str(spec.get("title") or "") if isinstance(spec, dict) else ""
        except (ValueError, TypeError):
            title = ""
        return f"[chart: {title}]" if title else "[chart]"
    if lang in {"stats", "kpi"}:
        try:
            items = json.loads(body)
            if isinstance(items, dict):
                items = items.get("items")
            parts = [
                f"{item.get('label')} {item.get('value')}".strip()
                for item in (items if isinstance(items, list) else [])[:6]
                if isinstance(item, dict) and item.get("label") is not None
            ]
            return f"[stats: {'; '.join(parts)}]" if parts else "[stats]"
        except (ValueError, TypeError):
            return "[stats]"
    if lang == "choices":
        try:
            spec = json.loads(body)
            options = spec.get("options") if isinstance(spec, dict) else spec
            labels = [
                str(o.get("label") if isinstance(o, dict) else o)
                for o in (options if isinstance(options, list) else [])[:8]
                if (isinstance(o, dict) and o.get("label")) or isinstance(o, (str, int))
            ]
            return f"[choices: {' / '.join(labels)}]" if labels else "[choices]"
        except (ValueError, TypeError):
            return "[choices]"
    if lang == "tabs":
        labels = re.findall(r"^\s*={3,}\s+(.+?)\s*=*\s*$", body, re.MULTILINE)
        return f"[tabs: {', '.join(labels[:8])}]" if labels else "[tabs]"
    match = re.search(r"<!--\s*title:\s*(.*?)\s*-->", body, re.IGNORECASE) or re.search(r"<title[^>]*>(.*?)</title>", body, re.IGNORECASE | re.DOTALL)
    title = re.sub(r"\s+", " ", match.group(1)).strip()[:80] if match else ""
    return f"[html widget: {title}]" if title else "[html widget]"


def summarize_rich_blocks(text: str) -> str:
    """Replace rich fenced blocks with a short label for history context.

    A chart spec or an HTML widget is kilobytes of markup that carries little
    for another turn's reasoning; the label keeps what was shown (and the
    stats values) at a fraction of the prompt budget.
    """
    if "```" not in text and "~~~" not in text:
        return text
    return _RICH_FENCE_RE.sub(lambda m: _rich_block_label(m.group("lang"), m.group("body")), text)


def ensure_agent() -> str:
    global AGENT_ID, _agent_llm_provider, _agent_llm_model
    if AGENT_ID:
        return AGENT_ID
    payload = api("GET", "/agents", query={"limit": 200})
    agents = payload.get("agents") if isinstance(payload, dict) else []
    matched = None
    for agent in agents if isinstance(agents, list) else []:
        if str(agent.get("name") or "").lower() == AGENT_NAME.lower():
            AGENT_ID = str(agent.get("id"))
            matched = agent
            break
    if matched:
        _agent_llm_provider = str(matched.get("llmProvider") or "") or None
        _agent_llm_model = str(matched.get("llmModel") or "") or None
        if _agent_llm_provider:
            _log_llm_guidance(_agent_llm_provider)
        return AGENT_ID
    created = api("POST", "/agents", body={
        "name": AGENT_NAME,
        "role": AGENT_ROLE,
        "skillsJson": ["hermes-agent", "emperor-claw"],
        "modelPolicyJson": {"runtime": "hermes"},
        "status": "online",
    })
    agent = created.get("agent") if isinstance(created, dict) else None
    AGENT_ID = str((agent or {}).get("id") or "")
    if not AGENT_ID:
        raise RuntimeError(f"Could not resolve created agent id: {created}")
    return AGENT_ID


def send_heartbeat(current_load: int = 0) -> None:
    if not AGENT_ID:
        return
    api("POST", "/agents/heartbeat", body={
        "agentId": AGENT_ID,
        "currentLoad": current_load,
    })


def fetch_agent_roster() -> List[Dict[str, Any]]:
    try:
        payload = api("GET", "/agents", query={"limit": 50})
        agents = payload.get("agents") if isinstance(payload, dict) else []
        return agents if isinstance(agents, list) else []
    except Exception as exc:
        log(f"agent roster fetch failed: {exc}")
        return []


def format_agent_roster(agent_id: str) -> str:
    agents = fetch_agent_roster()
    if not agents:
        return "Team roster: unavailable; use emperor_request GET /agents only if needed."
    lines: List[str] = []
    for agent in agents[:24]:
        name = str(agent.get("name") or agent.get("id") or "unknown")
        marker = " (you)" if str(agent.get("id") or "") == agent_id else ""
        role = str(agent.get("role") or "").strip()
        skills = agent.get("skillsJson") if isinstance(agent.get("skillsJson"), list) else (agent.get("skills") if isinstance(agent.get("skills"), list) else [])
        skill_summary = ", ".join(str(s) for s in skills[:3])
        sibling_aliases = {
            normalize_mention(alias)
            for sibling in agents if str(sibling.get("id") or "") != str(agent.get("id") or "")
            for alias in agent_name_aliases(str(sibling.get("name") or ""))
        }
        unique_aliases = sorted((alias for alias in agent_name_aliases(name)
            if not re.search(r"\s", alias) and normalize_mention(alias) not in sibling_aliases), key=lambda alias: (len(alias), alias.lower()))
        # With rich replies on, the id lets the agent link a teammate as a live
        # card (emperor://agent/<id>) without spending a tool call to find it.
        agent_ref = str(agent.get("id") or "")
        id_suffix = f" · id {agent_ref}" if agent_ref and rich_replies_active() else ""
        role_part = f" — {role}" if role else ""
        skill_part = f" · {skill_summary}" if skill_summary else ""
        if unique_aliases:
            lines.append(f"- {name}{marker}{role_part}: @{unique_aliases[0]}{skill_part}{id_suffix}")
        else:
            lines.append(f"- {name}{marker}{role_part}: no unambiguous alias; use an explicitly assigned task or ask for distinct agent names{id_suffix}")
    return "Team roster (name, role, and a distinct @alias):\n" + "\n".join(lines)


def fetch_shared_resources() -> List[Dict[str, Any]]:
    try:
        if DOCTRINE_RESOURCE_ID:
            payload = api("GET", f"/resources/{DOCTRINE_RESOURCE_ID}")
            resource = payload.get("resource") if isinstance(payload, dict) else None
            return [resource] if isinstance(resource, dict) else []
        payload = api("GET", "/resources", query={
            "isShared": "true",
            "status": "active",
        })
        resources = payload.get("resources") if isinstance(payload, dict) else []
        return resources if isinstance(resources, list) else []
    except Exception as exc:
        log(f"shared Knowledge & Rules fetch failed: {exc}")
        return []


def format_shared_resources() -> str:
    resources = fetch_shared_resources()
    if not resources:
        return (
            "Shared Knowledge & Rules: unavailable or empty. "
            "Use emperor_request GET /resources when reusable doctrine matters."
        )
    sections: List[str] = []
    used = 0
    for resource in resources[:12]:
        title = str(resource.get("displayName") or resource.get("name") or resource.get("id") or "Shared resource")
        resource_type = str(resource.get("resourceType") or resource.get("resource_type") or "resource")
        scope_type = str(resource.get("scopeType") or resource.get("scope_type") or "company")
        text = str(resource.get("configText") or resource.get("configJson") or resource.get("content") or "").strip()
        if not text:
            continue
        remaining = MAX_SHARED_RESOURCE_CHARS - used
        if remaining <= 0:
            break
        chunk = text[:remaining]
        used += len(chunk)
        sections.append(f"### {title} ({scope_type}/{resource_type})\n{chunk}")
    if not sections:
        return (
            "Shared Knowledge & Rules: found shared resources, but no readable text was returned. "
            "Use emperor_request GET /resources if needed."
        )
    return "Shared Knowledge & Rules loaded from Emperor:\n" + "\n\n".join(sections)


def fetch_company_brain_context(message: Dict[str, Any]) -> Dict[str, Any] | None:
    try:
        query: Dict[str, Any] = {
            "agentId": AGENT_ID,
            "maxChars": MAX_SHARED_RESOURCE_CHARS,
        }
        if MAX_CHARS_PER_RESOURCE:
            query["maxCharsPerResource"] = MAX_CHARS_PER_RESOURCE
        project_id = message.get("projectId") or message.get("project_id")
        customer_id = message.get("customerId") or message.get("customer_id")
        if project_id:
            query["projectId"] = str(project_id)
        if customer_id:
            query["customerId"] = str(customer_id)
        if DOCTRINE_RESOURCE_ID:
            query["resourceId"] = DOCTRINE_RESOURCE_ID
        payload = api("GET", "/resources/context", query=query)
        return payload if isinstance(payload, dict) else None
    except Exception as exc:
        log(f"Company Brain context resolver failed: {exc}")
        return None


def format_company_brain_context(message: Dict[str, Any]) -> str:
    context = fetch_company_brain_context(message)
    sources = context.get("sources") if isinstance(context, dict) else None
    if not isinstance(sources, list):
        return format_shared_resources()
    sections: List[str] = []
    for source in sources[:16]:
        title = str(source.get("name") or source.get("displayName") or source.get("id") or "Company Brain source")
        scope_type = str(source.get("scopeType") or "company")
        resource_type = str(source.get("resourceType") or "knowledge_base")
        priority = source.get("priority")
        text = str(source.get("content") or "").strip()
        if not text:
            continue
        sections.append(f"### {title} ({scope_type}/{resource_type}, priority {priority})\nsource_id: {source.get('id')}\n{text}")
    if not sections:
        return (
            "Company Brain: resolver returned no readable context. "
            "Use emperor_request GET /resources/context or retrieve a specific note when durable doctrine matters."
        )
    return (
        "Company Brain context resolved by Emperor. Use these source ids when citing loaded doctrine; "
        "do not blindly assume every shared resource was injected.\n"
        + "\n\n".join(sections)
    )


def is_direct_thread(message: Dict[str, Any], state: Dict[str, Any]) -> bool:
    """Whether this message belongs to one of this agent's private DM threads.

    Synced messages don't carry threadType, so DM-ness is derived from an
    explicit targetAgentId plus the per-thread ownership map the bridge records
    the first time it sees a targeted message in that thread.
    """
    thread_type = str(message.get("threadType") or message.get("thread_type") or "")
    if thread_type == "direct":
        return True
    # A group thread (including the machine-managed two-agent pair thread) is a
    # shared room, never a private DM: its targetAgentId exists only so old
    # runtimes still know the counterpart, and its session/caps must stay in the
    # shared-room bucket. Treating it as a DM is what let a pair handoff drift
    # into the operator's direct chat.
    if thread_type in SHARED_THREAD_TYPES:
        return False
    thread_id = str(message.get("threadId") or message.get("thread_id") or "")
    target = str(message.get("targetAgentId") or message.get("target_agent_id") or "")
    if target and target == AGENT_ID:
        return True
    return bool(thread_id) and state.get("direct_threads", {}).get(thread_id) == AGENT_ID


def resolve_team_thread_id() -> str:
    """Resolve the company's shared team thread id, cached per process."""
    global _team_thread_id_cache
    if _team_thread_id_cache:
        return _team_thread_id_cache
    try:
        payload = api("GET", "/threads", query={"type": "team"})
    except Exception as exc:
        log(f"main chat context: team thread lookup failed: {exc}")
        return ""
    threads = payload.get("threads") if isinstance(payload, dict) else []
    if not isinstance(threads, list) or not threads:
        return ""
    # ensureTeamThread resolves the oldest non-archived team thread as canonical;
    # mirror that here instead of trusting the API's row order.
    oldest = sorted(threads, key=lambda thread: str(thread.get("createdAt") or thread.get("created_at") or ""))[0]
    resolved = str(oldest.get("id") or "")
    if resolved:
        _team_thread_id_cache = resolved
    return resolved


def _message_sender_label(entry: Dict[str, Any], agent_names: Dict[str, str]) -> str:
    sender_type = str(entry.get("senderType") or entry.get("sender_type") or "").lower()
    sender_id = str(entry.get("senderId") or entry.get("sender_id") or "")
    metadata = entry.get("metadataJson") or entry.get("metadata_json") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    if sender_type == "agent":
        return agent_names.get(sender_id) or str(metadata.get("senderName") or "agent")
    if sender_type == "human":
        return str(metadata.get("senderName") or metadata.get("senderEmail") or "operator")
    return sender_type or "system"


def format_main_chat_context(message: Dict[str, Any]) -> str:
    """Read-only digest of the recent main team channel, for DM turns.

    The DM session is keyed by the direct thread, so it never observed the team
    channel. Injecting the recent team messages lets the agent answer "what did
    you and X talk about?" without merging sessions — and because this only
    flows team -> DM, private DM content never leaks back into the team.
    """
    if MAIN_CHAT_CONTEXT_LIMIT <= 0:
        return ""
    team_thread_id = resolve_team_thread_id()
    if not team_thread_id:
        return ""
    try:
        payload = api(
            "GET",
            f"/threads/{urllib.parse.quote(team_thread_id)}/messages",
            query={"limit": MAIN_CHAT_CONTEXT_LIMIT},
        )
    except Exception as exc:
        log(f"main chat context: team messages fetch failed: {exc}")
        return ""
    messages = payload.get("messages") if isinstance(payload, dict) else []
    if not isinstance(messages, list) or not messages:
        return ""
    agent_names = {
        str(agent.get("id")): str(agent.get("name") or agent.get("id"))
        for agent in fetch_agent_roster()
        if agent.get("id")
    }
    lines: List[str] = []
    used = 0
    for entry in messages:
        if not isinstance(entry, dict):
            continue
        text = " ".join(summarize_rich_blocks(str(entry.get("text") or "")).split())
        if not text:
            continue
        if len(text) > MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS:
            text = text[:MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS] + "…"
        line = f"- {_message_sender_label(entry, agent_names)}: {text}"
        if used + len(line) > MAIN_CHAT_CONTEXT_MAX_CHARS:
            break
        used += len(line)
        lines.append(line)
    if not lines:
        return ""
    return (
        "Recent main team channel activity — read-only context so you know what was "
        "discussed with the team. Do NOT reply into the team channel from this DM; "
        "answer the operator here.\n" + "\n".join(lines)
    )


def clean_mention_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Cf")
    return re.sub(r"[^\S\r\n\u2028\u2029]+", " ", normalized)


def normalize_mention(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", ascii_value.lower())


def agent_name_aliases(name: str) -> set[str]:
    clean = re.sub(r"\([^)]*\)", "", clean_mention_text(name)).strip()
    clean = re.split(r"\s+-\s+|\s+—\s+|\s+\|\s+", clean, maxsplit=1)[0].strip()
    parts = [part for part in re.split(r"\s+", clean) if part]
    candidates = {name, clean}
    if parts:
        candidates.add(parts[0])
        candidates.add("-".join(parts))
        candidates.add("_".join(parts))
    return {candidate.strip("@ ") for candidate in candidates if candidate and candidate.strip("@ ")}


def mentioned_agent_refs(text: str) -> set[str]:
    refs = set()
    for match in re.finditer(r"(?<![\w@])@([^\s,.;:!?@()<>]+(?:[ \t]+[^\s,.;:!?@()<>]+){0,31})", clean_mention_text(text)):
        words = match.group(1).split()
        for length in range(1, len(words) + 1):
            refs.add(" ".join(words[:length]))
    return refs


def mentions_agent(text: str, agent_name: str) -> bool:
    mention_keys = {normalize_mention(ref) for ref in mentioned_agent_refs(text)}
    alias_keys = {normalize_mention(alias) for alias in agent_name_aliases(agent_name)}
    return bool(mention_keys & alias_keys)


# `@all` (or `@everyone`) in a group chat addresses every member agent.
_EVERYONE_MENTION_RE = re.compile(r"(?<![\w@])@(all|everyone)(?![\w-])", re.IGNORECASE)


def mentions_everyone(text: str) -> bool:
    return bool(_EVERYONE_MENTION_RE.search(clean_mention_text(text)))


def server_routed(message: Dict[str, Any]) -> bool:
    """Did the server decide who answers this message (`addressedToYou`)?

    Servers since the routing change send a per-agent verdict with every
    synced message. When present it is authoritative — mentions, @all, the
    agent-to-agent loop guard and its notice are all applied server-side, the
    same way for every runtime. Older servers send none, and the bridge falls
    back to its own equivalent rules below.
    """
    return isinstance(message.get("addressedToYou"), bool)


def is_for_agent(message: Dict[str, Any], agent_id: str, state: Dict[str, Any]) -> bool:
    sender_type = str(message.get("senderType") or "").lower()
    sender_id = str(message.get("senderId") or message.get("sender_id") or message.get("fromUserId") or "")
    if sender_type == "agent" and sender_id == agent_id:
        return False
    if server_routed(message):
        return bool(message.get("addressedToYou"))
    text = str(message.get("text") or "")
    thread_type = str(message.get("threadType") or message.get("thread_type") or "")
    thread_id = str(message.get("threadId") or message.get("thread_id") or "")
    target = str(message.get("targetAgentId") or message.get("target_agent_id") or "")
    if target and target == agent_id:
        return True
    if target and target != agent_id:
        return False
    # No targetAgentId on this message — check if this thread is a known DM thread.
    # If another agent owns it, @mentions in it must not trigger us.
    direct_threads = state.get("direct_threads", {})
    if thread_id and thread_id in direct_threads:
        return direct_threads[thread_id] == agent_id
    if thread_type == "direct":
        return True
    # A human's @all in a group wakes every member agent (delivery is already
    # members-only). An agent's @all never does: one agent fanning out to the
    # whole group, each reply fanning out again, is how loops start.
    if thread_type == "group" and sender_type == "human" and mentions_everyone(text):
        return True
    return mentions_agent(text, AGENT_NAME)


def check_loop_guard(message: Dict[str, Any], state: Dict[str, Any]) -> bool:
    """Mechanical backstop against agent-to-agent reply loops in team chat.

    Direct threads always have a human on the other end, so they're excluded.
    In team chat, count consecutive agent-authored messages this agent has
    been triggered by, with no human message in between, per thread. A human
    message resets the count to zero. Once the count exceeds
    LOOP_GUARD_MAX_AGENT_TURNS, return False so the caller skips invoking
    Hermes for this message (and every later one in the thread) until a human
    message shows up again.
    """
    thread_type = str(message.get("threadType") or message.get("thread_type") or "")
    if thread_type not in SHARED_THREAD_TYPES:
        return True
    thread_id = str(message.get("threadId") or message.get("thread_id") or "")
    if not thread_id:
        return True
    sender_type = str(message.get("senderType") or "").lower()
    guard = state.setdefault("loop_guard", {})
    entry = guard.setdefault(thread_id, {"count": 0, "notified": False})
    if sender_type != "agent":
        entry["count"] = 0
        entry["notified"] = False
        return True
    now = time.time()
    if now - entry.get("last_activity", now) >= 300:
        entry["count"] = 0
        entry["notified"] = False
    entry["last_activity"] = now
    entry["count"] = entry.get("count", 0) + 1
    return entry["count"] <= LOOP_GUARD_MAX_AGENT_TURNS


def sync_messages(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    query = {"mode": "all", "agentId": AGENT_ID}
    if state.get("lastSeenAt"):
        query["since"] = state["lastSeenAt"]
    retry_ids = list(retry_entries(state).keys())
    if retry_ids:
        query["retryMessageIds"] = ",".join(retry_ids[-100:])
    payload = api("GET", "/messages/sync", query=query)
    remember_thread_details(payload.get("threads") if isinstance(payload, dict) else None)
    messages = payload.get("messages") if isinstance(payload, dict) else []
    return messages if isinstance(messages, list) else []


# Group details (purpose, members) the server sends alongside synced messages,
# keyed by thread id. Servers older than group chats send none; the agent
# then just sees an ordinary @mention-routed thread.
_thread_details: Dict[str, Dict[str, Any]] = {}
MAX_THREAD_DETAILS = 200


def remember_thread_details(threads: Any) -> None:
    if not isinstance(threads, dict):
        return
    for thread_id, detail in threads.items():
        if isinstance(detail, dict):
            _thread_details[str(thread_id)] = detail
    while len(_thread_details) > MAX_THREAD_DETAILS:
        _thread_details.pop(next(iter(_thread_details)))


BRIDGE_STARTED_AT = time.time()


def is_backlog(created_at: Any) -> bool:
    """Was this message posted before this bridge process started?"""
    if not created_at:
        return False
    try:
        from datetime import datetime
        stamp = datetime.fromisoformat(str(created_at).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return False
    return stamp < BRIDGE_STARTED_AT


# Thread kinds where agents answer only when @mentioned and the loop/cold-start
# guards apply: the shared team channel and members-only group chats.
SHARED_THREAD_TYPES = {"team", "group"}


def is_processed_delivery_state(message: Dict[str, Any]) -> bool:
    """Did the server's delivery state already finish this message for us?

    Only meaningful for direct threads. In a shared room (team or group) the
    server stamps every agent post "resolved" as its default, so that state is
    not an "already answered" marker and the message must still be routed by
    the mention verdict. Skipping shared-room messages here silently dropped
    every peer @mention, so agents never answered each other.
    """
    delivery_state = str(message.get("deliveryState") or message.get("delivery_state") or "").lower()
    if delivery_state not in {"resolved", "cancelled"}:
        return False
    thread_type = str(message.get("threadType") or message.get("thread_type") or "").lower()
    return thread_type not in SHARED_THREAD_TYPES


def format_group_context(message: Dict[str, Any]) -> str:
    """Who and what a group chat is for, so the agent answers as a member."""
    thread_type = str(message.get("threadType") or message.get("thread_type") or "")
    if thread_type != "group":
        return ""
    thread_id = str(message.get("threadId") or message.get("thread_id") or "")
    detail = _thread_details.get(thread_id) or {}
    # A two-agent pair thread is addressed via the routing verdict (agent_pair),
    # not @mentions — suppress the members-only group boilerplate for it.
    if str(detail.get("description") or "") == "agent-pair":
        return ""
    title = str(detail.get("title") or message.get("threadTitle") or "this group")[:120]
    lines = [f'You are replying in the group chat "{title}" (members only).']
    description = str(detail.get("description") or "").strip()
    if description:
        lines.append(f"Group purpose: {description[:600]}")
    members = detail.get("members") if isinstance(detail.get("members"), list) else []
    agent_names = [str(m.get("name")) for m in members if isinstance(m, dict) and m.get("kind") == "agent" and m.get("name")]
    human_names = [str(m.get("name")) for m in members if isinstance(m, dict) and m.get("kind") == "human" and m.get("name")]
    coordinators = [m for m in members if isinstance(m, dict) and m.get("role") in ("coordinator", "owner_coordinator") and m.get("name")]
    if coordinators:
        lead = coordinators[0]
        lines.append(f"Team coordinator: {str(lead['name'])[:80]} ({'human' if lead.get('kind') == 'human' else 'agent'}). This responsibility applies only to this group and does not grant extra permissions.")
        lines.append("Coordinate using tasks with one owner and a clear deliverable. Raise unresolved blockers to the coordinator with the task and a concrete question. Status updates need no acknowledgment. Existing project leads and approval rules still apply.")
    if agent_names:
        lines.append("Agent members: " + ", ".join(
            f"{name[:40]}{' (you)' if name == AGENT_NAME else ''}" for name in agent_names[:24]
        ))
    if human_names:
        lines.append("Human members: " + ", ".join(name[:40] for name in human_names[:24]))
    if len(agent_names) > 24 or len(human_names) > 24 or any(len(name) > 40 for name in agent_names + human_names):
        lines.append("Roster preview only. Use emperor_list_groups for complete membership and exact names before mentioning anyone.")
    lines.append(
        "Group rules: it works like team chat but only these members see it. Reply in this group. "
        "To hand work to a member, @mention them once with one concrete request; agents outside the group "
        "do not receive it, so use team chat or a direct message for them. "
        "When a human writes @all, every member is asked: answer for your own part only. Never write @all yourself."
    )
    return "\n".join(lines)


def format_my_team_roles() -> str:
    """Small matrix-role summary for direct turns; never the whole company graph."""
    teams = []
    for thread_id, detail in _thread_details.items():
        if detail.get("type") != "group" or detail.get("description") == "agent-pair":
            continue
        members = detail.get("members") if isinstance(detail.get("members"), list) else []
        own = next((m for m in members if isinstance(m, dict) and m.get("kind") == "agent" and
                    (m.get("id") == AGENT_ID or (not m.get("id") and m.get("name") == AGENT_NAME))), None)
        if not own:
            continue
        lead = next((m for m in members if isinstance(m, dict) and m.get("role") in ("coordinator", "owner_coordinator")), None)
        role = "coordinator" if own.get("role") in ("coordinator", "owner_coordinator") else "member"
        title = str(detail.get("title") or "Team")[:48]
        coordinator = str(lead.get("name") or "")[:48] if lead else "none"
        teams.append((str(thread_id), f"{title}: you are {role}; coordinator: {coordinator}"))
    if not teams:
        return ""
    lines = ["Your work teams (responsibilities apply only within each team):"]
    lines.extend(row for _, row in sorted(teams)[:4])
    lines.append("Use emperor_list_groups for complete memberships and exact names. Coordinate through owned tasks; project leads and approval permissions still apply.")
    if len(teams) > 4:
        lines.append(f"Plus {len(teams) - 4} other teams available through that tool.")
    return "\n".join(lines)


# The chart changes rarely, so GET /organization is fetched at most once per
# window and the block is injected from memory on every other turn. On a fetch
# failure the last successful value is kept, so a transient server hiccup does
# not silently drop the org block for the next ten minutes.
ORG_CONTEXT_TTL_SECONDS = 600
_organization_cache: Dict[str, Any] = {"info": None, "fetchedAt": 0.0}


def _fetch_organization() -> Any:
    """GET /organization cached for ORG_CONTEXT_TTL_SECONDS, last value on error."""
    now = time.monotonic()
    cached = _organization_cache["info"]
    if cached is not None and now - float(_organization_cache["fetchedAt"] or 0.0) < ORG_CONTEXT_TTL_SECONDS:
        return cached
    try:
        info = api("GET", "/organization", query={"agentId": AGENT_ID})
    except Exception:
        # Older servers keep their existing group context and message flow.
        return cached
    _organization_cache["info"] = info
    _organization_cache["fetchedAt"] = now
    return info


def _organization_reports_to(info: Dict[str, Any], leader: Dict[str, Any]) -> str:
    """Who this agent reports to: its first reporting line, else its team
    coordinator. Same resolution the previous full block used."""
    reporting = info.get("reporting") if isinstance(info.get("reporting"), list) else []
    for relation in reporting:
        if not isinstance(relation, dict):
            continue
        target = relation.get("reportsTo")
        target = target if isinstance(target, dict) else {}
        return str(target.get("name") or "humans")
    teams = info.get("teams") if isinstance(info.get("teams"), list) else []
    for team in teams:
        if not isinstance(team, dict):
            continue
        coordinator = team.get("coordinator")
        coordinator = coordinator if isinstance(coordinator, dict) else {}
        if coordinator.get("kind") == "agent" and coordinator.get("id") == AGENT_ID:
            if leader.get("kind") == "agent" and leader.get("id") == AGENT_ID:
                return "humans"
            return str(leader.get("name") or "humans")
        return str(coordinator.get("name") or leader.get("name") or "unassigned")
    return "humans"


def format_organization_context() -> str:
    """Minimal org chart reminder: the leader and this agent's reporting line,
    plus one escalation rule. Bounded well under 400 chars so the per-turn cost
    stays flat regardless of company size; served from a 10-minute cache."""
    info = _fetch_organization()
    if not isinstance(info, dict) or not info.get("configured"):
        return ""
    leader = info.get("leader")
    leader = leader if isinstance(leader, dict) else {}
    leader_name = str(leader.get("name") or "unassigned")[:64]
    if leader.get("kind") == "agent" and leader.get("id") == AGENT_ID:
        reporting_line = "you lead the company; report to humans"
    else:
        reporting_line = "you report to " + _organization_reports_to(info, leader)[:64]
    return (
        f"Org: leader {leader_name}; {reporting_line}\n"
        "Escalate cross-team conflicts to the leader; details: GET /organization."
    )


def update_chat_status(
    message: Dict[str, Any],
    *,
    typing: bool | None = None,
    mark_read: bool = False,
    execution_state: str | None = None,
    activity: str | None = None,
    reason: str | None = None,
) -> None:
    thread_id = message.get("threadId") or message.get("thread_id")
    if not thread_id:
        return
    body: Dict[str, Any] = {
        "threadId": thread_id,
        "agentId": AGENT_ID,
    }
    if typing is not None:
        body["typing"] = typing
    if mark_read:
        body["markRead"] = True
    if execution_state:
        body["executionState"] = execution_state
        if execution_state:
            # Scope "resolved" to this exact message — batching it
            # thread-wide would mark other still-queued messages done the
            # instant this one's reply lands, before they've been touched.
            message_id = message.get("id")
            if message_id:
                body["messageId"] = message_id
    if activity:
        body["activity"] = activity
    if reason:
        # Stored on the failed message (runtimeFailure.reason); agent health reads it.
        body["reason"] = reason[:300]
    api("POST", "/chat/status", body=body)


def format_turn_activity(elapsed_seconds: float, resumed: bool) -> str:
    """Fallback "what's happening" text when no tool-call log line is
    available yet (see latest_tool_activity) — just elapsed time and
    whether this turn resumed a prior session.
    """
    minutes, seconds = divmod(int(elapsed_seconds), 60)
    elapsed = f"{minutes}m{seconds:02d}s" if minutes else f"{seconds}s"
    prefix = "continuing" if resumed else "working"
    return f"{prefix} ({elapsed})"


# `hermes chat` has no --json/streaming flag to subscribe to tool-call events
# (checked against the installed v0.20.5 CLI's own --help), and `hermes
# webhook` is for inbound triggering, not turn progress. But Hermes already
# writes each tool call to <HERMES_HOME>/logs/agent.log via a stable, on-disk
# `agent.tool_executor` logger — confirmed against live production logs on
# this fleet. Tailing that (not the interactive stdout, which is free-text
# and formatted for a human terminal) gives real tool-level activity without
# depending on anything Hermes hasn't already committed to as durable output.
_TOOL_LOG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+\s+(?:INFO|WARNING)\s+"
    r"(?:\[[^\]]+\]\s+)?agent\.tool_executor:\s+"
    r"[Tt]ool\s+(\w+)\s+(completed|returned error)\s+\(([\d.]+)s"
)
_TOOL_LOG_TS_FORMAT = "%Y-%m-%d %H:%M:%S"

# Raw tool names -> short human phrases. Unmapped tools fall back to
# "used <raw_name>" so a new/renamed tool degrades gracefully instead of
# showing nothing.
_TOOL_LABELS = {
    "terminal": "running a command",
    "read_file": "reading a file",
    "write_file": "writing a file",
    "edit_file": "editing a file",
    "search_files": "searching files",
    "list_directory": "browsing files",
    "web_search": "searching the web",
    "fetch_url": "reading a webpage",
    "browser_navigate": "browsing the web",
    "browser_click": "clicking on the page",
    "browser_snapshot": "reading the page",
    "browser_type": "typing on the page",
    "browser_screenshot": "taking a screenshot",
    "emperor_request": "checking Emperor Claw",
    "emperor_list_projects": "checking projects",
    "emperor_list_tasks": "checking tasks",
    "emperor_list_threads": "checking threads",
    "emperor_get_thread_messages": "reading messages",
    "emperor_upload_artifact": "uploading a file",
    "emperor_add_task_note": "writing a task note",
    "emperor_send_message": "sending a message",
    "emperor_create_folder": "creating a folder",
    "emperor_list_folder_contents": "checking Storage",
    "emperor_create_project": "creating a project",
}


def _tool_label(tool: str) -> str:
    return _TOOL_LABELS.get(tool, f"used {tool}")


def _agent_log_path() -> Path | None:
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if not hermes_home:
        return None
    return Path(hermes_home) / "logs" / "agent.log"


# Once the last known tool activity is older than this, assume we've moved
# into a thinking/API-call phase rather than continuing to show
# increasingly stale "used X" text from whatever ran last.
_THINKING_AFTER_SECONDS = 4.0


def latest_tool_activity(since_ts: float, tail_bytes: int = 32_000) -> str | None:
    """Best-effort "what's happening" text derived from agent.log, or None
    if the log is unavailable. Reads only the tail of the file — cheap
    enough to call every poll tick without materially adding to the 3s
    status-ping cadence."""
    log_path = _agent_log_path()
    if not log_path:
        return None
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
            raw = fh.read()
    except OSError:
        return None

    latest_tool: tuple[float, str, str, str] | None = None  # (ts, tool, status, duration)
    now = time.time()
    for line in raw.decode("utf-8", errors="replace").splitlines():
        tool_match = _TOOL_LOG_RE.match(line)
        if tool_match:
            try:
                ts = time.mktime(time.strptime(tool_match.group(1), _TOOL_LOG_TS_FORMAT))
            except ValueError:
                continue
            if ts > since_ts and (latest_tool is None or ts >= latest_tool[0]):
                latest_tool = (ts, tool_match.group(2), tool_match.group(3), tool_match.group(4))

    if latest_tool and (now - latest_tool[0]) < _THINKING_AFTER_SECONDS:
        _, tool, status, duration = latest_tool
        if status == "completed":
            return f"{_tool_label(tool)} ({duration}s)"
        return f"{tool} failed ({duration}s)"

    # No fresh tool activity. This used to fabricate a "thinking" / "thinking
    # (model)" line inferred purely from silence — it read no reasoning at all,
    # it just guessed. That is gone: real reasoning now comes from a
    # ReasoningSource, and when the runtime exposes none we say nothing rather
    # than inventing a thought. (Hermes made the same call for its Zed ACP
    # integration: if the provider emits no reasoning, the client should not be
    # handed a fake thinking accordion.) The caller falls back to
    # format_turn_activity, which is honest elapsed-time telemetry.
    return None


# ---------------------------------------------------------------------------
# Real model reasoning ("thinking")
# ---------------------------------------------------------------------------
# Emperor Claw is runtime-agnostic: Hermes is the reference runtime, not the
# only one. So reasoning is read through a tiny pluggable interface — a
# contributor running some other agent runtime writes ONE class implementing
# `latest_reasoning()` and registers it in `_build_reasoning_source()`. Nothing
# else in the bridge needs to change.
#
# Selected with EMPEROR_CLAW_REASONING_SOURCE:
#   auto           (default) session-store when <HERMES_HOME>/state.db exists, else none
#   session-store  read Hermes's own SQLite session store, strictly read-only
#   none           never report reasoning (the correct setting for any runtime
#                  that does not expose reasoning; fully supported, not a downgrade)
REASONING_SOURCE_NAME = os.environ.get("EMPEROR_CLAW_REASONING_SOURCE", "auto").strip().lower() or "auto"

# Durable reasoning history: OFF by default, and it must stay that way.
#
# The live activity line above is ephemeral — condensed to one sentence and
# cleared the moment typing stops. History is the opposite: the full raw
# reasoning of a turn, stored in the control plane for as long as the message
# lives. Raw reasoning quotes the user verbatim and routinely carries file
# paths, command output and secrets that passed through context, so persisting
# it durably in a MULTI-TENANT control plane is a privacy escalation, not a
# convenience. That is a decision the runtime operator has to make deliberately
# for their own machine and their own data, so it is opt-in per runtime.
# With this off the bridge sends no history at all — there is nothing to
# truncate, redact or delete later. Live activity is unaffected either way.
#   off (default)  never send reasoning history
#   on             post the turn's full reasoning once, when the turn ends
REASONING_HISTORY_ENABLED = os.environ.get("EMPEROR_CLAW_REASONING_HISTORY", "off").strip().lower() in {"on", "true", "1", "yes"}

# Ceiling on what one turn may send. The server re-applies its own cap (it must
# never trust a client's length), but capping here is what keeps a runaway turn
# — a tool loop that thinks for thousands of steps — from writing an unbounded
# row and from pushing a multi-megabyte body over the API on every reply.
_REASONING_HISTORY_MAX_CHARS = 16_000

# The status line is hard-truncated to 200 chars server-side. Budget well under
# that so the server's slice never visibly cuts a word in half after our own
# prefix is added.
_REASONING_MAX_CHARS = 160
# Below this a leading sentence is too terse to stand alone as a status line.
_REASONING_MIN_CHARS = 20


class ReasoningSource:
    """Interface a runtime integration implements to surface real reasoning.

    `latest_reasoning` is called roughly every 3 seconds during a turn and MUST
    be cheap, non-blocking and total: it returns a short already-condensed line,
    or None when there is nothing new (or anything at all went wrong). It must
    never raise — a status ping is not worth failing a turn over.
    """

    name = "none"

    def latest_reasoning(self, session_id: str, since_ts: float) -> str | None:
        return None

    def full_reasoning(self, session_id: str, since_ts: float) -> str | None:
        """Every reasoning step of the turn, joined in order, raw (not condensed).

        Called AT MOST ONCE per turn, after the turn ends, and only when
        reasoning history is enabled. Same totality contract as
        `latest_reasoning`: return None on anything unexpected, never raise.
        A runtime that cannot produce a transcript simply leaves this alone.
        """
        return None


class NullReasoningSource(ReasoningSource):
    """No reasoning available. Used by every runtime that does not expose it."""

    name = "none"


def condense_reasoning(text: str) -> str | None:
    """Squash raw model reasoning into one short status-line-sized phrase.

    Reasoning arrives as multi-paragraph markdown. `currentActivity` is a single
    ephemeral line, so collapse whitespace, drop the markdown scaffolding that
    would read as noise inline, prefer the first sentence, and truncate.
    """
    if not text:
        return None
    flat = text.replace("\r", "\n")
    # Strip markdown that is meaningless once flattened to one line: headings,
    # list bullets, emphasis/code markers, blockquotes.
    flat = re.sub(r"(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+", "", flat)
    flat = re.sub(r"[`*_]{1,3}", "", flat)
    flat = re.sub(r"\s+", " ", flat).strip()
    if not flat:
        return None
    # Prefer a leading sentence when one ends early enough to be informative on
    # its own. A very short opener ("Let me check.") says nothing by itself, so
    # grow it with the next sentence rather than discarding it and truncating
    # the whole blob mid-thought — a complete short thought beats a severed one.
    parts = re.split(r"(?<=[.!?])\s", flat)
    chosen = flat
    for count in (1, 2):
        candidate = " ".join(parts[:count]).strip()
        if _REASONING_MIN_CHARS <= len(candidate) <= _REASONING_MAX_CHARS:
            chosen = candidate
            break
    if len(chosen) <= _REASONING_MAX_CHARS:
        return chosen
    cut = chosen[: _REASONING_MAX_CHARS - 1]
    space = cut.rfind(" ")
    if space > 40:
        cut = cut[:space]
    return cut.rstrip(" ,;:.") + "…"


class SessionStoreReasoningSource(ReasoningSource):
    """Reads real reasoning out of Hermes's own session store.

    Hermes persists every turn to `<HERMES_HOME>/state.db` (SQLite), and writes
    rows INCREMENTALLY during a turn — so polling it mid-turn shows live
    progress rather than only a post-hoc transcript.

    Two rules make this safe:

    1. STRICTLY READ-ONLY. This is another program's live database. We open it
       with `mode=ro` and never write, never migrate, never create it. A locked
       or busy DB (Hermes is writing constantly) is "no data this tick", not an
       error — the turn must not fail because a status ping lost a race.
    2. SESSION-SCOPED. The store holds every session of every agent sharing this
       HERMES_HOME. Querying without a session id would surface ANOTHER agent's
       private reasoning in this thread's status line. If we don't know the
       session id, we report nothing.
    """

    name = "session-store"

    # Column precedence mirrors Hermes's own `_history_reasoning_text` in
    # acp_adapter/server.py, so we show the same text its ACP clients see.
    _REASONING_COLUMNS = ("reasoning_content", "reasoning")

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._columns: tuple[str, ...] | None = None
        self._unusable = False

    def _connect(self) -> Any:
        import sqlite3

        uri = "file:" + urllib.request.pathname2url(str(self._db_path)) + "?mode=ro"
        return sqlite3.connect(uri, uri=True, timeout=0.5)

    def _resolve_columns(self, conn: Any) -> tuple[str, ...]:
        """Which reasoning columns this schema actually has.

        Hermes's schema_version moves (26 at time of writing) and columns come
        and go. Probing with PRAGMA instead of assuming means a newer or older
        Hermes degrades to "no reasoning" rather than raising every 3 seconds.
        """
        if self._columns is not None:
            return self._columns
        rows = conn.execute("PRAGMA table_info(messages)").fetchall()
        if not rows:
            # PRAGMA on a table that does not exist returns an empty list rather
            # than raising. That happens during first-run schema bootstrap — the
            # store file exists but `messages` is not created yet — which is
            # transient, so do NOT memoize it. Caching () here would freeze the
            # source into "no reasoning" for the life of the process.
            return ()
        present = {str(row[1]) for row in rows}
        self._columns = tuple(col for col in self._REASONING_COLUMNS if col in present)
        return self._columns

    def latest_reasoning(self, session_id: str, since_ts: float) -> str | None:
        if self._unusable or not session_id:
            return None
        import sqlite3

        try:
            conn = self._connect()
        except sqlite3.OperationalError:
            return None
        except Exception:
            # Missing file / unreadable / not a database: stop retrying forever.
            self._unusable = True
            return None
        try:
            columns = self._resolve_columns(conn)
            if not columns:
                # Either the schema genuinely has no reasoning columns, or the
                # table is not created yet. Both are cheap to re-check and the
                # second one recovers on its own, so never latch _unusable here.
                return None
            selected = ", ".join(columns)
            # Require SUBSTANTIVE reasoning, not merely non-null. Assistant rows
            # are written for every step of a turn and many carry a stub — in
            # production the newest row routinely holds a single character. Just
            # taking the newest row and condensing it therefore yields nothing,
            # and the status line falls back to elapsed time even though real
            # reasoning sits one row behind. So skip the stubs in SQL and let
            # the last real thought stand until a better one replaces it.
            substantive = " OR ".join(
                f"length(trim(coalesce({col}, ''))) >= ?" for col in columns
            )
            row = conn.execute(
                f"SELECT {selected} FROM messages "
                "WHERE session_id = ? AND role = 'assistant' AND timestamp > ? "
                f"AND ({substantive}) "
                "ORDER BY timestamp DESC, id DESC LIMIT 1",
                (session_id, since_ts, *([_REASONING_MIN_CHARS] * len(columns))),
            ).fetchone()
        except sqlite3.OperationalError:
            # Locked/busy, or the `messages` table does not exist on this schema.
            return None
        except Exception:
            self._unusable = True
            return None
        finally:
            try:
                conn.close()
            except Exception:
                pass
        if not row:
            return None
        # Same substantive floor as the query: the row qualified because SOME
        # column cleared it, and that is not necessarily the first one. Picking
        # the first merely-non-empty column would hand back the stub we just
        # filtered for and throw away the real reasoning beside it.
        for value in row:
            if isinstance(value, str) and len(value.strip()) >= _REASONING_MIN_CHARS:
                return condense_reasoning(value)
        return None

    def full_reasoning(self, session_id: str, since_ts: float) -> str | None:
        """The turn's reasoning steps in chronological order, raw.

        Deliberately built on the SAME read as `latest_reasoning`: same
        read-only connection, same PRAGMA-probed columns, same substantive
        floor, and — the load-bearing part — the same `session_id = ?` filter.
        The store holds every session of every agent sharing this HERMES_HOME,
        so a query without that filter would persist ANOTHER agent's private
        reasoning into this thread's durable history, where it would sit for as
        long as the message lives. An empty session id therefore returns None.
        """
        if self._unusable or not session_id:
            return None
        import sqlite3

        try:
            conn = self._connect()
        except sqlite3.OperationalError:
            return None
        except Exception:
            self._unusable = True
            return None
        try:
            columns = self._resolve_columns(conn)
            if not columns:
                return None
            selected = ", ".join(columns)
            substantive = " OR ".join(
                f"length(trim(coalesce({col}, ''))) >= ?" for col in columns
            )
            # Oldest first: a transcript reads forward. LIMIT is a second belt
            # beside the character cap — a pathological turn can write tens of
            # thousands of rows, and we should not materialize them all just to
            # throw most away.
            rows = conn.execute(
                f"SELECT {selected} FROM messages "
                "WHERE session_id = ? AND role = 'assistant' AND timestamp > ? "
                f"AND ({substantive}) "
                "ORDER BY timestamp ASC, id ASC LIMIT 500",
                (session_id, since_ts, *([_REASONING_MIN_CHARS] * len(columns))),
            ).fetchall()
        except sqlite3.OperationalError:
            return None
        except Exception:
            self._unusable = True
            return None
        finally:
            try:
                conn.close()
            except Exception:
                pass

        steps: List[str] = []
        for row in rows:
            # Same reason as in latest_reasoning: the row may have qualified on
            # the second column, so take the first SUBSTANTIVE value rather than
            # the first non-empty one, which is often a one-character stub.
            for value in row:
                if isinstance(value, str) and len(value.strip()) >= _REASONING_MIN_CHARS:
                    steps.append(value.strip())
                    break
        if not steps:
            return None
        return "\n\n".join(steps)


_reasoning_source: ReasoningSource | None = None
# How long to wait before re-checking whether a reasoning source has appeared.
# Only ever consulted while the current source is "none", so on a runtime that
# exposes no reasoning this costs one stat() per minute and nothing else.
_REASONING_RESOLVE_RETRY_SECONDS = 60.0
_reasoning_source_retry_at = 0.0


def _session_store_path() -> Path | None:
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if not hermes_home:
        return None
    return Path(hermes_home) / "state.db"


def _build_reasoning_source() -> ReasoningSource:
    """Register additional runtimes here — one branch, one class."""
    if REASONING_SOURCE_NAME == "none":
        return NullReasoningSource()
    db_path = _session_store_path()
    if REASONING_SOURCE_NAME == "session-store":
        if db_path is None:
            log("reasoning source 'session-store' requested but HERMES_HOME is unset; disabling reasoning")
            return NullReasoningSource()
        return SessionStoreReasoningSource(db_path)
    if REASONING_SOURCE_NAME != "auto":
        log(f"unknown EMPEROR_CLAW_REASONING_SOURCE={REASONING_SOURCE_NAME!r}; falling back to auto")
    # auto: only claim session-store when the file is actually there and readable.
    if db_path is not None and os.access(db_path, os.R_OK):
        return SessionStoreReasoningSource(db_path)
    return NullReasoningSource()


def reasoning_source() -> ReasoningSource:
    """The active source, re-resolving a negative result on a slow interval.

    A positive result is cached for the life of the process: the path cannot
    change mid-run, and stat()ing on every 3s status tick would be pure waste.

    A NEGATIVE result must NOT be cached that way. On a fresh install the bridge
    is started before the runtime has ever run a turn, so the session store does
    not exist yet and "auto" correctly resolves to none — but the store appears
    moments later, and these units run for weeks under Restart=always. Latching
    that first "no" would mean reasoning silently never works until someone
    happens to restart the bridge, which is exactly the first-run path every new
    user takes. So retry, rarely enough to cost nothing.
    """
    global _reasoning_source, _reasoning_source_retry_at
    if _reasoning_source is not None and _reasoning_source.name != "none":
        return _reasoning_source
    now = time.time()
    if _reasoning_source is None or now >= _reasoning_source_retry_at:
        _reasoning_source_retry_at = now + _REASONING_RESOLVE_RETRY_SECONDS
        rebuilt = _build_reasoning_source()
        # Only announce the upgrade — a steady "none" must stay quiet or it
        # would log every retry forever on runtimes that expose no reasoning.
        if rebuilt.name != "none" and _reasoning_source is not None:
            log(f"reasoning source now available: {rebuilt.name}")
        _reasoning_source = rebuilt
    return _reasoning_source


def latest_reasoning_activity(session_id: str, since_ts: float) -> str | None:
    """Status-line text for genuine model reasoning, or None.

    The "thinking: " prefix is load-bearing: it tells the reader that what
    follows is the model's own words, not the bridge describing a tool call.
    """
    try:
        text = reasoning_source().latest_reasoning(session_id, since_ts)
    except Exception:
        return None
    return f"thinking: {text}" if text else None


def turn_reasoning_history(session_id: str, since_ts: float) -> str | None:
    """The finished turn's full reasoning, capped, or None.

    Returns None immediately when history is disabled — the default — so nothing
    is even read off disk, let alone sent. Never raises: a transcript is a nice
    extra, and a turn that produced a real reply must not fail because of it.
    """
    if not REASONING_HISTORY_ENABLED:
        return None
    try:
        text = reasoning_source().full_reasoning(session_id, since_ts)
    except Exception:
        return None
    if not text:
        return None
    text = text.strip()
    if not text:
        return None
    if len(text) <= _REASONING_HISTORY_MAX_CHARS:
        return text
    notice = "\n\n[reasoning truncated]"
    return text[: _REASONING_HISTORY_MAX_CHARS - len(notice)].rstrip() + notice


def post_reasoning_history(message_id: str, reasoning: str) -> None:
    """Attach a turn's reasoning to the agent message that carries its reply."""
    api("POST", "/chat/reasoning", body={
        "messageId": message_id,
        "agentId": AGENT_ID,
        "reasoning": reasoning,
    })


# Runtime notices Hermes prints around the answer. Never part of the reply, and
# useless to a human reading an Emperor thread. The tirith notice fires on the
# first turn of a fresh profile, while Hermes is still downloading its security
# scanner, and would otherwise open every agent's first reply.
HERMES_OUTPUT_NOISE_PREFIXES = (
    "Warning: Unknown toolsets:",
    "⚠ tirith security scanner",
)


def extract_stream_json(output: str) -> tuple[str | None, str | None]:
    """Pull the final answer and session id out of `--format stream-json` output.

    Hermes emits newline-delimited JSON events (system/tool_use/tool_result/
    text/result). Only the model's own `text`/`result` events are the reply;
    tool events are never forwarded, so no tool preview (diffs, command output)
    can leak into an Emperor message. Non-JSON lines — Hermes still prints a
    stray runtime notice to stdout even in quiet mode — are ignored.

    Returns `(reply, session_id)`. `reply` is None when no text-bearing event
    was seen (e.g. an older Hermes that ignored the flag), which lets the caller
    fall back to plain-text cleaning instead of posting an empty message.
    """
    parts: list[str] = []
    result_text: str | None = None
    session_id = ""
    for line in (output or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        if etype == "text" and isinstance(event.get("text"), str):
            parts.append(event["text"])
        elif etype == "result":
            if isinstance(event.get("text"), str):
                result_text = event["text"]
            if isinstance(event.get("session_id"), str):
                session_id = event["session_id"]
        elif etype == "system" and isinstance(event.get("session_id"), str) and not session_id:
            session_id = event["session_id"]
    if result_text is None and not parts:
        return None, (session_id or None)
    reply = result_text if result_text is not None else "".join(parts)
    return reply.strip(), (session_id or None)


def clean_hermes_output(output: str) -> str:
    """Strip the transport-level noise Hermes adds around the real answer.

    Hermes appends a `session_id: ...` footer and, when its config names a
    toolset it does not know, prints a `Warning: Unknown toolsets: ...` line
    before the answer. Both are runtime bookkeeping: forwarding them makes
    every Emperor message open with text the human cannot act on.
    """
    lines = output.strip().splitlines()
    while lines and lines[-1].startswith("session_id:"):
        lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()
    lines = [line for line in lines if not line.startswith(HERMES_OUTPUT_NOISE_PREFIXES)]
    return "\n".join(lines).strip()


def extract_session_id(output: str) -> str:
    for line in reversed(output.splitlines()):
        if line.startswith("session_id:"):
            return line.split(":", 1)[1].strip()
    return ""


def _terminate_turn(proc: subprocess.Popen[str]) -> None:
    """Graceful timeout for a turn.

    Hermes runs in its own process group (start_new_session), so a browser or
    other tool child dies with it. We send SIGTERM first and give the process
    a short window to checkpoint/save its session transcript to disk, then
    SIGKILL anything still alive. The next dispatch can then --resume from the
    saved session instead of re-running the entire slow turn from zero.
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    grace_deadline = time.time() + HERMES_TIMEOUT_GRACE_SECONDS
    while proc.poll() is None and time.time() < grace_deadline:
        time.sleep(0.25)
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    # The parent can exit on SIGTERM while a tool child ignores it. Its group
    # remains ours even after that exit; reap those children as well.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:
        pass


_active_turn_proc: subprocess.Popen[str] | None = None


def _handle_shutdown(signum: int, _frame: Any) -> None:
    """Stop the whole Hermes process group when systemd stops the bridge.

    Hermes runs in a new session so killing only the Python bridge can leave the
    active `hermes chat` (and its tools) orphaned. The message then remains in
    seen/acting while an invisible child keeps consuming resources.
    """
    global _active_turn_proc
    proc = _active_turn_proc
    if proc is not None and proc.poll() is None:
        _terminate_turn(proc)
    raise SystemExit(128 + signum)


def _persist_killed_session(
    sessions: Dict[str, str],
    session_key: str,
    exc: subprocess.TimeoutExpired,
) -> None:
    """Best-effort: if the killed turn already emitted its `session_id:` footer
    (Hermes prints it on stderr), record it so the next dispatch for this
    thread resumes with `--resume` instead of starting over. Never raises — a
    timeout is already a failure; don't turn it into a crash."""
    try:
        killed_output = "\n".join(
            part for part in [getattr(exc, "output", None), getattr(exc, "stderr", None)]
            if isinstance(part, str)
        )
        killed_session = extract_session_id(killed_output)
        if killed_session:
            sessions[session_key] = killed_session
    except Exception:
        pass


class TurnInterrupted(Exception):
    """An operator stopped this turn; it is not a runtime failure."""


class HermesIdleTimeout(subprocess.TimeoutExpired):
    """The runtime stayed alive but emitted no observable progress."""


_MAX_CAPTURE_CHARS = 8 * 1024 * 1024


def _runtime_progress_marker() -> tuple[tuple[str, int, int], ...]:
    """Cheap marker for durable Hermes activity during the current turn.

    Hermes writes model/tool lifecycle events to agent.log and incremental
    session rows to state.db. Watching metadata for both catches progress that
    is not printed to stream-json, without parsing another process's live DB.
    """
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if not hermes_home:
        return ()
    root = Path(hermes_home)
    marker: list[tuple[str, int, int]] = []
    for path in (root / "logs" / "agent.log", root / "state.db"):
        try:
            stat = path.stat()
            marker.append((str(path), stat.st_mtime_ns, stat.st_size))
        except OSError:
            continue
    return tuple(marker)


def fetch_runtime_control(message: Dict[str, Any] | None = None) -> Dict[str, Any]:
    query = {"agentId": AGENT_ID}
    if message and message.get("id"):
        query["messageId"] = message["id"]
    return api("GET", "/agents/control", query=query)


def apply_runtime_controls(payload: Dict[str, Any], state: Dict[str, Any]) -> bool:
    commands = payload.get("commands") or []
    if not commands:
        return False
    # Persist the fresh-session decision before acknowledging: a restart between
    # these writes must never resume the prompt the operator just stopped.
    import emperor_goals
    emperor_goals.pause_all(sys.modules[__name__], state)
    state["sessions"] = {}
    save_state(state)
    for command in commands:
        api("POST", "/agents/control", query={"agentId": AGENT_ID}, body={"commandId": command["id"]})
    return True


def invoke_hermes(
    cmd: List[str],
    message: Dict[str, Any],
    *,
    resumed: bool = False,
    session_id: str = "",
    state: Dict[str, Any] | None = None,
) -> subprocess.CompletedProcess[str]:
    global _active_turn_proc
    env = os.environ.copy()
    # Provider hint: pass EMPEROR_CLAW_LLM_PROVIDER so Hermes skills can auto-detect.
    # The actual API key is configured by the user in ~/.hermes/.env or environment.
    if _agent_llm_provider:
        env["EMPEROR_CLAW_LLM_PROVIDER"] = _agent_llm_provider
    # The bridge already prepends operating-guide.md to this turn. Tell the
    # Hermes plugin context hook not to inject the same guide a second time.
    env["EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE"] = "1"
    # In lean mode the kernel already carries the operating rules and the
    # static block is deliberately minimal, so tell the plugin hook to inject
    # NOTHING (it would otherwise re-add the full guide to every LLM call).
    env["EMPEROR_CLAW_CONTEXT_MODE"] = "lean" if lean_context_active() else "full"
    # The message this turn answers. The plugin can stamp it as
    # replyToMessageId on a tool post into this same thread (the "acknowledge
    # first" message), which keeps the server's answered-cutoff anchored at the
    # trigger instead of at the acknowledgement's own instant. A goal
    # continuation answers no human message (its id is the objective's command
    # record), so it exports none and the plugin refuses an ack there.
    for key, value in (
        ("EMPEROR_CLAW_TURN_MESSAGE_ID", None if message.get("goalTurn") else message.get("id")),
        ("EMPEROR_CLAW_TURN_THREAD_ID", message.get("threadId") or message.get("thread_id")),
        ("EMPEROR_CLAW_TURN_THREAD_TYPE", message.get("threadType") or message.get("thread_type")),
    ):
        if value:
            env[key] = str(value)
        else:
            env.pop(key, None)
    # start_new_session puts Hermes (and any browser/tool children it spawns)
    # in their own process group, so a timeout can signal the whole tree.
    proc = subprocess.Popen(cmd, text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    _active_turn_proc = proc
    _turn_timing["spawnedAt"] = time.time()
    captured: dict[str, list[str]] = {"stdout": [], "stderr": []}
    captured_sizes = {"stdout": 0, "stderr": 0}
    capture_lock = threading.Lock()
    last_progress = [time.time()]

    def drain(stream: Any, name: str) -> None:
        if stream is None:
            return
        try:
            for chunk in iter(stream.readline, ""):
                if not chunk or not isinstance(chunk, str):
                    break
                with capture_lock:
                    captured[name].append(chunk)
                    captured_sizes[name] += len(chunk)
                    while captured_sizes[name] > _MAX_CAPTURE_CHARS and len(captured[name]) > 1:
                        captured_sizes[name] -= len(captured[name].pop(0))
                    last_progress[0] = time.time()
        finally:
            try:
                stream.close()
            except Exception:
                pass

    readers = [
        threading.Thread(target=drain, args=(proc.stdout, "stdout"), daemon=True),
        threading.Thread(target=drain, args=(proc.stderr, "stderr"), daemon=True),
    ]
    for reader in readers:
        reader.start()

    def finish_capture() -> tuple[str, str]:
        try:
            proc.wait(timeout=max(1.0, HERMES_TIMEOUT_GRACE_SECONDS + 2.0))
        except subprocess.TimeoutExpired:
            _terminate_turn(proc)
            proc.wait()
        for reader in readers:
            reader.join(timeout=2.0)
        with capture_lock:
            return "".join(captured["stdout"]), "".join(captured["stderr"])

    stopped = [False]

    def stop_turn() -> None:
        stopped[0] = True
        _terminate_turn(proc)

    try:
        started = time.time()
        last_status = 0.0
        status_failures = 0
        progress_marker = _runtime_progress_marker()
        while proc.poll() is None:
            now = time.time()
            elapsed = now - started
            next_marker = _runtime_progress_marker()
            if next_marker != progress_marker:
                progress_marker = next_marker
                last_progress[0] = now
            if HERMES_TIMEOUT_SECONDS > 0 and elapsed > HERMES_TIMEOUT_SECONDS:
                stop_turn()
                stdout, stderr = finish_capture()
                raise subprocess.TimeoutExpired(cmd, HERMES_TIMEOUT_SECONDS, output=stdout, stderr=stderr)
            if HERMES_IDLE_TIMEOUT_SECONDS > 0 and now - last_progress[0] > HERMES_IDLE_TIMEOUT_SECONDS:
                stop_turn()
                stdout, stderr = finish_capture()
                raise HermesIdleTimeout(cmd, HERMES_IDLE_TIMEOUT_SECONDS, output=stdout, stderr=stderr)
            if now - last_status >= 3:
                last_status = time.time()
                try:
                    control = fetch_runtime_control(message)
                except Exception as exc:
                    # Temporary server failures do not abandon an otherwise healthy turn.
                    log(f"runtime control polling failed: {exc}")
                    control = {}
                try:
                    import emperor_goals
                    goal_interrupted = emperor_goals.process_commands(sys.modules[__name__], state if state is not None else {}, active=True)
                except Exception as exc:  # noqa: BLE001 - same rule as the control poll
                    log(f"goal command polling failed: {exc}")
                    goal_interrupted = False
                if goal_interrupted or control.get("commands") or control.get("cancelled"):
                    stop_turn()
                    finish_capture()
                    try:
                        apply_runtime_controls(control, state if state is not None else {})
                    except Exception as exc:  # noqa: BLE001 - the stop itself already happened
                        log(f"stop applied; control acknowledgement pending: {exc}")
                    raise TurnInterrupted("Stopped by operator")
                # The status ping is cosmetic; the turn is not. A transport
                # error here used to unwind out of this loop while Hermes kept
                # running and holding its session lease: the bridge requeued the
                # prompt, every retry was refused SESSION_NOT_OWNED, and the
                # human's message ended up cancelled. Keep waiting instead; the
                # reply goes through the outbox once the network is back.
                try:
                    # Preference order, most to least specific: the model's real
                    # reasoning, then a real tool call, then honest elapsed time.
                    # Nothing here is inferred or invented.
                    activity = (
                        latest_reasoning_activity(session_id, started)
                        or latest_tool_activity(started)
                        or format_turn_activity(elapsed, resumed)
                    )
                    update_chat_status(message, typing=True, execution_state="acting", activity=activity)
                    if status_failures:
                        log(f"status updates recovered after {status_failures} failure(s); turn kept running")
                    status_failures = 0
                except Exception as exc:  # noqa: BLE001 - never abandon a live turn
                    status_failures += 1
                    if status_failures == 1 or status_failures % 20 == 0:
                        log(f"status update failed while Hermes runs ({status_failures}x); still waiting for the turn: {exc}")
            time.sleep(0.5)
        stdout, stderr = finish_capture()
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    finally:
        # Whatever unwinds this frame, never leave the turn running detached: a
        # live orphan keeps its session lease, so every retry of the same
        # message would be refused until it exits on its own.
        if not stopped[0] and proc.poll() is None:
            log(f"abandoning wait on live Hermes pid {proc.pid}; terminating it so its session lease is released")
            stop_turn()
        if _active_turn_proc is proc:
            _active_turn_proc = None


# Reasoning transcript of the most recent turn, or None.
#
# It lives here rather than in run_hermes's return value because the transcript
# cannot be posted until the reply has been sent and the control plane has
# handed back the id of the message it created. The bridge processes one message
# at a time in a single thread, so there is exactly one "most recent turn";
# run_hermes clears this at the start of every turn so a failed turn can never
# attach a previous turn's thinking to a new reply.
_last_turn_reasoning: str | None = None


# Condensed operating rules used ONLY when the packaged operating-guide.md is
# missing or unreadable. It keeps a bridge deployed without its sibling file
# functional (if less detailed) instead of failing every turn. The packaged
# guide remains the source of truth; keep this short so it cannot drift far.
BUILTIN_OPERATING_GUIDE = """## Emperor minimum operating practices

Emperor is the durable source of truth. Read the relevant scoped Knowledge & Rules before assuming company conventions. Use tools before claiming writes succeeded.

### Chat, mentions, and privacy

- Reply in the current thread. Direct threads are private; no @mention is needed. Team chat is visible to the company — never copy private details or secrets into it.
- Act on a team message only when it addresses your @name. To ask a sibling a question, open a private pair thread (emperor_send_message with targetAgentId). To ask a sibling to do work, assign it a task — a @mention requests attention, it does not assign work.
- Group chats are members-only team channels with the same @mention rules; only their members receive them. A human's @all in a group addresses every member; never write @all yourself.
- Reply to a requested handoff once. When a reply closes your own request, stop — no acknowledgment loop. FYI/status updates have no @mention.
- Acknowledge first: before a human's request that takes more than a couple of tool calls or ~30 seconds, send ONE short acknowledgement with emperor_send_message(acknowledge=true), then reply with the result. Never for chit-chat, one-step answers or agent messages.

### Projects and tasks

- Reuse a project by outcome; keep the goal to 3–8 words and put background and success criteria in memory/tasks.
- Every task has exactly one owner: assign it to the responsible agent or person. A chat @mention is not an assignment.
- The assignee closes the task, and only after the acceptance criteria are met with evidence attached. Keep progress and blockers in task notes (emperor_add_task_note) or task updates, not chat: one note per milestone (started, blocked, handed off, finished), never per step.
- A request that needs real work becomes a task (assigned, with acceptance criteria) before you start; quick questions don't. Keep its state true: in_progress, review while waiting on a person, done with evidence.
- Request an approval (emperor_request_approval) before spending money, sending anything outside the company, publishing, deleting, or closing work that needs sign-off. Don't act until approved.
- Emperor sends you a daily review of your open tasks: work through it and reply with a short summary.
- A request from another platform arrives as a system message from a named source, already tracked as a task assigned to you: reply in that chat with the result and set the task done when finished.
- When a person tells you how they want you to work or corrects you, save it with emperor_remember so you follow it next time.

### Knowledge & Rules

- Notes are reusable doctrine, SOPs, and business rules — not one-off facts, logs, or deliverables.
- Pick the narrowest scope (company/customer/project/agent), search before creating, and update the canonical note. Never store secrets in note content.
- Use status=active for established facts, draft for uncertain proposals. isShared is the auto-injection switch, not access control — enable it only for short rules needed repeatedly.

### Honesty

- Never claim a task is done, an agent was created, or a message was sent unless the tool call actually succeeded.
"""

_operating_guide_warned = False


def default_operating_guide_path() -> Path:
    """The packaged guide's location: next to the bridge's parent directory."""
    return Path(__file__).resolve().parent.parent / "operating-guide.md"


def load_operating_guide() -> str:
    """Return the operating guide for the system prompt. Never raises.

    Resolution order: EMPEROR_CLAW_OPERATING_GUIDE_PATH when set, then the
    packaged `operating-guide.md` next to the bridge's parent directory. A
    missing or unreadable file degrades to BUILTIN_OPERATING_GUIDE and logs a
    single warning per process — the dispatch loop would otherwise repeat the
    same warning every poll, and a missing guide must not stop the agent from
    answering at all.
    """
    global _operating_guide_warned
    candidates: List[Path] = []
    if OPERATING_GUIDE_PATH:
        candidates.append(Path(OPERATING_GUIDE_PATH))
    candidates.append(default_operating_guide_path())

    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except OSError as exc:
            if not _operating_guide_warned:
                log(f"operating guide unreadable at {path}: {exc} — using built-in fallback")
                _operating_guide_warned = True
            continue
        if text.strip():
            return text

    if not _operating_guide_warned:
        log(
            "operating guide not found (looked in "
            + ", ".join(str(p) for p in candidates)
            + ") — using built-in fallback"
        )
        _operating_guide_warned = True
    return BUILTIN_OPERATING_GUIDE


# ── Live profile: instructions and memory read from Emperor ──────────────────
# The role instructions in the environment are fixed when the container starts,
# so edits made in the app never reached a running agent. Servers since 0.8.59
# return the current instructions with the agent's memory; read both before a
# turn (cached briefly) and fall back to the environment on older servers.
LIVE_PROFILE_TTL_SECONDS = 60
MAX_MEMORY_PROMPT_CHARS = 3000
MAX_MEMORY_ITEM_CHARS = 300
_live_profile: Dict[str, Any] = {"at": 0.0, "instructions": None, "memories": []}


def refresh_live_profile(force: bool = False) -> None:
    now = time.time()
    if not AGENT_ID or (not force and now - float(_live_profile["at"]) < LIVE_PROFILE_TTL_SECONDS):
        return
    _live_profile["at"] = now
    try:
        payload = api("GET", f"/agents/{urllib.parse.quote(AGENT_ID)}/memory", query={"limit": 20})
    except Exception as exc:
        log(f"live profile refresh failed: {exc}")
        return
    if not isinstance(payload, dict):
        return
    instructions = payload.get("instructions")
    if isinstance(instructions, str):
        _live_profile["instructions"] = instructions.strip()
    entries = payload.get("entries")
    if isinstance(entries, list):
        _live_profile["memories"] = [e for e in entries if isinstance(e, dict)]


def current_instructions() -> str:
    """Instructions from the app when the server sends them, else the environment's."""
    live = _live_profile.get("instructions")
    return live if isinstance(live, str) else AGENT_INSTRUCTIONS


def format_memory_context(entries: List[Dict[str, Any]] | None = None) -> str:
    """The agent's memories, newest last, within a fixed budget (newest win)."""
    items = entries if entries is not None else list(_live_profile.get("memories") or [])
    lines: List[str] = []
    used = 0
    for entry in reversed(items):
        text = str(entry.get("summary") or entry.get("content") or "").strip().replace("\n", " ")
        if not text:
            continue
        if len(text) > MAX_MEMORY_ITEM_CHARS:
            text = text[: MAX_MEMORY_ITEM_CHARS - 1] + "…"
        kind = str(entry.get("kind") or "note")
        line = f"- ({kind}) {text}"
        if used + len(line) > MAX_MEMORY_PROMPT_CHARS:
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    return "What you remember (your Emperor memory; people can edit it in the app):\n" + "\n".join(reversed(lines)) + "\n\n"


MAX_TASK_TEXT_CHARS = 120


def clean_task_text(value: Any) -> str:
    """Collapse whitespace/newlines and cap task text that is injected into a prompt."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) > MAX_TASK_TEXT_CHARS:
        text = text[: MAX_TASK_TEXT_CHARS - 1] + "…"
    return text


def format_my_open_tasks() -> str:
    """My open tasks (id, title, state, who is waiting) — max OPEN_TASKS_LIMIT lines."""
    try:
        payload = api("GET", "/tasks", query={"assignedAgentId": AGENT_ID, "limit": 25})
        task_rows = payload.get("tasks") if isinstance(payload, dict) else []
        if not isinstance(task_rows, list):
            return ""
        active = [
            t for t in task_rows
            if isinstance(t, dict)
            and str(t.get("state") or "") in _OPEN_TASK_STATES
            # Older servers ignore the assignedAgentId query filter and return
            # every agent's tasks; re-check locally so the prompt never claims
            # another agent's work as "mine".
            and str(t.get("assignedAgentId") or "") == AGENT_ID
        ]
        if not active:
            return "My open tasks: none."
        lines: List[str] = []
        for t in active[:OPEN_TASKS_LIMIT]:
            tid = str(t.get("id") or "")
            spec = t.get("inputJson") if isinstance(t.get("inputJson"), dict) else {}
            title = clean_task_text(spec.get("title") or t.get("taskType") or "task")
            state = str(t.get("state") or "").replace("_", " ")
            summary = t.get("approvalSummary") if isinstance(t.get("approvalSummary"), dict) else {}
            waiting = " · waiting for approval" if summary.get("pending") else ""
            lines.append(f'- {tid}: "{title}" [{state}]{waiting}')
        return "My open tasks:\n" + "\n".join(lines)
    except Exception as exc:
        log(f"open tasks fetch failed: {exc}")
        return ""


def build_full_static_block(message: Dict[str, Any], state: Dict[str, Any]) -> str:
    """The default (full) block: guide, static rules, roster, brain context,
    instructions, memory. Sent once per session and byte-identical to the
    pre-lean behaviour."""
    # Three independent round trips; each formatter already degrades on error.
    lookups = run_parallel({
        "roster": lambda: format_agent_roster(AGENT_ID),
        "shared": lambda: format_company_brain_context(message),
        "profile": refresh_live_profile,
    })
    roster_context = lookups["roster"]
    shared_context = lookups["shared"]
    instructions = current_instructions()
    return (
        "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
        f"Agent name: {AGENT_NAME}\n"
        f"Agent role: {AGENT_ROLE}\n"
        + (f"Role instructions:\n{instructions}\n\n" if instructions else "")
        + format_memory_context()
        + load_operating_guide() + "\n\n"
        + "Reply to the latest message. Do not recap old context unless asked.\n"
        "Use Emperor tools only when the request needs durable state, exact chat history, or a real state change.\n"
        "For reusable knowledge, create or update a normal Company Brain note with top-level status: active for established knowledge; use status: draft only when explicitly uncertain.\n"
        "When writing Knowledge & Rules, use Obsidian-style markdown notes: frontmatter with scope/type/status/owner/tags, one reusable rule per note, explicit [[wikilinks]], and Evidence/Related sections when useful.\n"
        "Do not fake folders in note titles; Emperor places notes by company/customer/project/agent scope.\n"
        "Do not mention projects, tasks, resources, or Storage unless they are relevant to the user's request.\n"
        "Emperor is the source of truth. If local memory and Emperor disagree, prefer Emperor and surface the mismatch.\n\n"
        + format_reply_guidance() + "\n\n"
        "Where to look in Emperor:\n"
        "- Past chat/history: emperor_list_threads, then emperor_get_thread_messages.\n"
        "- Team roster: emperor_request GET /agents.\n"
        "- Projects/tasks: use emperor_get_task_overview first for status questions; use emperor_get_task only for a selected task.\n"
        "- Task progress/history: emperor_request GET /tasks/{id}/notes.\n"
        "- Company Brain / Knowledge & Rules: emperor_request GET /resources/context for resolved context, POST /resources for established knowledge (active) or uncertain proposals (draft), with top-level status, GET /resources for lookup.\n"
        "- Storage/files: emperor_request GET /artifacts for lookup; emperor_create_folder + emperor_upload_artifact for uploads.\n"
        "- External APIs are not Emperor; use terminal/curl or a dedicated plugin if available.\n\n"
        "Storage rules:\n"
        "- Storage is an Emperor abstraction; do not ask for or mention backing blob-provider keys.\n"
        "- For uploads, create/find the folder first, pass folderId to emperor_upload_artifact, then verify and report artifact id/path.\n"
        "- Do not upload randomly into the Storage root. Use customer/project/month/type folders when possible.\n"
        "- If upload fails, report an Emperor Storage upload failure with the tool error.\n\n"
        "Messaging model:\n"
        "- Direct threads are private one-human-to-one-agent conversations. Reply normally in direct threads.\n"
        "- Your answer is delivered to the current thread automatically. Do NOT call emperor_send_message to reply to the message you are answering — that posts a duplicate. Use emperor_send_message only to message a DIFFERENT thread (a sibling handoff in team chat).\n"
        "- Team chat is the shared visible coordination thread for humans and all agents.\n"
        "- Group chats are members-only team channels (e.g. a development team): the same @mention rules apply, and only their members receive them. Find yours with emperor_list_groups. A human's @all in a group is addressed to you; never write @all yourself.\n"
        "- ONLY respond to a team chat message if your @name appears in it. If your name is absent, the message is for someone else — stay silent.\n"
        "- To ask a sibling to do something: post in team chat with @SiblingName and one concrete request (use the roster below for the exact @name).\n"
        "- When a sibling @mentions you with a request, complete the work then reply with the answer and @mention them ONCE so it routes back. That reply CLOSES the request.\n"
        "- If you receive a reply that answers a request YOU made, do not reply again — no 'thanks', no acknowledgment, no follow-up @mention. A closing reply ends the exchange; only reply if you have a genuinely new, different request.\n"
        "- Never @mention the same agent twice in a row without a new human message or a materially new question in between — that is what causes infinite back-and-forth.\n"
        "- Informational updates (status, FYI, task done with no one waiting) go to team chat with NO @mention.\n"
        "- Safety net: if you and a sibling exchange more than a few consecutive messages in team chat with no human input, the bridge will automatically pause your replies in that thread until a human sends a new message. Don't rely on this — follow the rules above so it never triggers.\n\n"
        f"{roster_context}\n\n"
        + f"{shared_context}\n\n"
    )


def build_lean_static_block(lean: Dict[str, Any]) -> str:
    """The lean per-session head: header, instructions, memory, then the
    kernel, the always-block, the knowledge index, and the roster from the
    server's lean endpoint, plus one reply-formatting pointer.

    It deliberately drops the operating guide, the static rules (where to look,
    storage, messaging), the rich-reply guide, and the Company Brain bodies:
    those are Tier 2, loaded on demand through the Emperor tools.
    """
    refresh_live_profile()
    instructions = current_instructions()
    kernel = str(lean.get("kernel") or "").strip()
    always_block = str(lean.get("alwaysBlock") or "").strip()
    knowledge_index = str(lean.get("knowledgeIndex") or "").strip()
    roster = str(lean.get("roster") or "").strip()
    parts = [
        "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
        f"Agent name: {AGENT_NAME}\n"
        f"Agent role: {AGENT_ROLE}\n"
    ]
    if instructions:
        parts.append(f"Role instructions:\n{instructions}\n\n")
    parts.append(format_memory_context())
    if kernel:
        parts.append(kernel + "\n\n")
    if always_block:
        parts.append(always_block + "\n\n")
    if knowledge_index:
        parts.append(
            "Company knowledge index — load a note with emperor_get_knowledge_note, "
            "search with emperor_search_knowledge\n" + knowledge_index + "\n\n"
        )
    if roster:
        parts.append(roster + "\n\n")
    parts.append("Formatting: plain markdown; for rich blocks load manual section reply-formatting\n")
    return "".join(parts)


def build_static_block(message: Dict[str, Any], state: Dict[str, Any]) -> str:
    """The block that must not accumulate in session history. Sent once per
    session. In lean mode it is the server's kernel + knowledge index (cached
    per session, reused across turns); a lean fetch failure with no cached
    payload falls back to the full block for this turn, never an empty one."""
    if lean_context_active():
        lean = fetch_lean_context()
        if isinstance(lean, dict):
            return build_lean_static_block(lean)
    return build_full_static_block(message, state)


# Per-turn reminder of the operating guide's "acknowledge first" rule. Kept
# under ~200 chars because it rides on every human-originated turn. It names
# itself as the one allowed emperor_send_message into the current thread, since
# the static messaging rules (pinned byte-for-byte) forbid that in general.
ACK_FIRST_REMINDER = (
    "Acknowledge first: if this needs more than a couple of tool calls or ~30s, send ONE short ack via "
    "emperor_send_message(acknowledge=true), then work, then reply with the result."
)


def ack_first_reminder(message: Dict[str, Any]) -> str:
    """The ack reminder for a human-originated message, else "".

    Agent-to-agent and system messages never get it: an ack there is exactly
    the "on it" chatter the team rules forbid. Neither does an objective
    continuation (``goalTurn``): it carries senderType "human" for routing, but
    nobody is waiting on that step. EMPEROR_CLAW_HERMES_ACK_FIRST=0 turns the
    reminder off entirely.
    """
    if not ACK_FIRST_ENABLED or message.get("goalTurn"):
        return ""
    sender_type = str(message.get("senderType") or message.get("sender_type") or "").lower()
    return ACK_FIRST_REMINDER if sender_type == "human" else ""


def build_dynamic_block(message: Dict[str, Any], state: Dict[str, Any]) -> str:
    """The per-turn block: latest message, thread id, team digest, group context,
    and my open tasks. Sent on every wake (it is short and changes each turn)."""
    thread_id = str(message.get("threadId") or message.get("thread_id") or "team")
    text = str(message.get("text") or "")
    direct = is_direct_thread(message, state)
    # The team digest, the org chart and the task list are independent round
    # trips; overlap them instead of paying for each in turn.
    lookups = run_parallel({
        "main_chat": (lambda: format_main_chat_context(message)) if direct else (lambda: ""),
        "organization": format_organization_context,
        "open_tasks": format_my_open_tasks,
    })
    main_chat_context = lookups["main_chat"]
    organization = lookups["organization"]
    open_tasks = lookups["open_tasks"]
    group_context = format_group_context(message)
    team_roles = format_my_team_roles() if not organization and direct else ""
    reminder = ack_first_reminder(message)
    return (
        (f"{open_tasks}\n\n" if open_tasks else "")
        + (f"{main_chat_context}\n\n" if main_chat_context else "")
        + (f"{group_context}\n\n" if group_context else "")
        + (f"{organization}\n\n" if organization else "")
        + (f"{team_roles}\n\n" if team_roles else "")
        + (f"{reminder}\n" if reminder else "")
        + f"Thread: {thread_id}\n"
        + f"Latest message: {text}"
    )


def _without_resume(cmd: list[str]) -> list[str]:
    """The same command built for a fresh session (drops ``--resume <id>``)."""
    return [
        part
        for index, part in enumerate(cmd)
        if not (part == "--resume" or (index > 0 and cmd[index - 1] == "--resume"))
    ]


# Static blocks by session key: {"block", "hash", "builtAt"}. In memory only:
# after a restart the persisted primed hash is reused and the block is rebuilt
# in the background, so the first turn after a restart is not slowed either.
_static_block_cache: Dict[str, Dict[str, Any]] = {}
_static_block_lock = threading.Lock()
_static_block_refreshing: set[str] = set()
# Set by invalidate_static_block(): a cached block (or a persisted hash) older
# than this must be rebuilt synchronously before it is trusted again.
_static_block_invalidated_at = 0.0


def invalidate_static_block() -> None:
    """Force the next turn of every session to rebuild its static block.

    For inputs the bridge knows changed (e.g. the server's reply-format guide);
    everything else is picked up by the periodic background refresh.
    """
    global _static_block_invalidated_at
    with _static_block_lock:
        _static_block_invalidated_at = time.time()
        _static_block_cache.clear()


def plan_static_block(
    primed_hash: str,
    cached: Dict[str, Any] | None,
    *,
    now: float,
    refresh_seconds: float,
    invalidated_at: float,
    process_started_at: float,
) -> str:
    """Decide how a RESUMED turn gets its static block. Pure; no I/O.

    - "build":   rebuild synchronously (no known hash, cache disabled, or
                 explicitly invalidated since the block/hash was produced).
    - "changed": a background rebuild produced a different hash: re-prime the
                 session with that cached block now.
    - "refresh": reuse the primed hash for this turn and rebuild in the
                 background (cache missing or older than the refresh window).
    - "reuse":   reuse the primed hash; nothing to fetch.
    """
    if not primed_hash or refresh_seconds <= 0:
        return "build"
    built_at = float(cached.get("builtAt") or 0.0) if cached else None
    if invalidated_at and invalidated_at > (built_at if built_at is not None else process_started_at):
        return "build"
    if cached is None:
        return "refresh"
    if str(cached.get("hash") or "") != primed_hash:
        return "changed"
    if now - float(built_at or 0.0) >= refresh_seconds:
        return "refresh"
    return "reuse"


def _remember_static_block(session_key: str, block: str) -> str:
    digest = hashlib.sha256(block.encode("utf-8")).hexdigest()
    with _static_block_lock:
        _static_block_cache[session_key] = {"block": block, "hash": digest, "builtAt": time.time()}
    return digest


def schedule_static_refresh(session_key: str, message: Dict[str, Any], state: Dict[str, Any]) -> bool:
    """Rebuild one session's static block off the dispatch path.

    At most one refresh per session is in flight. A failure only logs: the
    session keeps its primed hash and the next window tries again.
    """
    with _static_block_lock:
        if session_key in _static_block_refreshing:
            return False
        _static_block_refreshing.add(session_key)
    snapshot = dict(message)

    def refresh() -> None:
        try:
            _remember_static_block(session_key, build_static_block(snapshot, state))
        except Exception as exc:  # noqa: BLE001 - background best effort
            log(f"static block refresh for {session_key} failed: {exc}")
        finally:
            with _static_block_lock:
                _static_block_refreshing.discard(session_key)

    threading.Thread(target=refresh, name="emperor-static-refresh", daemon=True).start()
    return True


# Timestamps of the turn in flight (see format_turn_timing). run_hermes resets
# it; invoke_hermes records when the Hermes process was spawned.
_turn_timing: Dict[str, float] = {}
# Hermes session id of the turn in flight, once known (the resumed id, or the
# one Hermes reported). agent.log interleaves every process on the profile, so
# usage is only attributed to this turn by its session id. "" = unknown.
_turn_session_id = ""


def run_hermes(message: Dict[str, Any], state: Dict[str, Any]) -> str:
    thread_id = str(message.get("threadId") or message.get("thread_id") or "team")
    session_key = f"{AGENT_NAME}:{thread_id}"
    sessions = state.setdefault("sessions", {})
    primed = state.setdefault("primed", {})
    entry = primed.get(session_key)
    entry = entry if isinstance(entry, dict) else None
    turns = int(entry.get("turns", 0)) if entry else 0
    started_at = float(entry.get("startedAt", time.time())) if entry else time.time()
    _turn_timing.clear()
    global _turn_session_id
    _turn_session_id = ""

    direct = is_direct_thread(message, state)
    max_turns = DIRECT_SESSION_MAX_TURNS if direct else SESSION_MAX_TURNS
    max_hours = DIRECT_SESSION_MAX_HOURS if direct else SESSION_MAX_HOURS

    elapsed_hours = (time.time() - started_at) / 3600.0
    rotate = turns >= max_turns or (max_hours > 0 and elapsed_hours >= max_hours)
    resume_id = "" if rotate else str(sessions.get(session_key) or "")

    # Never open a turn on a session another live process owns: Hermes refuses
    # it (SESSION_NOT_OWNED / SESSION_COORDINATION_UNAVAILABLE) and that refusal
    # used to cost the message. Wait instead -- and only give up on the context
    # once the other owner has clearly parked there. Checked before any context
    # is fetched: a turn that cannot start must not pay for its prompt.
    if resume_id:
        holder = session_holder_pid(resume_id)
        if holder and reap_orphan_turn(holder, reason=f"lease on session {resume_id}"):
            holder = session_holder_pid(resume_id)
        if holder:
            # Waiting keeps both the message and the thread context. Opening a
            # fresh session instead leaves two turns of the same profile
            # writing one state.db -- the shape that retires a WAL -- so a live
            # foreign holder is never sided against, only reported.
            misses = busy_misses(state, message)
            if misses >= SESSION_BUSY_FRESH_AFTER:
                log(
                    f"session {resume_id} still leased to live pid {holder} after {misses} waits "
                    f"({describe_pid(holder)}) -> waiting, not opening a second writer on {session_key}"
                )
            raise SessionBusy(
                "SESSION_NOT_OWNED", f"session {resume_id} lease held by live pid {holder} ({describe_pid(holder)})"
            )

    primed_hash = str(entry.get("staticHash") or "") if entry else ""
    plan = "build"
    if resume_id and primed_hash:
        with _static_block_lock:
            cached = dict(_static_block_cache[session_key]) if session_key in _static_block_cache else None
        plan = plan_static_block(
            primed_hash,
            cached,
            now=time.time(),
            refresh_seconds=STATIC_BLOCK_REFRESH_SECONDS,
            invalidated_at=_static_block_invalidated_at,
            process_started_at=BRIDGE_STARTED_AT,
        )
    static_block: str | None = None
    if plan == "build":
        static_block = build_static_block(message, state)
        static_hash = _remember_static_block(session_key, static_block)
    elif plan == "changed":
        static_block = str(cached["block"])
        static_hash = str(cached["hash"])
    else:
        # Resumed session whose static block is already in its history: only
        # the hash is used, so do not refetch roster/brain/memory for it.
        static_hash = primed_hash
        if plan == "refresh":
            schedule_static_refresh(session_key, message, state)
    dynamic_block = build_dynamic_block(message, state)

    def full_static_block() -> str:
        # A recovery path that falls back to a fresh session needs the real
        # block even when this turn planned to reuse the hash.
        nonlocal static_block, static_hash
        if static_block is None:
            static_block = build_static_block(message, state)
            static_hash = _remember_static_block(session_key, static_block)
        return static_block

    if rotate:
        # Start a fresh Hermes session so the static block is re-sent once and
        # the accumulated history is dropped. Team/group sessions rotate; direct
        # human threads rotate only on the much larger cap.
        sessions.pop(session_key, None)
        turns = 0
        started_at = time.time()
        send_static = True
    else:
        hash_changed = entry is not None and primed_hash != static_hash
        # A fresh session must always be primed: if there is no resume id (e.g.
        # the session was dropped by a "Session not found" recovery but the primed
        # entry survived) the static block still has to be sent.
        send_static = entry is None or hash_changed or not resume_id

    prompt = (full_static_block() + "\n\n" if send_static else "") + dynamic_block

    cmd = [
        HERMES_BIN,
        "chat",
        "-Q",
        "--format",
        "stream-json",
        "--source",
        "emperor",
        "--toolsets",
        HERMES_TOOLSETS or "emperor-claw",
        "-q",
        prompt,
    ]
    if resume_id:
        cmd[3:3] = ["--resume", resume_id]
    global _last_turn_reasoning
    _last_turn_reasoning = None
    turn_started = time.time()
    fresh_retry = False
    attempt = 0
    while True:
        attempt += 1
        _turn_session_id = resume_id
        try:
            result = invoke_hermes(cmd, message, resumed=bool(resume_id), session_id=resume_id, state=state)
        except subprocess.TimeoutExpired as exc:
            _persist_killed_session(sessions, session_key, exc)
            _turn_session_id = str(sessions.get(session_key) or resume_id or "")
            raise
        _turn_session_id = (
            extract_stream_json(result.stdout)[1]
            or extract_session_id("\n".join([result.stdout or "", result.stderr or ""]))
            or resume_id
        )
        if result.returncode == 0:
            break
        # stderr often contains *only* the `session_id: ...` footer Hermes
        # appends regardless of success/failure — preferring it blindly hides
        # the real error (e.g. an auth failure reported on stdout). Prefer any
        # text the model emitted, then the cleaned combined streams.
        stream_reply, _ = extract_stream_json(result.stdout)
        combined = "\n".join(filter(None, [result.stdout, result.stderr]))
        detail = stream_reply or clean_hermes_output(combined) or combined.strip() or "Hermes failed"
        if resume_id and "Session not found" in combined and attempt <= 2:
            sessions.pop(session_key, None)
            resume_id = ""
            cmd = _without_resume(cmd)
            # A fresh session is a first turn: it must carry the static block.
            cmd[cmd.index("-q") + 1] = full_static_block() + "\n\n" + dynamic_block
            continue
        if is_session_contention(combined, detail):
            reason = parse_refusal_reason(combined, detail) or "SESSION_NOT_OWNED"
            misses = busy_misses(state, message)
            holder = session_holder_pid(resume_id) if resume_id else None
            if holder and reap_orphan_turn(holder, reason=f"refusal {reason} on session {resume_id}"):
                holder = session_holder_pid(resume_id)
            if (
                resume_id
                and not fresh_retry
                and attempt <= 2
                and misses >= SESSION_BUSY_FRESH_AFTER
                and holder is None
            ):
                # Fresh session only when the lease has no live owner: then the
                # registry is stale and the lock can never be released by
                # waiting. With a live holder this would start a *second* turn
                # on the same profile, which is how a WAL gets retired.
                log(
                    f"session {resume_id} refused ({reason}) after {misses} waits and the lease "
                    f"has no live owner -> fresh session for {session_key}"
                )
                fresh_retry = True
                sessions.pop(session_key, None)
                resume_id = ""
                cmd = _without_resume(cmd)
                cmd[cmd.index("-q") + 1] = full_static_block() + "\n\n" + dynamic_block
                continue
            if holder is not None and misses >= SESSION_BUSY_FRESH_AFTER:
                log(
                    f"session {resume_id} refused ({reason}) after {misses} waits but pid {holder} "
                    f"is alive ({describe_pid(holder)}) -> waiting, not opening a second writer"
                )
            raise SessionBusy(reason, detail)
        raise HermesTurnFailed(detail, stderr=result.stderr or "")
    stream_reply, stream_session = extract_stream_json(result.stdout)
    new_session_id = stream_session or extract_session_id("\n".join([result.stdout or "", result.stderr or ""]))
    if new_session_id:
        sessions[session_key] = new_session_id
    _last_turn_reasoning = turn_reasoning_history(new_session_id or resume_id, turn_started)
    primed[session_key] = {"staticHash": static_hash, "turns": turns + 1, "startedAt": started_at}
    if stream_reply is not None:
        return stream_reply
    return clean_hermes_output(result.stdout)


def send_reply(
    message: Dict[str, Any],
    text: str,
    *,
    transport_retry: bool = True,
    idempotency_key: str | None = None,
) -> str | None:
    """Post the reply and return the id of the stored message, if any.

    The id is what reasoning history is attached to. It can legitimately be
    None: the send route deduplicates identical text within a 2-minute window
    and returns no id in that case, and there is nothing to annotate then.
    """
    if not text:
        return None
    body: Dict[str, Any] = {
        "thread_id": message.get("threadId") or message.get("thread_id"),
        "agentId": AGENT_ID,
        "text": text,
        "targetAgentId": None,
        "replyToMessageId": message.get("id"),
    }
    # Carry the thread kind only when the server told us one. Never invent
    # "direct": an omitted/unknown kind that gets forced to direct is how an
    # agent-to-agent reply lands in the sender's own operator DM. With
    # replyToMessageId set, the server derives the real thread from the source.
    thread_type = message.get("threadType") or message.get("thread_type")
    if thread_type:
        body["thread_type"] = thread_type
    extra: Dict[str, Any] = {}
    if not transport_retry:
        extra["transport_retry"] = False
    if idempotency_key:
        extra["idempotency_key"] = idempotency_key
    response = api("POST", "/messages/send", body=body, **extra)
    message_id = response.get("message_id") if isinstance(response, dict) else None
    return str(message_id) if message_id else None


OUTBOX_DIR = Path(
    os.environ.get("EMPEROR_CLAW_HERMES_OUTBOX_DIR", str(Path(STATE_PATH).with_suffix("")) + "-outbox")
)
OUTBOX_RETRY_BASE_SECONDS = max(5, int(os.environ.get("EMPEROR_CLAW_HERMES_OUTBOX_RETRY_BASE_SECONDS", "15")))
OUTBOX_RETRY_MAX_SECONDS = max(
    OUTBOX_RETRY_BASE_SECONDS, int(os.environ.get("EMPEROR_CLAW_HERMES_OUTBOX_RETRY_MAX_SECONDS", "900"))
)
OUTBOX_MAX_ATTEMPTS = max(1, int(os.environ.get("EMPEROR_CLAW_HERMES_OUTBOX_MAX_ATTEMPTS", "8")))


def _outbox_path(key: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in key)
    return OUTBOX_DIR / f"{safe}.json"


def outbox_entry(message: Dict[str, Any], text: str) -> Dict[str, Any]:
    """The parked-reply record for one finished turn. Pure; see outbox_put."""
    return {
        "key": f"{message.get('id') or 'unknown'}",
        "message_id": message.get("id"),
        "body": {
            "thread_id": message.get("threadId") or message.get("thread_id"),
            "agentId": AGENT_ID,
            "text": text,
            "targetAgentId": None,
            "replyToMessageId": message.get("id"),
        },
        "message_ref": {
            "id": message.get("id"),
            "threadId": message.get("threadId") or message.get("thread_id"),
        },
        "thread_type": message.get("threadType") or message.get("thread_type"),
        # Sent as Idempotency-Key on every POST of this reply, so a retry whose
        # earlier attempt was stored (response lost) is not stored twice.
        "idempotency_key": str(uuid.uuid4()),
        "created_at": time.time(),
        "attempts": 0,
        "next_at": 0.0,
    }


def outbox_put(message: Dict[str, Any], text: str) -> Dict[str, Any]:
    """Persist a finished reply *before* the POST that delivers it.

    The turn is expensive and, more importantly, it is over: its text only
    exists in this variable. A transport failure between here and the server
    used to bubble out of `send_reply`, land in the turn's `except Exception`,
    and requeue the *prompt* -- the operator saw silence and the bridge paid
    for a second full turn that produced a second, later answer. Writing to
    disk first makes the POST retryable on its own: the worst case becomes a
    duplicate delivery of the same text, never a lost reply.
    """
    entry = outbox_entry(message, text)
    if not entry["body"]["thread_id"]:
        # Without a thread there is nothing to deliver to; keep the text on
        # disk anyway so it can be recovered by hand.
        log(f"reply for {entry['message_id']} has no thread_id; parked in outbox for inspection")
    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
    path = _outbox_path(entry["key"])
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return entry


def _outbox_forget(entry: Dict[str, Any]) -> None:
    try:
        _outbox_path(str(entry.get("key") or "")).unlink()
    except OSError:
        pass


def _outbox_save(entry: Dict[str, Any]) -> None:
    """Rewrite a parked entry in place (best effort: the old copy stays valid)."""
    try:
        OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
        path = _outbox_path(str(entry.get("key") or ""))
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        log(f"outbox entry {entry.get('key')} not rewritten: {exc}")


def _entry_reply_target(entry: Dict[str, Any]) -> Dict[str, Any]:
    """The message shape send_reply needs, rebuilt from a parked entry."""
    body = entry.get("body") or {}
    ref = entry.get("message_ref") or {}
    target: Dict[str, Any] = {
        "id": body.get("replyToMessageId") or ref.get("id") or entry.get("message_id"),
        "threadId": body.get("thread_id") or ref.get("threadId"),
    }
    if entry.get("thread_type"):
        target["threadType"] = entry["thread_type"]
    return target


def _finish_deferred_run(entry: Dict[str, Any], reply_id: str | None, *, delivered: bool) -> None:
    """Post the run-ledger finish a parked reply was holding. Never raises.

    The finish is deferred until delivery so the ledger row carries the stored
    reply id; its token and tool counts were captured when the turn ended,
    because by delivery time agent.log already holds later turns.
    """
    ledger = entry.get("ledger_finish")
    if not isinstance(ledger, dict) or not ledger.get("run_id"):
        return
    try:
        payload = dict(ledger.get("payload") or {})
        if delivered:
            if reply_id:
                payload["replyMessageId"] = reply_id
        else:
            payload["status"] = "failed"
            payload["error"] = "ReplyUndeliverable"
        post_run_finish(str(ledger["run_id"]), payload)
    except Exception as exc:  # noqa: BLE001 - the ledger is never worth a reply
        _log_ledger_failure("deferred finish", exc)


def deliver_reply(entry: Dict[str, Any], state: Dict[str, Any], *, attempts: int = 3) -> str | None:
    """POST one parked reply, retrying only the POST. Returns the reply id.

    The POST itself goes through send_reply, the single reply primitive, so the
    outbox and the direct path can never drift apart in body shape.
    """
    target = _entry_reply_target(entry)
    text = str((entry.get("body") or {}).get("text") or "")
    if not entry.get("idempotency_key"):
        # Parked by an older bridge: pin a key now, before the first retry.
        entry["idempotency_key"] = str(uuid.uuid4())
        _outbox_save(entry)
    last_exc: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            reply_id = send_reply(target, text, idempotency_key=str(entry["idempotency_key"]))
        except Exception as exc:  # noqa: BLE001 - classified below
            last_exc = exc
            if not (is_transient_failure(describe_processing_error(exc)) or isinstance(exc, ApiError)):
                raise
            if attempt < attempts:
                delay = min(OUTBOX_RETRY_MAX_SECONDS, OUTBOX_RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
                log(f"reply for {entry.get('message_id')} POST failed ({exc}); retrying in {delay}s")
                if delay > 0:
                    time.sleep(delay)
            continue
        _outbox_forget(entry)
        message_id = entry.get("message_id")
        if message_id:
            remember_seen(state, str(message_id))
            save_state(state)
        # "Resolved" is the operator-visible claim that this message was
        # answered, so it waits for the 2xx -- not for the turn.
        ref = entry.get("message_ref") or {}
        try:
            update_chat_status(ref, typing=False, execution_state="resolved")
        except Exception as status_exc:  # noqa: BLE001 - delivery already happened
            log(f"reply for {message_id} delivered but status update failed: {status_exc}")
        log(f"reply for {entry.get('message_id')} delivered as {reply_id or '<deduplicated>'}")
        _finish_deferred_run(entry, reply_id, delivered=True)
        return str(reply_id) if reply_id else None
    assert last_exc is not None
    raise last_exc


def outbox_failure_is_soft(exc: BaseException) -> bool:
    """Whether a failed reply POST may retry without counting toward giving up.

    Only "the request never got a real answer" is soft: a transport failure or
    a 5xx. Every 4xx, 429 included, is the server refusing this reply (the loop
    guard answers 429 for as long as the thread stays paused), so it spends
    the OUTBOX_MAX_ATTEMPTS budget instead of retrying forever.
    """
    if isinstance(exc, ApiError):
        return (exc.status_code or 0) >= 500
    if isinstance(exc, (urllib.error.URLError, socket.gaierror, socket.timeout, ConnectionError, TimeoutError)):
        return True
    return isinstance(exc, OSError) and _is_transient_transport_error(exc)


def has_parked_reply(message_id: str) -> bool:
    """A finished reply for this message is waiting in the outbox."""
    try:
        return bool(message_id) and _outbox_path(message_id).exists()
    except OSError:
        return False


def flush_outbox(state: Dict[str, Any], *, budget_seconds: float = 0.0) -> int:
    """Retry parked replies whose backoff expired. Returns how many landed."""
    if not OUTBOX_DIR.is_dir():
        return 0
    started = time.time()
    delivered = 0
    for path in sorted(OUTBOX_DIR.glob("*.json")):
        if budget_seconds and time.time() - started > budget_seconds:
            break
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log(f"unreadable outbox entry {path.name}: {exc}")
            continue
        if float(entry.get("next_at") or 0) > time.time():
            continue
        try:
            deliver_reply(entry, state, attempts=1)
            delivered += 1
        except Exception as exc:  # noqa: BLE001 - keep the text, grow the backoff
            attempts = int(entry.get("attempts") or 0) + 1
            entry["attempts"] = attempts
            # Only a real refusal from the API (any 4xx, 429 included) counts
            # toward giving up. The network being down or a 5xx says nothing
            # about the reply: it keeps retrying at the capped backoff until
            # the link returns, so a long outage can delay a reply but never
            # lose it.
            if not outbox_failure_is_soft(exc):
                entry["hard_attempts"] = int(entry.get("hard_attempts") or 0) + 1
            entry["last_error"] = describe_processing_error(exc)
            entry["next_at"] = time.time() + min(
                OUTBOX_RETRY_MAX_SECONDS, OUTBOX_RETRY_BASE_SECONDS * (2 ** min(attempts - 1, 6))
            )
            try:
                path.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
            except OSError:
                pass
            if int(entry.get("hard_attempts") or 0) >= OUTBOX_MAX_ATTEMPTS:
                _finish_deferred_run(entry, None, delivered=False)
                failed = path.with_suffix(".failed")
                try:
                    os.replace(path, failed)
                except OSError:
                    failed = path
                log(
                    f"reply for {entry.get('message_id')} GIVEN UP: refused {entry.get('hard_attempts')} times "
                    f"({attempts} attempts in total); text preserved at {failed} for inspection, "
                    f"redeliver with --redeliver {entry.get('message_id')}: {entry['last_error']}"
                )
                # Operator exit, not a graveyard: claim the failure where the
                # humans look, and leave the file in a shape `--redeliver
                # <message_id>` can pick up. Silence plus a log line is how a
                # reply disappears for a day.
                ref = entry.get("message_ref") or {}
                try:
                    update_chat_status(ref, typing=False, execution_state="failed")
                except Exception as status_exc:  # noqa: BLE001 - best effort
                    log(
                        f"reply for {entry.get('message_id')} undeliverable and the "
                        f"'failed' status also failed ({status_exc}); recover with "
                        f"--redeliver {entry.get('message_id')}"
                    )
            else:
                log(
                    f"reply for {entry.get('message_id')} still undelivered "
                    f"(attempt {attempts}, next in {int(entry['next_at'] - time.time())}s): {entry['last_error']}"
                )
    return delivered


_pending_input_tokens = 0
_pending_output_tokens = 0

def turn_token_usage(
    input_chars: int, output_chars: int, since_ts: float | None = None, session_id: str | None = None
) -> tuple[int, int]:
    """Tokens one turn consumed: the real per-call counts Hermes logged to
    agent.log when available, else the ~4-chars-per-token estimate.

    The estimate only sees the prompt and reply text, not the session history,
    tool results and system prompt Hermes re-sends on every model call, so it
    under-reports by orders of magnitude (cents shown while the provider billed
    tens of dollars a week). It is a fallback, never the primary source."""
    usage = sum_api_usage(since_ts, session_id=session_id) if since_ts is not None else None
    if usage:
        return usage
    return estimate_run_tokens(input_chars), estimate_run_tokens(output_chars)


def report_token_usage(
    input_chars: int, output_chars: int, since_ts: float | None = None, session_id: str | None = None
) -> None:
    """Report a turn's token usage to EmperorClaw with model-aware cost tracking.
    Real Hermes counts when `since_ts` is given and agent.log has them (see
    turn_token_usage). Flush every turn; retain failed samples and block further
    dispatch until acknowledged."""
    global _pending_input_tokens, _pending_output_tokens
    turn_input, turn_output = turn_token_usage(input_chars, output_chars, since_ts, session_id)
    _pending_input_tokens += turn_input
    _pending_output_tokens += turn_output
    total_input = _pending_input_tokens
    total_output = _pending_output_tokens
    _pending_input_tokens = 0
    _pending_output_tokens = 0
    if total_input <= 0 and total_output <= 0:
        return
    try:
        # Report the worker's selected model; provider names are not pricing model IDs.
        model = os.environ.get("EMPEROR_CLAW_RUNTIME_MODEL") or _agent_llm_model or os.environ.get("EMPEROR_CLAW_LLM_MODEL") or None
        body: dict = {
            "agentId": AGENT_ID,
            "inputTokens": total_input,
            "outputTokens": total_output,
        }
        if model:
            body["model"] = model
        api("POST", "/agents/report-usage", body=body)
    except Exception:
        # Retain the sample; preflight retries before permitting another turn.
        _pending_input_tokens += total_input
        _pending_output_tokens += total_output
        raise


def check_budget() -> bool:
    try:
        report_token_usage(0, 0)
        payload = api("GET", f"/agents/{AGENT_ID}")
        agent = payload.get("agent", payload)
        if agent.get("executionAllowed") is not True or agent.get("budgetStatus") == "paused":
            log(f"dispatch blocked: {agent.get('budgetBlockReason') or 'budget check denied'}")
            return False
        return True
    except Exception as exc:
        log(f"budget check failed; dispatch blocked: {exc}")
        return False


# ── Run ledger (PR 3) ─────────────────────────────────────────────────────────
# Each dispatched turn is one `agent_runs` row: POST start before the runtime
# call, PATCH finish after it. Reporting is strictly best-effort — a slow or
# failing ledger never delays, blocks or fails the turn — and gated on the
# server advertising `runs: 1`, so an upgraded bridge talking to an older server
# makes zero extra requests.
LEDGER_TIMEOUT_SECONDS = 5
# After this many consecutive ledger failures, skip every ledger call for the
# cooldown window, then try once more. A 4xx counts toward the breaker too, but
# a 4xx finish is never retried (a rejected payload will be rejected again).
LEDGER_BREAKER_THRESHOLD = 3
LEDGER_BREAKER_COOLDOWN_SECONDS = 5 * 60
_ledger_failure_logged = False
# A finish that failed once; retried a single time on the next loop iteration.
_pending_run_finish: Dict[str, Any] | None = None


class LedgerBreaker:
    """Trips after N consecutive ledger failures, then skips all ledger calls
    for a cooldown window.

    Pure timing logic with an injectable clock, so tests can advance time
    without sleeping. While open it reports skip; when the window elapses it
    closes once, logging exactly once on each transition.
    """

    def __init__(
        self,
        threshold: int = LEDGER_BREAKER_THRESHOLD,
        cooldown: float = LEDGER_BREAKER_COOLDOWN_SECONDS,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._threshold = threshold
        self._cooldown = cooldown
        self._now = now
        self._failures = 0
        self._open_until = 0.0

    @property
    def open(self) -> bool:
        return self._open_until > 0

    def should_skip(self) -> bool:
        """True while the breaker is open, so every ledger call is skipped."""
        if self._open_until <= 0:
            return False
        if self._now() >= self._open_until:
            self._open_until = 0.0
            self._failures = 0
            log("run ledger circuit breaker closed; resuming ledger reporting")
            return False
        return True

    def record_success(self) -> None:
        self._failures = 0

    def record_failure(self) -> None:
        self._failures += 1
        if self._open_until <= 0 and self._failures >= self._threshold:
            self._open_until = self._now() + self._cooldown
            log(
                f"run ledger circuit breaker open after {self._failures} consecutive failures; "
                f"skipping ledger calls for {int(self._cooldown)}s"
            )


# Process-wide breaker shared by every ledger call site.
_ledger_breaker = LedgerBreaker()


def _is_retryable_ledger_error(exc: BaseException) -> bool:
    """A 4xx (validation/auth) is permanent and never retried; anything else is."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and 400 <= status < 500:
        return False
    return True


def _log_ledger_failure(where: str, exc: BaseException) -> None:
    """Log the first ledger failure only, so a down ledger cannot spam the log."""
    global _ledger_failure_logged
    if _ledger_failure_logged:
        return
    _ledger_failure_logged = True
    log(f"run ledger {where} failed (best-effort, continuing): {exc}")


def _mark_ledger_ok() -> None:
    global _ledger_failure_logged
    _ledger_failure_logged = False


def build_run_start_payload(run_id: str, message: Dict[str, Any], started_at: float) -> Dict[str, Any]:
    """The POST /agents/runs body for one turn. Pure; no I/O."""
    payload: Dict[str, Any] = {
        "id": run_id,
        "agentId": AGENT_ID,
        "runtimeId": RUNTIME_ID,
        "runtimeKind": "hermes",
        "bridgeVersion": BRIDGE_VERSION,
        "triggerKind": "message",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at)),
    }
    message_id = str(message.get("id") or "")
    thread_id = str(message.get("threadId") or message.get("thread_id") or "")
    task_id = str(message.get("taskId") or message.get("task_id") or "")
    if message_id:
        payload["triggerMessageId"] = message_id
    if thread_id:
        payload["threadId"] = thread_id
    if task_id:
        payload["taskId"] = task_id
    return payload


def estimate_run_tokens(char_count: int) -> int:
    """The ~4-chars-per-token estimate report-usage uses (0 for empty input)."""
    return max(1, char_count // 4) if char_count > 0 else 0


def map_run_status(exc: BaseException | None) -> str:
    """Map a turn outcome to a ledger finish status.

    None is a clean turn; the idle/wall-clock timeouts and an operator stop
    have their own terminal status; anything else is a failure.
    """
    if exc is None:
        return "succeeded"
    if isinstance(exc, (HermesIdleTimeout, subprocess.TimeoutExpired)):
        return "timeout"
    if isinstance(exc, TurnInterrupted):
        return "cancelled"
    return "failed"


def ledger_error_message(exc: BaseException) -> str | None:
    """A short, secret-safe ledger error (no stack, no prompt text).

    A timeout/cancel is a status, not a stack-bearing failure, so it carries no
    error text.
    """
    if isinstance(exc, (HermesIdleTimeout, subprocess.TimeoutExpired, TurnInterrupted)):
        return None
    # Only a classification: exception text can carry the agent's reply or
    # tool output (seen in production), which must never reach the ledger.
    if isinstance(exc, subprocess.CalledProcessError):
        return f"Hermes exited with status {exc.returncode}"
    if provider_failure_reason(exc):
        return "provider_credits_exhausted: HTTP 402"
    return type(exc).__name__[:120] or None


def build_run_finish_payload(
    status: str,
    started_at: float | None = None,
    *,
    ended_at: float | None = None,
    reply_message_id: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    tool_calls: int | None = None,
    error: str | None = None,
) -> Dict[str, Any]:
    """The PATCH /agents/runs/{id} body. Pure; no I/O. Unset fields are omitted."""
    now = time.time() if ended_at is None else ended_at
    payload: Dict[str, Any] = {
        "status": status,
        "endedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
    }
    if started_at is not None:
        payload["durationMs"] = max(0, int((now - started_at) * 1000))
    for key, value in (
        ("inputTokens", input_tokens),
        ("outputTokens", output_tokens),
        ("toolCalls", tool_calls),
        ("replyMessageId", reply_message_id),
        ("error", error),
    ):
        if value is not None:
            payload[key] = value
    return payload


def count_tool_calls(since_ts: float, tail_bytes: int = 1_000_000) -> int | None:
    """Count tool executions recorded in agent.log since the turn started.

    Reuses the same log line the live status already parses. Best-effort and
    bounded (tail read only): returns None — so the caller omits `toolCalls` —
    when the log is unavailable.
    """
    log_path = _agent_log_path()
    if not log_path:
        return None
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
            raw = fh.read()
    except OSError:
        return None
    count = 0
    for line in raw.decode("utf-8", errors="replace").splitlines():
        match = _TOOL_LOG_RE.match(line)
        if not match:
            continue
        try:
            ts = time.mktime(time.strptime(match.group(1), _TOOL_LOG_TS_FORMAT))
        except ValueError:
            continue
        if ts > since_ts:
            count += 1
    return count


_API_USAGE_LOG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+\s+INFO\s+"
    r"(?:\[([^\]]+)\]\s+)?agent\.conversation_loop:\s+API call #\d+:.*?\bin=(\d+)\s+out=(\d+)"
)


def sum_api_usage(
    since_ts: float, tail_bytes: int = 2_000_000, *, session_id: str | None = None
) -> tuple[int, int] | None:
    """Real input/output tokens Hermes logged for this turn's model calls (one
    `API call #N ... in=X out=Y` line per call). Bounded tail read.

    agent.log is shared by every Hermes process on the profile (a CLI turn, a
    goal step), so only lines tagged with this turn's session id
    (`[20261022_013222_b2a64e]`) count. Without a session id nothing can be
    attributed and this returns None, like an unavailable log, so the caller
    falls back to the character estimate rather than over-billing."""
    if not session_id:
        return None
    log_path = _agent_log_path()
    if not log_path:
        return None
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
            raw = fh.read()
    except OSError:
        return None
    total_in = total_out = calls = 0
    for line in raw.decode("utf-8", errors="replace").splitlines():
        match = _API_USAGE_LOG_RE.match(line)
        if not match or match.group(2) != session_id:
            continue
        try:
            ts = time.mktime(time.strptime(match.group(1), _TOOL_LOG_TS_FORMAT))
        except ValueError:
            continue
        if ts > since_ts:
            total_in += int(match.group(3))
            total_out += int(match.group(4))
            calls += 1
    return (total_in, total_out) if calls else None


_API_CALL_LOG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+\s+INFO\s+"
    r"(?:\[[^\]]+\]\s+)?agent\.conversation_loop:\s+API call #(\d+)"
)


def model_call_stats(since_ts: float, tail_bytes: int = 2_000_000) -> tuple[float | None, int]:
    """(timestamp of the first model call, number of model calls) since a turn's
    Hermes process was spawned, read from agent.log. Never raises.

    agent.log stamps whole seconds, so the comparison floors ``since_ts``: the
    first call of a turn can land in the same second the process started.
    """
    log_path = _agent_log_path()
    if not log_path:
        return None, 0
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
            raw = fh.read()
    except OSError:
        return None, 0
    floor = float(int(since_ts))
    first: float | None = None
    calls = 0
    for line in raw.decode("utf-8", errors="replace").splitlines():
        match = _API_CALL_LOG_RE.match(line)
        if not match:
            continue
        try:
            ts = time.mktime(time.strptime(match.group(1), _TOOL_LOG_TS_FORMAT))
        except ValueError:
            continue
        if ts >= floor:
            calls += 1
            if first is None or ts < first:
                first = ts
    return first, calls


def parse_iso_timestamp(value: Any) -> float | None:
    """Epoch seconds for an ISO-8601 timestamp from the API, or None."""
    if not value:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def format_turn_timing(
    message_id: str,
    *,
    created_at: float | None,
    dispatched_at: float,
    spawned_at: float | None,
    first_call_at: float | None,
    finished_at: float,
    calls: int | None,
) -> str:
    """One measurable line per turn. Pure; no I/O.

    pickup           message created -> bridge dispatched it (queueing/poll delay)
    predispatch      dispatched -> Hermes process spawned (API calls, context)
    first_model_call Hermes spawned -> its first model call (cold start)
    total            dispatched -> reply handed to the control plane
    A field whose inputs are unknown is omitted rather than guessed.
    """
    parts = [f"turn {message_id} timing:"]
    if created_at is not None:
        parts.append(f"pickup={max(0.0, dispatched_at - created_at):.1f}s")
    if spawned_at is not None:
        parts.append(f"predispatch={max(0.0, spawned_at - dispatched_at):.1f}s")
        if first_call_at is not None:
            parts.append(f"first_model_call={max(0.0, first_call_at - spawned_at):.1f}s")
    parts.append(f"total={max(0.0, finished_at - dispatched_at):.1f}s")
    if calls is not None:
        parts.append(f"calls={calls}")
    return " ".join(parts)


def log_turn_timing(message: Dict[str, Any], dispatched_at: float) -> None:
    """Log the timing line for the turn that just ended. Never raises."""
    try:
        spawned_at = _turn_timing.get("spawnedAt")
        first_call_at, calls = model_call_stats(spawned_at) if spawned_at else (None, 0)
        log(format_turn_timing(
            str(message.get("id") or "?"),
            created_at=parse_iso_timestamp(message.get("createdAt") or message.get("created_at")),
            dispatched_at=dispatched_at,
            spawned_at=spawned_at,
            first_call_at=first_call_at,
            finished_at=time.time(),
            calls=calls if spawned_at else None,
        ))
    except Exception as exc:  # noqa: BLE001 - telemetry only
        log(f"turn timing unavailable: {exc}")


def post_run_start(payload: Dict[str, Any]) -> bool:
    """POST the run start. Never raises; False on any failure (never retried)."""
    if _ledger_breaker.should_skip():
        return False
    try:
        api("POST", "/agents/runs", body=payload, timeout=LEDGER_TIMEOUT_SECONDS)
        _mark_ledger_ok()
        _ledger_breaker.record_success()
        return True
    except Exception as exc:
        _log_ledger_failure("start", exc)
        _ledger_breaker.record_failure()
        return False


def post_run_finish(run_id: str, payload: Dict[str, Any]) -> None:
    """PATCH the run finish. Never raises; a transient failure queues one retry."""
    global _pending_run_finish
    if _ledger_breaker.should_skip():
        return
    try:
        api("PATCH", f"/agents/runs/{run_id}", body=payload, timeout=LEDGER_TIMEOUT_SECONDS)
        _mark_ledger_ok()
        _ledger_breaker.record_success()
        if _pending_run_finish and _pending_run_finish.get("id") == run_id:
            _pending_run_finish = None
    except Exception as exc:
        _log_ledger_failure("finish", exc)
        _ledger_breaker.record_failure()
        # The id is idempotent server-side, so replaying it is safe. A 4xx is
        # permanent, so it is never queued for retry.
        if _is_retryable_ledger_error(exc):
            _pending_run_finish = {"id": run_id, "payload": payload}


def retry_pending_run_finish() -> None:
    """Flush a finish that failed last iteration — exactly one retry."""
    global _pending_run_finish
    pending = _pending_run_finish
    if not pending:
        return
    _pending_run_finish = None
    if _ledger_breaker.should_skip():
        return
    try:
        api("PATCH", f"/agents/runs/{pending['id']}", body=pending["payload"], timeout=LEDGER_TIMEOUT_SECONDS)
        _mark_ledger_ok()
        _ledger_breaker.record_success()
    except Exception as exc:
        _log_ledger_failure("finish retry", exc)
        _ledger_breaker.record_failure()


def safe_finish_run(
    run_id: str,
    status: str,
    started_at: float | None = None,
    *,
    reply_message_id: str | None = None,
    input_chars: int | None = None,
    output_chars: int | None = None,
    count_tools_since: float | None = None,
    exc: BaseException | None = None,
    session_id: str | None = None,
) -> None:
    """Build and post a turn's run finish. NEVER raises.

    The whole per-turn ledger path lives here — the token estimates, the
    tool-call count, the error text, the payload build and the PATCH — so a bug
    anywhere in it cannot escape into the turn's handler. If it did, the handler
    would treat a ledger fault as a runtime failure and requeue the message,
    re-sending the reply on the next poll.
    """
    try:
        post_run_finish(run_id, compose_run_finish(
            status,
            started_at,
            reply_message_id=reply_message_id,
            input_chars=input_chars,
            output_chars=output_chars,
            count_tools_since=count_tools_since,
            exc=exc,
            session_id=session_id,
        ))
    except Exception as ledger_exc:
        _log_ledger_failure("finish", ledger_exc)


def compose_run_finish(
    status: str,
    started_at: float | None = None,
    *,
    reply_message_id: str | None = None,
    input_chars: int | None = None,
    output_chars: int | None = None,
    count_tools_since: float | None = None,
    exc: BaseException | None = None,
    session_id: str | None = None,
) -> Dict[str, Any]:
    """The finish payload with this turn's real usage and tool count. May raise;
    callers own the never-raise guarantee (see safe_finish_run)."""
    usage = sum_api_usage(count_tools_since, session_id=session_id) if count_tools_since is not None else None
    if usage:
        input_tokens, output_tokens = usage
    else:
        input_tokens = (estimate_run_tokens(input_chars) or None) if input_chars is not None else None
        output_tokens = (estimate_run_tokens(output_chars) or None) if output_chars is not None else None
    tool_calls = count_tool_calls(count_tools_since) if count_tools_since is not None else None
    error = ledger_error_message(exc) if exc is not None else None
    return build_run_finish_payload(
        status,
        started_at,
        reply_message_id=reply_message_id,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        tool_calls=tool_calls,
        error=error,
    )


# Generation of the turn whose dispatch status may still be sent. Bumped by
# end_dispatch_status() once the turn is over, so a status task that only gets
# to run after join_dispatch gave up on it is dropped instead of overwriting
# the turn's final "resolved"/"queued".
_dispatch_generation = 0
_dispatch_generation_lock = threading.Lock()


def _next_dispatch_generation() -> int:
    global _dispatch_generation
    with _dispatch_generation_lock:
        _dispatch_generation += 1
        return _dispatch_generation


def dispatch_status_current(generation: int) -> bool:
    with _dispatch_generation_lock:
        return _dispatch_generation == generation


def end_dispatch_status() -> None:
    """Retire the current turn's dispatch status: later sends are dropped."""
    _next_dispatch_generation()


def resend_final_status_after(futures: List[Any], message: Dict[str, Any], final_status: Dict[str, Any] | None) -> None:
    """Re-send a turn's final status once its late dispatch-status tasks land.

    A task already inside its HTTP call when the turn ended cannot be recalled;
    if it lands after the final status it overwrites it. Re-asserting the final
    status after it completes restores the right state. Never raises.
    """
    if not final_status:
        return

    def resend(_future: Any) -> None:
        try:
            update_chat_status(message, **final_status)
        except Exception as exc:  # noqa: BLE001 - best effort, cosmetic
            log(f"final status for {message.get('id')} not re-sent after a late dispatch status: {exc}")

    for future in futures:
        try:
            future.add_done_callback(resend)
        except Exception as exc:  # noqa: BLE001
            log(f"late dispatch status for {message.get('id')} not tracked: {exc}")


def announce_dispatch(message: Dict[str, Any], *, run_id: str, started_at: float, ledger_enabled: bool) -> List[Any]:
    """Start the dispatch bookkeeping in the background and return its futures.

    Read receipt + typing indicator, the busy heartbeat and the run-ledger
    start are cosmetic or best-effort, and none of them gates the turn. They
    used to cost four sequential round trips before Hermes could start; now
    they overlap with context building. Each task swallows its own failure: a
    flaky network must not stop a turn that can still run.
    """

    generation = _next_dispatch_generation()

    def status() -> None:
        try:
            # Each send re-checks the turn is still current (see
            # end_dispatch_status): "acting" must never land after "resolved".
            if not dispatch_status_current(generation):
                return
            update_chat_status(message, mark_read=True, execution_state="seen")
            if not dispatch_status_current(generation):
                return
            update_chat_status(message, typing=True, execution_state="acting")
        except Exception as exc:  # noqa: BLE001 - cosmetic
            log(f"dispatch status for {message.get('id')} not sent: {exc}")

    def heartbeat() -> None:
        try:
            send_heartbeat(1)
        except Exception as exc:  # noqa: BLE001 - the next heartbeat corrects it
            log(f"busy heartbeat not sent: {exc}")

    tasks = [status, heartbeat]
    if ledger_enabled:
        tasks.append(lambda: post_run_start(build_run_start_payload(run_id, message, started_at)))
    return [submit_background(task) for task in tasks]


def join_dispatch(futures: List[Any], timeout: float = 60.0) -> List[Any]:
    """Wait for announce_dispatch's tasks; they never raise, so this cannot.

    Returns the tasks still running after ``timeout`` (normally none). The
    caller re-sends the turn's final status once they land, see
    resend_final_status_after.
    """
    deadline = time.time() + timeout
    pending: List[Any] = []
    for future in futures:
        try:
            future.result(timeout=max(0.0, deadline - time.time()))
        except Exception as exc:  # noqa: BLE001 - including a timeout
            log(f"dispatch bookkeeping still pending: {exc!r}")
            if not future.done():
                pending.append(future)
    return pending


ENVIRONMENT_WAIT_REASON = "the runtime environment stayed unavailable"


def post_give_up_notice(message: Dict[str, Any], attempts: int, reason: str | None) -> None:
    """Tell the human, in the thread, that this request was given up on.

    Only for human-originated messages: a cancelled status alone renders as
    silence in a chat, which is what a human reads as "the agent is dead". The
    text is fixed (plus the classified, secret-safe reason when there is one),
    never exception text. A single attempt without transport retries: this is
    a courtesy on a path that already failed, and must not stall the loop.
    """
    sender_type = str(message.get("senderType") or message.get("sender_type") or "").lower()
    if sender_type != "human":
        return
    detail = f" ({reason})" if reason else ""
    text = (
        f"I couldn't complete this request after {attempts} attempts{detail}. "
        "Send it again if you still need it."
    )
    try:
        send_reply(message, text, transport_retry=False)
    except Exception as exc:  # noqa: BLE001 - the cancelled status still shows
        log(f"give-up notice for {message.get('id')} not posted: {exc}")


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)
    ensure_runtime_boot()
    agent_id = ensure_agent()
    send_heartbeat(0)
    state = load_state()
    # Cold-start: if no lastSeenAt (fresh state or state was cleared),
    # look back 2 minutes so we don't miss messages sent right before
    # the bridge started (e.g. user sets up bridge, then sends a test message).
    # This prevents the "I messaged and nothing happened" first-run experience.
    if not state.get("lastSeenAt"):
        lookback = time.time() - 120  # 2 minutes ago
        state["lastSeenAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(lookback))
        state["seen"] = []
        save_state(state)
    log(f"started runtime={RUNTIME_ID} agent={AGENT_NAME} agentId={agent_id}")
    # A restart leaves the previous in-flight turn behind (own session group).
    # Sweep it before polling: a survivor would write this profile's state.db
    # alongside the turn that takes over the message.
    reap_orphan_turns()
    last_heartbeat = time.time()
    last_capability_refresh = time.time()
    while True:
        try:
            if time.time() - last_heartbeat >= 60:
                # A failing heartbeat must not abort the iteration: before this
                # guard a network stall skipped the message sync below, so the
                # agent processed nothing until the link came back.
                try:
                    send_heartbeat(0)
                    last_heartbeat = time.time()
                except Exception as heartbeat_exc:
                    log(f"heartbeat failed; retrying next iteration: {heartbeat_exc}")
            if CAPABILITY_REFRESH_SECONDS > 0 and time.time() - last_capability_refresh >= CAPABILITY_REFRESH_SECONDS:
                try:
                    refresh_server_capabilities()
                    last_capability_refresh = time.time()
                except Exception as capability_exc:
                    log(f"capability refresh failed; retrying next iteration: {capability_exc}")
            # One retry for a run finish that failed transiently last iteration.
            retry_pending_run_finish()
            import emperor_goals
            try:
                apply_runtime_controls(fetch_runtime_control(), state)
            except Exception as control_exc:
                log(f"runtime control fetch failed; keeping current controls: {control_exc}")
            emperor_goals.process_commands(sys.modules[__name__], state)
            # Parked replies go first: a message whose answer is waiting here
            # must be delivered, never re-run (see has_parked_reply below).
            try:
                flush_outbox(state, budget_seconds=60)
            except Exception as outbox_exc:
                log(f"outbox flush failed: {outbox_exc}")
            try:
                pending_messages = sync_messages(state)
            except Exception as sync_exc:
                log(f"message sync failed; retrying next iteration: {sync_exc}")
                pending_messages = []
            for message in pending_messages:
                message_id = str(message.get("id") or "")
                if not message_id:
                    continue
                delivery_state = str(message.get("deliveryState") or message.get("delivery_state") or "").lower()
                # Retry IDs are sent explicitly to the sync endpoint. A legacy
                # state file can retain an ID after its reply was stored; never
                # let a resolved/cancelled message consume another Hermes turn.
                if is_processed_delivery_state(message):
                    clear_retry(state, message_id)
                    remember_seen(state, message_id)
                    continue
                # The turn already ran and its reply is parked in the outbox:
                # the server still shows the message queued/seen/acting only
                # because the POST has not landed. Re-running it would pay for
                # a second full turn and post a second answer; flush_outbox
                # owns its delivery.
                if has_parked_reply(message_id):
                    remember_seen(state, message_id)
                    continue
                # A direct prompt can be present in the local seen ledger while
                # still active on the server after a crash, a service stop, or a
                # human Retry. `seen` is a real execution state, not a terminal
                # acknowledgement. Recover every targeted direct prompt whose
                # server state is queued/seen/acting; resolved/cancelled rows
                # were handled above and historical team reads remain skipped.
                if message_id in (state.get("seen") or []):
                    is_our_unfinished_direct = is_recoverable_direct_message(message, delivery_state)
                    if not is_our_unfinished_direct:
                        continue
                    state["seen"] = [item for item in state.get("seen", []) if item != message_id]
                    log(f"recovering orphaned message {message_id}")
                    try:
                        update_chat_status(message, typing=False, execution_state="queued")
                    except Exception as exc:
                        log(f"failed to requeue orphaned message {message_id}: {exc}")
                if not retry_due(state, message_id):
                    continue
                # Record DM thread ownership before any routing decision.
                # When a message carries targetAgentId we learn which agent owns that thread,
                # so future agent replies in that thread (which have no targetAgentId) are
                # not mistakenly claimed by @mention detection in other agents' bridges.
                m_target = str(message.get("targetAgentId") or message.get("target_agent_id") or "")
                m_thread = str(message.get("threadId") or message.get("thread_id") or "")
                m_kind = str(message.get("threadType") or message.get("thread_type") or "")
                # Only learn DM ownership for a genuine direct thread. A shared
                # thread (team/group/pair) carries targetAgentId too, but must
                # never be remembered as a DM.
                if m_target and m_thread and m_kind not in SHARED_THREAD_TYPES:
                    state.setdefault("direct_threads", {})[m_thread] = m_target
                ts = message.get("createdAt")
                # ── Cold-start guard: skip the agent-authored BACKLOG of shared
                #    threads (team, groups) — messages posted before this bridge
                #    started — so a restart can't replay a burst of sibling
                #    @mentions into a reply storm. Live agent messages are never
                #    held back: the loop guard covers runaway exchanges, and a
                #    group created by an agent (with no human message yet) must
                #    still work.
                sender_type = str(message.get("senderType") or "").lower()
                thread_type = str(message.get("threadType") or message.get("thread_type") or "")
                thread_id = str(message.get("threadId") or message.get("thread_id") or "")
                if thread_type in SHARED_THREAD_TYPES and thread_id and sender_type == "agent" and is_backlog(ts):
                    remember_seen(state, message_id)
                    if ts:
                        state["lastSeenAt"] = ts
                    save_state(state)
                    continue
                if not is_for_agent(message, agent_id, state):
                    remember_seen(state, message_id)
                    if ts:
                        state["lastSeenAt"] = ts
                    continue
                # Budget and the stop/replace check are independent reads, so
                # they run together. Budget semantics are unchanged: a failed or
                # denied check blocks dispatch for this message and the rest of
                # the batch.
                try:
                    gate = run_parallel({
                        "budget": check_budget,
                        "control": lambda: fetch_runtime_control(message),
                    })
                except Exception as gate_exc:
                    # The control plane is unreachable: nothing was dispatched,
                    # so nothing is spent. Retry the batch next iteration.
                    log(f"pre-dispatch control check failed for {message_id}; retrying next iteration: {gate_exc}")
                    break
                if not gate["budget"]:
                    # Preserve this message and everything after it for retry.
                    break
                # The server's verdict already includes its loop guard (and posts
                # one visible notice); the local guard is only for older servers.
                if not server_routed(message) and not check_loop_guard(message, state):
                    thread_id = str(message.get("threadId") or message.get("thread_id") or "")
                    entry = state.get("loop_guard", {}).get(thread_id, {})
                    if not entry.get("notified"):
                        entry["notified"] = True
                        log(f"loop guard tripped in thread {thread_id}, pausing until a human message arrives")
                        try:
                            send_reply(message, (
                                f"{AGENT_NAME}: pausing replies in this thread — too many consecutive "
                                "agent turns without a human message. Send a new instruction to resume."
                            ))
                        except Exception as exc:
                            log(f"loop guard notice failed: {exc}")
                    remember_seen(state, message_id)
                    if ts:
                        state["lastSeenAt"] = ts
                    continue
                # Recheck cached batches: a /kill or /replace can arrive while
                # an earlier message in this same batch is running.
                control = gate["control"]
                apply_runtime_controls(control, state)
                if control.get("cancelled") or message.get("deliveryState") == "cancelled":
                    remember_seen(state, message_id)
                    continue
                log(f"dispatching message {message_id}")
                text = str(message.get("text") or "")
                # Open the run before dispatch, but only on a server that
                # advertises the ledger; older servers get zero extra requests.
                ledger_enabled = server_supports_runs()
                run_id = str(uuid.uuid4())
                turn_started = time.time()
                dispatch_tasks = announce_dispatch(
                    message, run_id=run_id, started_at=turn_started, ledger_enabled=ledger_enabled
                )
                late_status: List[Any] = []
                # The status this turn ends on, re-sent if a late dispatch
                # status could have overwritten it (see resend_final_status_after).
                final_status: Dict[str, Any] | None = None
                try:
                    try:
                        reply = run_hermes(message, state)
                    finally:
                        # The run start must land before its finish, and the
                        # "acting" status before "resolved".
                        late_status = join_dispatch(dispatch_tasks)
                        end_dispatch_status()
                    try:
                        report_token_usage(len(text), len(reply), since_ts=turn_started, session_id=_turn_session_id)
                    except Exception as exc:
                        log(f"usage report pending; future dispatch blocked: {exc}")
                    try:
                        reply_entry = outbox_put(message, reply)
                    except OSError as outbox_exc:
                        # A full or read-only disk must not cost a finished
                        # reply: deliver from memory, just without the safety net.
                        log(f"outbox unavailable ({outbox_exc}); delivering {message_id} without a disk copy")
                        reply_entry = outbox_entry(message, reply)
                    try:
                        reply_message_id = deliver_reply(reply_entry, state)
                    except Exception as reply_exc:
                        # The turn is finished and its text is on disk. Letting
                        # this reach the handler below would requeue the
                        # *prompt*: the operator gets silence, the bridge pays
                        # for a second full turn, and the answer that arrives is
                        # a different one. Park the reply, ack locally so the
                        # message is not re-run, and let flush_outbox retry the
                        # POST on its own until it lands.
                        log(
                            f"reply for {message_id} parked after POST failure "
                            f"({describe_processing_error(reply_exc)}); retrying the POST only "
                            f"until it lands (text at {_outbox_path(reply_entry['key'])})"
                        )
                        # Local dedupe only: the prompt must not run again.
                        # Nothing is claimed to the server here -- status stays
                        # un-resolved until the POST returns 2xx.
                        remember_seen(state, message_id)
                        final_status = {"typing": False}
                        try:
                            update_chat_status(message, typing=False)
                        except Exception as status_exc:
                            log(f"failed to stop typing indicator for {message_id}: {status_exc}")
                        if ledger_enabled:
                            # Capture this turn's usage now (agent.log moves on)
                            # but post the finish when the reply lands, so the
                            # ledger row carries the stored reply id.
                            try:
                                reply_entry["ledger_finish"] = {
                                    "run_id": run_id,
                                    "payload": compose_run_finish(
                                        "succeeded",
                                        turn_started,
                                        input_chars=len(text),
                                        output_chars=len(reply),
                                        count_tools_since=turn_started,
                                        session_id=_turn_session_id,
                                    ),
                                }
                                _outbox_save(reply_entry)
                            except Exception as ledger_exc:
                                _log_ledger_failure("finish", ledger_exc)
                                safe_finish_run(run_id, "succeeded", turn_started)
                        log_turn_timing(message, turn_started)
                        clear_retry(state, message_id)
                        save_state(state)
                        resend_final_status_after(late_status, message, final_status)
                        continue
                    final_status = {"typing": False, "execution_state": "resolved"}
                    log_turn_timing(message, turn_started)
                    try:
                        emperor_goals.record_external_turn(sys.modules[__name__], message, reply, state)
                    except Exception as goal_exc:
                        # The reply is delivered; an objective bookkeeping fault
                        # must not requeue a prompt that was already answered.
                        log(f"objective bookkeeping failed after {message_id}: {goal_exc}")
                    # Reasoning history is a bonus artifact, so it is isolated
                    # the same way the recovery calls below are: if this write
                    # throws it must NOT escape into the except block, which
                    # would post an error notice for a turn that actually
                    # succeeded and re-send the reply on the next poll. A
                    # transcript is never worth losing a reply over.
                    if reply_message_id and _last_turn_reasoning:
                        try:
                            post_reasoning_history(reply_message_id, _last_turn_reasoning)
                        except Exception as reasoning_exc:
                            log(f"reasoning history not stored for {reply_message_id}: {reasoning_exc}")
                    # deliver_reply already marked the message resolved, right
                    # after the 2xx: the ledger report never delays it.
                    if ledger_enabled:
                        safe_finish_run(
                            run_id,
                            "succeeded",
                            turn_started,
                            reply_message_id=reply_message_id,
                            input_chars=len(text),
                            output_chars=len(reply),
                            count_tools_since=turn_started,
                            session_id=_turn_session_id,
                        )
                    clear_retry(state, message_id)
                except TurnInterrupted:
                    final_status = {"typing": False}
                    log(f"operator stopped message {message_id}")
                    try:
                        update_chat_status(message, typing=False)
                    except Exception as status_exc:
                        log(f"failed to clear stopped turn status: {status_exc}")
                    if ledger_enabled:
                        safe_finish_run(run_id, "cancelled", turn_started)
                    clear_retry(state, message_id)
                    remember_seen(state, message_id)
                except Exception as exc:
                    # A failed turn can still have paid for model calls (a
                    # timeout mid-loop, a crash after several calls). Bill only
                    # what Hermes actually logged for this turn's session; never
                    # estimate here. No Hermes process (e.g. SessionBusy before
                    # spawn) means nothing was spent, so nothing is read.
                    spawned = bool(_turn_timing.get("spawnedAt"))
                    if spawned:
                        try:
                            report_token_usage(0, 0, since_ts=turn_started, session_id=_turn_session_id)
                        except Exception as usage_exc:
                            log(f"usage report pending; future dispatch blocked: {usage_exc}")
                    failure_reason = provider_failure_reason(exc)
                    # Preserve the prompt for retry. The durable ledger gives a
                    # failed runtime backoff without turning one transient error
                    # into a hot loop, and the server keeps retry IDs visible even
                    # after the normal incremental sync cursor has advanced.
                    final_status = {"typing": False, "execution_state": "queued"}
                    try:
                        update_chat_status(message, typing=False, execution_state="queued")
                    except Exception as status_exc:
                        log(f"failed to requeue message {message_id}: {status_exc}")
                    # Session contention, the API being unreachable, DNS, a 5xx:
                    # the environment failed, not the prompt. Waiting costs a
                    # delay; cancelling costs the answer, which is how 28% of
                    # human DMs died on a flaky network. Environment failures
                    # therefore wait on the long curve and never spend the
                    # attempt budget; only genuine Hermes/model failures do.
                    environment = is_environment_failure(exc)
                    attempts = schedule_retry(state, message_id, busy=environment, first_attempt_at=turn_started)
                    # ...but not forever: a failure that only looks
                    # environmental would otherwise re-run a paid turn for good.
                    waited_out = environment and environment_wait_exhausted(state, message_id)
                    if waited_out:
                        retry = retry_entries(state).get(message_id) or {}
                        attempts = int(retry.get("attempts") or 0) + int(retry.get("busyMisses") or 0)
                        failure_reason = failure_reason or ENVIRONMENT_WAIT_REASON
                    if environment and not waited_out:
                        log(
                            f"message {message_id} waiting for the environment "
                            f"(wait {attempts}, backoff up to {SESSION_BUSY_MAX_SECONDS}s): "
                            f"{describe_processing_error(exc)}"
                        )
                    elif waited_out or attempts >= MAX_RETRY_ATTEMPTS:
                        # Do not let one poison prompt monopolize this serial
                        # queue forever. Say so in the thread first, then mark it
                        # cancelled; the human can explicitly retry.
                        post_give_up_notice(message, attempts, failure_reason)
                        final_status = {"typing": False, "execution_state": "cancelled", "reason": failure_reason}
                        try:
                            update_chat_status(message, typing=False, execution_state="cancelled", reason=failure_reason)
                        except Exception as status_exc:
                            log(f"failed to expose exhausted message {message_id}: {status_exc}")
                        clear_retry(state, message_id)
                        remember_seen(state, message_id)
                        log(f"message {message_id} cancelled visibly after {attempts} failed attempts: {describe_processing_error(exc)}")
                    else:
                        log(f"error processing message {message_id}; retry {attempts} scheduled: {describe_processing_error(exc)}")
                    if ledger_enabled:
                        safe_finish_run(
                            run_id,
                            map_run_status(exc),
                            turn_started,
                            count_tools_since=turn_started if spawned else None,
                            exc=exc,
                            session_id=_turn_session_id,
                        )
                finally:
                    try:
                        send_heartbeat(0)
                    except Exception as heartbeat_exc:
                        log(f"failed to send heartbeat after {message_id}: {heartbeat_exc}")
                resend_final_status_after(late_status, message, final_status)
                if message_id not in retry_entries(state):
                    remember_seen(state, message_id)
                if ts and message_id not in retry_entries(state):
                    state["lastSeenAt"] = ts
                save_state(state)  # Persist immediately after each dispatch
            emperor_goals.process_commands(sys.modules[__name__], state)
            emperor_goals.run_next(sys.modules[__name__], state)
            # Finish any reply whose POST failed: the text is already on disk,
            # so this only retries transport, never a turn.
            try:
                flush_outbox(state, budget_seconds=60)
            except Exception as outbox_exc:
                log(f"outbox flush failed: {outbox_exc}")
            save_state(state)
        except Exception as exc:
            log(f"error: {exc}")
        time.sleep(POLL_SECONDS)


def _profile_env_file(profile: str) -> Path:
    return Path(__file__).resolve().parent / profile / ".env"


def _read_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _outbox_entries() -> List[Path]:
    """Live and given-up entries alike: `.failed` is a queue, not a bin."""
    if not OUTBOX_DIR.is_dir():
        return []
    return sorted(list(OUTBOX_DIR.glob("*.json")) + list(OUTBOX_DIR.glob("*.failed")))


def _cli_outbox() -> int:
    entries = _outbox_entries()
    if not entries:
        print(f"outbox empty: {OUTBOX_DIR}")
        return 0
    print(f"outbox {OUTBOX_DIR} ({len(entries)} entry/ies)")
    for path in entries:
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"  {path.name}: unreadable ({exc})")
            continue
        age = int(time.time() - float(entry.get("created_at") or time.time()))
        nxt = int(float(entry.get("next_at") or 0) - time.time())
        state = "failed" if path.suffix == ".failed" else ("retry in %ds" % nxt if nxt > 0 else "ready")
        print(
            f"  {entry.get('message_id')}  state={state}  attempts={entry.get('attempts', 0)}  "
            f"age={age}s  {len(str((entry.get('body') or {}).get('text') or ''))} chars"
        )
        if entry.get("last_error"):
            print(f"    last_error: {entry['last_error']}")
    return 0


def _cli_redeliver(message_id: str) -> int:
    matches: List[Path] = []
    for path in _outbox_entries():
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if str(entry.get("message_id")) == message_id or path.stem == message_id:
            matches.append(path)
    if not matches:
        print(f"no outbox entry for {message_id} in {OUTBOX_DIR}")
        return 2
    path = matches[0]
    entry = json.loads(path.read_text(encoding="utf-8"))
    target = _outbox_path(str(entry.get("key") or path.stem))
    if path != target:
        try:
            os.replace(path, target)
        except OSError:
            target = path
    entry["next_at"] = 0.0
    target.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    state = load_state()
    print(f"redelivering {entry.get('message_id')} from {target.name} ({entry.get('attempts', 0)} previous attempts)")
    try:
        reply_id = deliver_reply(entry, state, attempts=3)
    except Exception as exc:  # noqa: BLE001 - this is the operator's answer
        print(f"FAILED: {describe_processing_error(exc)}")
        print(f"text still at {target} (attempts now {int(entry.get('attempts') or 0) + 1})")
        return 1
    print(f"DELIVERED as {reply_id or '<deduplicated by the server>'}")
    return 0


def _cli(argv: List[str]) -> int:
    command = argv[0]
    if command == "--outbox":
        return _cli_outbox()
    if command == "--redeliver":
        if len(argv) < 2:
            print("usage: emperor_hermes_bridge.py --redeliver <message_id> [--profile qa]")
            return 64
        return _cli_redeliver(argv[1])
    print(f"unknown command {command}")
    return 64


def _running_bridge_env(profile: str) -> Dict[str, str]:
    """The env of the live bridge for this profile: the only authoritative one.

    A turn inherits the bridge's variables (`HERMES_PROFILE`, and on some hosts
    the whole config), so `os.environ` inside a shell is not a reliable source.
    The unit may also override the .env via `Environment=` -- which systemd
    applies *after* `EnvironmentFile=`. Read /proc, not the file.
    """
    wanted = ("EMPEROR_CLAW_", "HERMES_")
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            if "emperor_hermes_bridge.py" not in cmdline:
                continue
            raw = (entry / "environ").read_bytes().split(b"\0")
        except OSError:
            continue
        pairs: Dict[str, str] = {}
        for chunk in raw:
            if b"=" in chunk:
                key, _, value = chunk.partition(b"=")
                pairs[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
        if pairs.get("HERMES_PROFILE") != profile:
            continue
        return {k: v for k, v in pairs.items() if k.startswith(wanted)}
    return {}


if __name__ == "__main__":
    _args = list(sys.argv[1:])
    if _args and any(_token.startswith("--") for _token in _args):
        # Any flag means "operator CLI". Falling through to main() here would
        # start a second bridge on this profile's state.db -- which is exactly
        # the double-writer shape this file spends 400 lines preventing.
        _profile = os.environ.get("EMPEROR_CLAW_PROFILE") or "builder"
        if "--profile" in _args:
            _idx = _args.index("--profile")
            if _idx + 1 >= len(_args):
                print("usage: emperor_hermes_bridge.py [--profile <p>] --outbox | --redeliver <message_id>")
                sys.exit(64)
            _profile = _args[_idx + 1]
            del _args[_idx : _idx + 2]
        if not _args:
            print("usage: emperor_hermes_bridge.py [--profile <p>] --outbox | --redeliver <message_id>")
            sys.exit(64)
        if not os.environ.get("EMPEROR_CLAW_CLI_ACTIVE"):
            # Config constants are read at import time, so the environment has
            # to be right before the interpreter starts -- re-exec instead of
            # half-loading it and scoring the wrong state dir or no token.
            # Priority: live bridge /proc env > profile .env > inherited shell.
            _env = dict(os.environ)
            for _key, _value in _read_env_file(_profile_env_file(_profile)).items():
                if _key.startswith(("EMPEROR_CLAW_", "HERMES_")):
                    _env[_key] = _value
            _env.update(_running_bridge_env(_profile))
            _env["EMPEROR_CLAW_CLI_ACTIVE"] = "1"
            os.execve(sys.executable, [sys.executable, os.path.abspath(__file__)] + _args, _env)
        sys.exit(_cli(_args))
    sys.exit(main())
