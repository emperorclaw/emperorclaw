"""The Emperor side of the bridge: the HTTP client (one per AgentRuntime, its own token) and the
inbound message rules (sync cursor, seen ledger, retry ledger, routing, loop guard).

HTTP runs in worker threads (urllib, stdlib only) behind ``async`` methods. Transient transport
failures (a DNS burst, a TLS stall: the PC's USB WiFi drops the link for ~10 s) are retried inside
a bounded budget; an HTTP answer is never retried here. ``EmperorClient`` implements
``interfaces.EmperorPort`` for the core. While ``ops/update`` swaps the containers, an old server
can answer the events endpoint with 404: that is treated as "unavailable" (the sink keeps the
events in memory and retries), never as a crash.
"""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import re
import socket
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Mapping, Optional, Sequence

from .interfaces import BridgeError, EmperorUnavailable, RunGone, RunNotFound
from .version import USER_AGENT

SHARED_THREAD_TYPES = frozenset({"team", "group"})
SEEN_CAP = 1000
_TRANSIENT_MARKERS = ("name resolution", "temporary failure", "timed out", "connection reset", "connection refused",
                      "network is unreachable", "eof occurred", "broken pipe", "remote end closed")


class ApiError(BridgeError):
    """An HTTP error answer from Emperor, with its status."""

    def __init__(self, message: str, status_code: int, body: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class TransportError(EmperorUnavailable):
    """No HTTP answer at all (DNS, TLS, reset, timeout) after the transport retries."""


def is_transient_transport_error(exc: BaseException) -> bool:
    reason = getattr(exc, "reason", None) or exc
    if isinstance(reason, (socket.gaierror, socket.timeout, TimeoutError, ConnectionError)):
        return True
    return any(marker in str(reason).lower() for marker in _TRANSIENT_MARKERS)


def is_soft_failure(exc: BaseException) -> bool:
    """A failed write may retry without spending a give-up budget: no answer, or a 5xx."""
    if isinstance(exc, ApiError):
        return exc.status_code >= 500
    return isinstance(exc, (EmperorUnavailable, OSError))


def is_environment_failure(exc: BaseException) -> bool:
    """The environment failed (Emperor unreachable, 5xx, 408/425/429), not the prompt."""
    if isinstance(exc, ApiError):
        return exc.status_code >= 500 or exc.status_code in (408, 425, 429)
    return isinstance(exc, (EmperorUnavailable, OSError))


@dataclass(frozen=True)
class Transport:
    attempts: int = 6
    backoff_s: float = 0.5
    backoff_max_s: float = 3.0
    budget_s: float = 25.0


class EmperorClient:
    """Emperor `/api/mcp/*` for one agent. Implements interfaces.EmperorPort."""

    def __init__(self, api_url: str, token: str, *, agent_id: str = "", transport: Transport = Transport(),
                 logger: Optional[logging.Logger] = None,
                 opener: Optional[Callable[..., Any]] = None, sleep: Callable[[float], None] = time.sleep) -> None:
        self.api_url = api_url.rstrip("/")
        self._token = token
        self.agent_id = agent_id
        self._transport = transport
        self._log = logger or logging.getLogger("emperor_bridge.api")
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        # The long-poll sync blocks a worker for up to 45 s. It gets its own single-thread
        # executor so it can never starve the default executor that state saves and event posts
        # share (M3, Pi).
        self._longpoll = ThreadPoolExecutor(max_workers=1, thread_name_prefix="emperor-longpoll")

    def close(self) -> None:
        self._longpoll.shutdown(wait=False, cancel_futures=True)

    # ---- low level -------------------------------------------------------------------------

    def url(self, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
        clean = "/" + path.lstrip("/")
        if not clean.startswith("/api/"):
            clean = "/api/mcp" + clean
        url = self.api_url + clean
        pairs = {k: v for k, v in (query or {}).items() if v not in (None, "")}
        return url + ("?" + urllib.parse.urlencode(pairs) if pairs else "")

    def _urlopen(self, req: urllib.request.Request, timeout: float, retry: bool) -> Any:
        attempt, started = 1, time.monotonic()
        while True:
            try:
                return self._open(req, timeout=timeout)
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, OSError) as exc:
                remaining = self._transport.budget_s - (time.monotonic() - started)
                if not retry or attempt >= self._transport.attempts or remaining <= 0 \
                        or not is_transient_transport_error(exc):
                    if attempt > 1:
                        self._log.warning("transport gave up after %d attempts in %.1fs: %s", attempt,
                                          time.monotonic() - started, exc)
                    raise TransportError(f"{req.get_method()} {req.full_url.split('?')[0]}: {exc}") from exc
                delay = min(self._transport.backoff_max_s, self._transport.backoff_s * (2 ** (attempt - 1)), remaining)
                if delay > 0:
                    self._sleep(delay)
                attempt += 1

    def request_sync(self, method: str, path: str, body: Any = None, query: Optional[Mapping[str, Any]] = None, *,
                     timeout: float = 30, transport_retry: bool = True, idempotency_key: Optional[str] = None,
                     etag: str = "") -> tuple[int, Any, Mapping[str, str]]:
        if not self._token:
            raise BridgeError("EMPEROR_CLAW_API_TOKEN is required")
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json", "User-Agent": USER_AGENT}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        if etag:
            headers["If-None-Match"] = etag
        req = urllib.request.Request(self.url(path, query), data=data, headers=headers, method=method.upper())
        try:
            with self._urlopen(req, timeout, transport_retry) as res:
                text = res.read().decode("utf-8", errors="replace")
                return res.status, _parse(text), dict(res.headers.items())
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                return 304, None, dict(exc.headers.items()) if exc.headers else {}
            text = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            raise ApiError(f"Emperor API {method.upper()} {path} failed {exc.code}: {text[:300]}", exc.code, text) from exc

    async def request(self, method: str, path: str, body: Any = None, query: Optional[Mapping[str, Any]] = None,
                      **kwargs: Any) -> Any:
        _status, payload, _headers = await asyncio.to_thread(self.request_sync, method, path, body, query, **kwargs)
        return payload

    def _agent_query(self, **extra: Any) -> dict[str, Any]:
        return {"agentId": self.agent_id, **extra}

    # ---- EmperorPort -----------------------------------------------------------------------

    async def post_run_events(self, run_id: str, events: Sequence[Mapping[str, Any]],
                              run_header: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]:
        body: dict[str, Any] = {"events": list(events)}
        if run_header:
            body["run"] = dict(run_header)
        try:
            return await self.request("POST", f"/agents/runs/{run_id}/events", body, timeout=15) or {}
        except ApiError as exc:
            if exc.status_code == 409 and "run_not_found" in exc.body:
                raise RunNotFound(str(exc)) from exc
            if exc.status_code == 410:
                raise RunGone(str(exc)) from exc
            if exc.status_code == 409:
                # A run-id conflict (a different run already owns this id) is permanent: drop the
                # events instead of parking and retrying them forever (LOW-4). The ApiError is a
                # BridgeError, so EventSink drops the batch.
                self._log.error("run events for %s dropped (run-id conflict): %s", run_id, exc)
                raise
            if exc.status_code == 404 or is_environment_failure(exc):
                raise EmperorUnavailable(str(exc)) from exc  # old server mid-update: spool, retry
            raise

    async def ack_control_command(self, command_id: str) -> None:
        await self.request("POST", "/agents/control", {"commandId": command_id}, self._agent_query())

    # ---- calls the runtime makes -----------------------------------------------------------

    async def register(self, body: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.request("POST", "/runtime/register", dict(body)) or {}

    async def heartbeat(self, current_load: int, runtime_id: str) -> None:
        await self.request("POST", "/agents/heartbeat", {"agentId": self.agent_id, "currentLoad": current_load,
                                                         "runtimeId": runtime_id}, timeout=15)

    async def sync(self, since: Optional[str], retry_ids: Sequence[str],
                   known_ids: Sequence[str] = ()) -> Mapping[str, Any]:
        query = self._agent_query(mode="all", since=since)
        if retry_ids:
            query["retryMessageIds"] = ",".join(list(retry_ids)[-100:])
        if known_ids:  # ids we hold: they alone never end the server's long poll
            query["knownIds"] = ",".join(list(known_ids)[-200:])
        _status, payload, _headers = await asyncio.get_running_loop().run_in_executor(
            self._longpoll, functools.partial(self.request_sync, "GET", "/messages/sync", None, query, timeout=45))
        return payload or {}

    async def send_message(self, body: Mapping[str, Any], *, idempotency_key: Optional[str] = None,
                           transport_retry: bool = True) -> Optional[str]:
        response = await self.request("POST", "/messages/send", dict(body), idempotency_key=idempotency_key,
                                      transport_retry=transport_retry)
        message_id = response.get("message_id") if isinstance(response, Mapping) else None
        return str(message_id) if message_id else None

    async def chat_status(self, thread_id: str, *, message_id: Optional[str] = None, typing: Optional[bool] = None,
                          mark_read: bool = False, execution_state: Optional[str] = None,
                          reason: Optional[str] = None) -> None:
        if not thread_id:
            return
        body: dict[str, Any] = {"threadId": thread_id, "agentId": self.agent_id}
        if typing is not None:
            body["typing"] = typing
        if mark_read:
            body["markRead"] = True
        if execution_state:
            body["executionState"] = execution_state
            if message_id:
                body["messageId"] = message_id  # scope the state to this exact message
        if reason:
            body["reason"] = reason[:300]
        await self.request("POST", "/chat/status", body, timeout=15)

    async def control(self, message_id: Optional[str] = None) -> Mapping[str, Any]:
        return await self.request("GET", "/agents/control", query=self._agent_query(messageId=message_id),
                                  timeout=15) or {}

    async def get_with_etag(self, path: str, query: Optional[Mapping[str, Any]], etag: str) -> tuple[int, Any, str]:
        status, payload, headers = await asyncio.to_thread(self.request_sync, "GET", path, None, query, timeout=5,
                                                           etag=etag)
        lowered = {k.lower(): v for k, v in headers.items()}
        return status, payload, lowered.get("etag") or etag


def _parse(text: str) -> Any:
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {"text": text}


# ---------------------------------------------------------------------------------------------
# Inbound message rules (ported from bridge 0.3: routing, loop guard, cold start, retries)
# ---------------------------------------------------------------------------------------------


def field(message: Mapping[str, Any], camel: str, snake: str = "") -> str:
    value = message.get(camel)
    if value in (None, "") and snake:
        value = message.get(snake)
    return str(value or "")


def thread_of(message: Mapping[str, Any]) -> str:
    return field(message, "threadId", "thread_id")


def thread_type_of(message: Mapping[str, Any]) -> str:
    return field(message, "threadType", "thread_type").lower()


def sender_type_of(message: Mapping[str, Any]) -> str:
    return field(message, "senderType", "sender_type").lower()


def parse_iso(value: Any) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def remember_seen(data: dict[str, Any], message_id: str) -> bool:
    seen = list(data.get("seen") or [])
    if message_id in seen:
        return False
    seen.append(message_id)
    data["seen"] = seen[-SEEN_CAP:]
    return True


def forget_seen(data: dict[str, Any], message_id: str) -> None:
    data["seen"] = [m for m in data.get("seen") or [] if m != message_id]


def retry_entries(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entries = data.get("retries")
    if not isinstance(entries, dict):
        entries = data["retries"] = {}
    return entries


def retry_due(data: dict[str, Any], message_id: str, now: Optional[float] = None) -> bool:
    entry = retry_entries(data).get(message_id)
    if not isinstance(entry, dict):
        return True
    return float(entry.get("nextRetryAt", 0) or 0) <= (time.time() if now is None else now)


def mark_inflight(data: dict[str, Any], message_id: str, now: Optional[float] = None) -> None:
    """Keep the id in the retry ledger while it runs: a crash re-syncs it via retryMessageIds."""
    entry = retry_entries(data).setdefault(message_id, {})
    entry.setdefault("firstAttemptAt", time.time() if now is None else now)
    entry["inflight"] = True


def schedule_retry(data: dict[str, Any], message_id: str, *, base_s: int, max_s: int, environment: bool = False,
                   now: Optional[float] = None, wait_floor_s: float = 45, wait_cap_s: Optional[float] = None) -> int:
    """Bounded exponential backoff. An environment wait never spends the attempt budget (the
    poison-prompt budget that ends in a visible cancel); it counts `busyMisses` instead. A short
    `wait_floor_s`/`wait_cap_s` fits a gateway restart (seconds), the defaults an Emperor outage."""
    now = time.time() if now is None else now
    entry = dict(retry_entries(data).get(message_id) or {})
    entry.setdefault("firstAttemptAt", now)
    entry.pop("inflight", None)
    if environment:
        misses = int(entry.get("busyMisses", 0)) + 1
        entry["busyMisses"] = misses
        entry["attempts"] = int(entry.get("attempts", 0))
        cap = wait_cap_s if wait_cap_s is not None else max(max_s, 600)
        floor = wait_floor_s if wait_cap_s is not None else max(base_s, wait_floor_s)
        delay = min(cap, floor * (2 ** min(misses - 1, 10)))
        counter = misses
    else:
        counter = entry["attempts"] = int(entry.get("attempts", 0)) + 1
        entry.pop("busyMisses", None)
        delay = min(max_s, base_s * (2 ** min(counter - 1, 16)))
    entry["nextRetryAt"] = now + delay
    retry_entries(data)[message_id] = entry
    return counter


def environment_wait_exhausted(data: dict[str, Any], message_id: str, ceiling_s: float,
                               now: Optional[float] = None) -> bool:
    entry = retry_entries(data).get(message_id)
    try:
        first = float((entry or {}).get("firstAttemptAt") or 0)
    except (TypeError, ValueError):
        return False
    return first > 0 and (time.time() if now is None else now) - first >= ceiling_s


def clear_retry(data: dict[str, Any], message_id: str) -> None:
    retry_entries(data).pop(message_id, None)


RETRY_MAX_AGE_S = 24 * 3600
RETRY_MAX_ENTRIES = 500


def bound_retries(data: dict[str, Any], *, now: Optional[float] = None, max_age_s: float = RETRY_MAX_AGE_S,
                  cap: int = RETRY_MAX_ENTRIES) -> bool:
    """Bound the retry ledger: drop entries idle past `max_age_s` and cap the total count (M2).
    Returns True when anything was removed."""
    entries = retry_entries(data)
    now = time.time() if now is None else now
    changed = False
    for message_id, entry in list(entries.items()):
        if not isinstance(entry, dict):
            entries.pop(message_id, None)
            changed = True
            continue
        first = float(entry.get("firstAttemptAt") or 0)
        if first and now - first > max_age_s:
            entries.pop(message_id, None)
            changed = True
    if len(entries) > cap:
        ordered = sorted(entries.items(), key=lambda kv: float((kv[1] or {}).get("firstAttemptAt") or 0))
        for message_id, _ in ordered[: len(entries) - cap]:
            entries.pop(message_id, None)
        changed = True
    return changed


def is_processed_delivery_state(message: Mapping[str, Any]) -> bool:
    """Resolved/cancelled finishes a DIRECT message only: in shared rooms the server stamps every
    agent post "resolved", and skipping those silently dropped every peer @mention."""
    if field(message, "deliveryState", "delivery_state").lower() not in ("resolved", "cancelled"):
        return False
    return thread_type_of(message) not in SHARED_THREAD_TYPES


def is_recoverable_direct_message(message: Mapping[str, Any], agent_id: str) -> bool:
    return field(message, "targetAgentId", "target_agent_id") == agent_id and \
        field(message, "deliveryState", "delivery_state").lower() in ("queued", "seen", "acting")


def is_backlog(created_at: Any, started_at: float) -> bool:
    stamp = parse_iso(created_at)
    return stamp is not None and stamp < started_at


def clean_mention_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Cf")
    return re.sub(r"[^\S\r\n  ]+", " ", normalized)


def normalize_mention(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", ascii_value.lower())


def agent_name_aliases(name: str) -> set[str]:
    clean = re.sub(r"\([^)]*\)", "", clean_mention_text(name)).strip()
    clean = re.split(r"\s+-\s+|\s+—\s+|\s+\|\s+", clean, maxsplit=1)[0].strip()
    parts = [part for part in re.split(r"\s+", clean) if part]
    candidates = {name, clean}
    if parts:
        candidates.update({parts[0], "-".join(parts), "_".join(parts)})
    return {c.strip("@ ") for c in candidates if c and c.strip("@ ")}


def mentioned_agent_refs(text: str) -> set[str]:
    refs = set()
    for match in re.finditer(r"(?<![\w@])@([^\s,.;:!?@()<>]+(?:[ \t]+[^\s,.;:!?@()<>]+){0,31})",
                             clean_mention_text(text)):
        words = match.group(1).split()
        refs.update(" ".join(words[:n]) for n in range(1, len(words) + 1))
    return refs


def mentions_agent(text: str, agent_name: str) -> bool:
    mentions = {normalize_mention(ref) for ref in mentioned_agent_refs(text)}
    return bool(mentions & {normalize_mention(alias) for alias in agent_name_aliases(agent_name)})


_EVERYONE = re.compile(r"(?<![\w@])@(all|everyone)(?![\w-])", re.IGNORECASE)


def mentions_everyone(text: str) -> bool:
    return bool(_EVERYONE.search(clean_mention_text(text)))


def server_routed(message: Mapping[str, Any]) -> bool:
    """Servers since the routing change send a per-agent verdict (`addressedToYou`); it wins."""
    return isinstance(message.get("addressedToYou"), bool)


def is_direct_thread(message: Mapping[str, Any], agent_id: str, data: Mapping[str, Any]) -> bool:
    kind = thread_type_of(message)
    if kind == "direct":
        return True
    if kind in SHARED_THREAD_TYPES:
        return False
    if field(message, "targetAgentId", "target_agent_id") == agent_id and agent_id:
        return True
    thread_id = thread_of(message)
    return bool(thread_id) and (data.get("directThreads") or {}).get(thread_id) == agent_id


def is_for_agent(message: Mapping[str, Any], agent_id: str, agent_name: str, data: Mapping[str, Any]) -> bool:
    sender_type = sender_type_of(message)
    sender_id = field(message, "senderId", "sender_id") or str(message.get("fromUserId") or "")
    if sender_type == "agent" and sender_id == agent_id:
        return False
    if server_routed(message):
        return bool(message.get("addressedToYou"))
    text = str(message.get("text") or "")
    kind = thread_type_of(message)
    thread_id = thread_of(message)
    target = field(message, "targetAgentId", "target_agent_id")
    if target:
        return target == agent_id
    direct_threads = data.get("directThreads") or {}
    if thread_id and thread_id in direct_threads:
        return direct_threads[thread_id] == agent_id
    if kind == "direct":
        return True
    if kind == "group" and sender_type == "human" and mentions_everyone(text):
        return True  # a human's @all wakes every member; an agent's never does
    return mentions_agent(text, agent_name)


def check_loop_guard(message: Mapping[str, Any], data: dict[str, Any], max_turns: int,
                     now: Optional[float] = None) -> bool:
    """Backstop for agent-to-agent loops in shared rooms (older servers only): after `max_turns`
    consecutive agent-authored triggers without a human message, stop answering in that thread."""
    if thread_type_of(message) not in SHARED_THREAD_TYPES or not thread_of(message):
        return True
    guard = data.setdefault("loopGuard", {})
    entry = guard.setdefault(thread_of(message), {"count": 0, "notified": False})
    if sender_type_of(message) != "agent":
        entry.update(count=0, notified=False)
        return True
    now = time.time() if now is None else now
    if now - float(entry.get("last_activity", now)) >= 300:
        entry.update(count=0, notified=False)
    entry["last_activity"] = now
    entry["count"] = int(entry.get("count", 0)) + 1
    return entry["count"] <= max_turns


@dataclass(frozen=True)
class Verdict:
    action: str  # dispatch | skip | loop_guard | parked
    reason: str = ""
    mutated: bool = False  # True when classify changed seen/retries/directThreads/loopGuard


def classify(message: Mapping[str, Any], *, agent_id: str, agent_name: str, data: dict[str, Any],
             started_at: float, loop_guard_max_turns: int, has_parked_reply: Callable[[str], bool],
             now: Optional[float] = None) -> Verdict:
    """The 0.3 filter chain, in order, for one synced message. Mutates the seen/ownership ledgers."""
    message_id = str(message.get("id") or "")
    if not message_id:
        return Verdict("skip", "no-id")
    if is_processed_delivery_state(message):
        clear_retry(data, message_id)
        remember_seen(data, message_id)
        return Verdict("skip", "processed", mutated=True)
    if has_parked_reply(message_id):
        return Verdict("parked", "reply-in-outbox", mutated=remember_seen(data, message_id))
    mutated = False
    if message_id in (data.get("seen") or []):
        if not is_recoverable_direct_message(message, agent_id):
            return Verdict("skip", "seen")
        forget_seen(data, message_id)  # a crash or a human Retry left it active server-side
        mutated = True
    if not retry_due(data, message_id, now):
        return Verdict("skip", "retry-not-due", mutated=mutated)
    target, thread_id, kind = field(message, "targetAgentId", "target_agent_id"), thread_of(message), \
        thread_type_of(message)
    if target and thread_id and kind not in SHARED_THREAD_TYPES:
        data.setdefault("directThreads", {})[thread_id] = target  # learn DM ownership
    if kind in SHARED_THREAD_TYPES and thread_id and sender_type_of(message) == "agent" \
            and is_backlog(message.get("createdAt"), started_at):
        remember_seen(data, message_id)
        return Verdict("skip", "cold-start-backlog", mutated=True)
    if not is_for_agent(message, agent_id, agent_name, data):
        remember_seen(data, message_id)
        return Verdict("skip", "not-addressed", mutated=True)
    if field(message, "deliveryState", "delivery_state").lower() == "cancelled":
        remember_seen(data, message_id)
        return Verdict("skip", "cancelled", mutated=True)
    if not server_routed(message) and not check_loop_guard(message, data, loop_guard_max_turns, now):
        remember_seen(data, message_id)
        return Verdict("loop_guard", "loop-guard", mutated=True)
    return Verdict("dispatch", mutated=True)


KEPT_RAW = ("id", "threadId", "threadType", "senderType", "senderId", "senderName", "text", "createdAt",
            "targetAgentId", "goalTurn", "replyToMessageId", "metadataJson")


def kept_fields(message: Mapping[str, Any]) -> dict[str, Any]:
    """The part of a synced message the bridge persists for recovery."""
    return {**{k: message[k] for k in KEPT_RAW if k in message}, "threadId": thread_of(message)}


def split_control_commands(payload: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(per-message stop commands, kill/replace commands in the server's metadataJson shape)."""
    stops: list[dict[str, Any]] = []
    kills: list[dict[str, Any]] = []
    commands = payload.get("commands") if isinstance(payload, Mapping) else None
    for command in commands or []:
        action = command.get("action")
        if action == "stop" and command.get("messageId"):
            stops.append(command)
        elif action in ("kill", "replace") and not command.get("metadataJson"):
            control = {"action": action, **({"scope": command["scope"]} if command.get("scope") else {})}
            kills.append({**command, "metadataJson": {"runtimeControl": control}})
        else:
            kills.append(command)
    return stops, kills


async def resolve_agent_id(client: EmperorClient, name: str, role: str) -> str:
    """0.3 behaviour when EMPEROR_CLAW_AGENT_ID is unset: find the agent by name, else create it."""
    payload = await client.request("GET", "/agents", query={"limit": 200})
    for agent in (payload or {}).get("agents") or []:
        if str(agent.get("name") or "").lower() == name.lower():
            return str(agent.get("id"))
    created = await client.request("POST", "/agents", {"name": name, "role": role,
                                                       "skillsJson": ["hermes-agent", "emperor-claw"],
                                                       "modelPolicyJson": {"runtime": "hermes"}, "status": "online"})
    agent_id = str(((created or {}).get("agent") or {}).get("id") or "")
    if not agent_id:
        raise BridgeError(f"could not resolve or create agent {name!r}")
    return agent_id
