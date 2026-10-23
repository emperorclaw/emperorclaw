"""One Hermes session per (agent, thread, generation) (D4) and its reattach/replay logic (D14).

`session.create` params are built once per generation, persisted in state (`createParams`) and
replayed byte-identically: Hermes refuses a resumed request_id whose frozen fields changed (W0
finding 8). A changed policy (system prompt, cwd, toolsets, ...) only takes effect through a new
generation, at most once per `refresh_min_interval_s` unless the policy is `urgent` (D6).
`show_reasoning` is re-set after every create/resume because the gateway forgets it on restart
(D12).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional

from ..interfaces import (GatewayEvent, GatewayIdentity, GatewayLinkPort, GatewayUnavailable, RpcError, RpcTimeout,
                          SessionPolicy, SessionStore, ThreadSession)

ResyncListener = Callable[[ThreadSession, str, Mapping[str, Any]], Awaitable[None]]
"""(session, mode, resume snapshot). mode: "replayed" | "snapshot_required" | "restarted"."""

SYSTEM_PROMPT_ENV = "HERMES_EPHEMERAL_SYSTEM_PROMPT"
MAX_RETIRED = 200
MAX_ARCHIVE_ATTEMPTS = 5
_SECRET_NAME = re.compile(r"(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)", re.IGNORECASE)


def request_id_for(agent_id: str, thread_id: str, generation: int) -> str:
    return f"emperor/{agent_id}/{thread_id}/g{generation}"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def policy_hash(create_params: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(create_params).encode("utf-8")).hexdigest()[:16]


def build_create_params(*, agent_id: str, thread_id: str, generation: int, policy: SessionPolicy,
                        profile_home: Path) -> dict[str, Any]:
    """The exact `session.create` params for one generation (only documented keys, P§3.2)."""
    client_env: dict[str, str] = {
        SYSTEM_PROMPT_ENV: policy.system_prompt,
        "EMPEROR_THREAD_ID": thread_id,
        "EMPEROR_THREAD_TYPE": policy.thread_type,
        "EMPEROR_SESSION_GEN": str(generation),
        "EMPEROR_AGENT_ID": agent_id,
        "EMPEROR_PROFILE_HOME": str(profile_home),
    }
    for name, value in (policy.extra_client_env or {}).items():
        if name.startswith("HERMES_") or _SECRET_NAME.search(name):
            raise ValueError(f"client_env name {name!r} would be dropped by Hermes (S-18)")
        client_env[name] = str(value)
    params: dict[str, Any] = {
        "request_id": request_id_for(agent_id, thread_id, generation),
        "source": "tool",
        "yolo": bool(policy.yolo),
        "toolsets": list(policy.toolsets),
        "follow_profile_config": bool(policy.follow_profile_config),
        "client_env": client_env,
    }
    if policy.cwd:
        params["cwd"] = policy.cwd
    if policy.run_budget_seconds and policy.run_budget_seconds > 0:
        params["run_budget"] = int(policy.run_budget_seconds)
    return params


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _age_seconds(iso: Optional[str]) -> float:
    if not iso:
        return float("inf")
    try:
        started = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return (datetime.now(timezone.utc) - started).total_seconds()


class SessionManager:
    """Ensures, attaches, reattaches and replays the sessions of one agent."""

    def __init__(self, link: GatewayLinkPort, store: SessionStore, *, agent_id: str, profile_home: Path,
                 logger: Optional[logging.Logger] = None) -> None:
        self._link = link
        self._store = store
        self._agent_id = agent_id
        self._profile_home = Path(profile_home)
        self._log = logger or logging.getLogger("emperor_bridge.sessions")
        self._cache: dict[str, ThreadSession] = {}
        self._by_session: dict[str, str] = {}
        self._attached: set[str] = set()  # session ids attached on the current turns socket
        self._attached_maintenance: set[str] = set()
        self._active: set[str] = set()  # threads with an admission in flight
        self._locks: dict[str, asyncio.Lock] = {}
        self._resync_listeners: list[ResyncListener] = []
        self._background: set[asyncio.Task] = set()
        self._retired: dict[str, str] = {}  # retired session id -> thread id, closed by close_retired
        self._archived: dict[str, None] = {}  # recently archived ids (bounded), never retired twice
        self._archive_attempts: dict[str, int] = {}  # failed archive attempts per retired id
        link.add_event_listener(self._on_event)
        link.add_reconnect_listener(self._on_reconnect)

    # ---- lookup ---------------------------------------------------------------------------

    def get(self, thread_id: str) -> Optional[ThreadSession]:
        rec = self._cache.get(thread_id)
        if rec is None:
            rec = self._store.get_thread(thread_id)
            if rec is not None:
                self._remember(rec)
        return rec

    def thread_for_session(self, session_id: str) -> Optional[str]:
        return self._by_session.get(session_id)

    def add_resync_listener(self, listener: ResyncListener) -> None:
        self._resync_listeners.append(listener)

    def mark_active(self, thread_id: str, active: bool) -> None:
        (self._active.add if active else self._active.discard)(thread_id)

    def invalidate(self, thread_id: str) -> None:
        """Forget the attachment (e.g. after permission_denied) so the next ensure re-attaches."""
        rec = self._cache.get(thread_id)
        if rec is not None and rec.session_id:
            self._attached.discard(rec.session_id)
            self._attached_maintenance.discard(rec.session_id)

    def persist(self, rec: ThreadSession) -> None:
        self._store.put_thread(rec)

    async def save(self) -> None:
        await self._store.save()

    def _spawn(self, coro: Awaitable[None]) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._background.add(task)

        def _done(done: asyncio.Task) -> None:
            self._background.discard(done)
            if not done.cancelled() and done.exception() is not None:
                self._log.warning("background session task failed: %r", done.exception())

        task.add_done_callback(_done)
        return task

    def _remember(self, rec: ThreadSession) -> None:
        self._cache[rec.thread_id] = rec
        if rec.session_id:
            self._by_session[rec.session_id] = rec.thread_id

    def _lock(self, thread_id: str) -> asyncio.Lock:
        return self._locks.setdefault(thread_id, asyncio.Lock())

    # ---- ensure / generations -------------------------------------------------------------

    def _new_generation(self, thread_id: str, generation: int, policy: SessionPolicy) -> ThreadSession:
        params = build_create_params(agent_id=self._agent_id, thread_id=thread_id, generation=generation,
                                     policy=policy, profile_home=self._profile_home)
        return ThreadSession(thread_id=thread_id, generation=generation, create_params=params,
                             policy_hash=policy_hash(params), generation_started_at=_now_iso())

    def plan(self, thread_id: str, policy: SessionPolicy) -> ThreadSession:
        """The record to use for this policy: the stored one, or a new generation (not yet created)."""
        rec = self.get(thread_id)
        if rec is None:
            floor = getattr(self._store, "generation_floor", lambda _t: 0)(thread_id)
            return self._new_generation(thread_id, max(1, floor + 1), policy)
        candidate = build_create_params(agent_id=self._agent_id, thread_id=thread_id,
                                        generation=rec.generation, policy=policy,
                                        profile_home=self._profile_home)
        if policy_hash(candidate) == rec.policy_hash:
            return rec
        if policy.urgent or _age_seconds(rec.generation_started_at) >= policy.refresh_min_interval_s:
            self._log.info("thread=%s policy changed: generation %d -> %d", thread_id, rec.generation,
                           rec.generation + 1)
            return self._new_generation(thread_id, rec.generation + 1, policy)
        return rec  # throttled: keep replaying the stored params verbatim

    async def ensure(self, thread_id: str, policy: SessionPolicy) -> ThreadSession:
        async with self._lock(thread_id):
            previous = self.get(thread_id)
            rec = self.plan(thread_id, policy)
            if rec.session_id and rec.session_id in self._attached and self._cache.get(thread_id) is rec:
                return rec
            started = time.monotonic()
            snapshot = await self._link.turns.call("session.create", rec.create_params)
            # ensure runs only before a new submit (single flight), so nothing older is awaited.
            self._apply_snapshot(rec, snapshot, reset_cursor=True)
            await self._set_reasoning(rec)
            self._attached.add(rec.session_id or "")
            identity = self._link.identity
            rec.attached_instance = identity.instance_id if identity else None
            self._remember(rec)
            self._store.put_thread(rec)
            await self._store.save()
            if previous is not None and previous.session_id and previous.session_id != rec.session_id:
                self._retire(previous)  # M8: a policy refresh retired the previous generation
                self._spawn(self.close_retired())
            self._log.info("ensure_session thread=%s gen=%d session=%s ms=%.1f", thread_id, rec.generation,
                           rec.session_id, (time.monotonic() - started) * 1000)
            return rec

    def bump_generation(self, thread_id: str, reason: str) -> Optional[int]:
        """Force a fresh session on the next ensure (kill/replace, model-key rotation)."""
        rec = self.get(thread_id)
        if rec is None:
            return None
        self._retire(rec)
        rec.policy_hash = f"bumped:{reason}"
        rec.generation_started_at = None
        self.invalidate(thread_id)
        self._store.put_thread(rec)
        self._log.info("thread=%s generation %d retired (%s)", thread_id, rec.generation, reason)
        return rec.generation + 1

    def bump_all(self, reason: str) -> list[str]:
        threads = [t.thread_id for t in self._store.all_threads()]
        for thread_id in threads:
            self.bump_generation(thread_id, reason)
        return threads

    def _retire(self, rec: ThreadSession) -> None:
        """Remember a session that no generation will use again (bounded: oldest dropped)."""
        if rec.session_id and rec.session_id not in self._archived:
            self._retired.pop(rec.session_id, None)
            self._retired[rec.session_id] = rec.thread_id
            while len(self._retired) > MAX_RETIRED:
                self._retired.pop(next(iter(self._retired)))

    def retired(self) -> list[str]:
        return list(self._retired)

    async def close_retired(self) -> int:
        """Archive the Hermes sessions of retired generations (M8): kill/replace and policy
        refreshes. Archive, not delete: the transcript stays readable in Hermes, the session
        just leaves the active list. A refused or unreachable archive stays queued for the next
        call (never retried more than MAX_RETIRED sessions back)."""
        closed = 0
        for session_id, thread_id in list(self._retired.items()):
            if session_id in self._by_session and self._by_session[session_id] in self._active:
                continue  # never touch a session with a turn in flight
            if not await self._archive(session_id, thread_id):
                tries = self._archive_attempts.get(session_id, 0) + 1
                self._archive_attempts[session_id] = tries
                if tries >= MAX_ARCHIVE_ATTEMPTS:  # give up: never retried forever
                    self._log.warning("retired session %s left unarchived after %d attempts", session_id, tries)
                    self._retired.pop(session_id, None)
                    self._archive_attempts.pop(session_id, None)
                continue
            self._retired.pop(session_id, None)
            self._archive_attempts.pop(session_id, None)
            self._archived[session_id] = None
            while len(self._archived) > MAX_RETIRED:
                self._archived.pop(next(iter(self._archived)))
            closed += 1
        return closed

    async def _archive(self, session_id: str, thread_id: str) -> bool:
        try:
            snapshot = await self._link.maintenance.call("session.resume", {"session_id": session_id})
            await self._link.maintenance.call("session.mutate", {
                "session_id": session_id, "request_id": f"archive-{uuid.uuid4()}",
                "expected_revision": int(snapshot.get("revision") or 0),
                "expected_generation": int(snapshot.get("execution_generation") or 0),
                "operation": "archive", "payload": {"archived": True}}, timeout=10)
        except RpcError as exc:
            if exc.reason in ("not_found", "session_not_found"):
                return True  # already gone
            self._log.info("archiving retired session %s failed: %s", session_id, exc)
            return False
        except (GatewayUnavailable, RpcTimeout) as exc:
            self._log.info("archiving retired session %s deferred: %s", session_id, exc)
            return False
        self._log.info("archived retired session %s (thread %s)", session_id, thread_id)
        return True

    async def attach_maintenance(self, rec: ThreadSession) -> Mapping[str, Any]:
        """Attach the session on the maintenance socket and return a fresh snapshot."""
        snapshot = await self._link.maintenance.call("session.resume", {"session_id": rec.session_id})
        self._attached_maintenance.add(rec.session_id or "")
        rec.revision = int(snapshot.get("revision") or rec.revision)
        rec.execution_generation = int(snapshot.get("execution_generation") or rec.execution_generation)
        return snapshot

    # ---- snapshots, cursors, live updates -------------------------------------------------

    def _apply_snapshot(self, rec: ThreadSession, snap: Mapping[str, Any], *, reset_cursor: bool) -> None:
        rec.session_id = str(snap.get("session_id") or rec.session_id or "")
        rec.revision = int(snap.get("revision") or 0)
        rec.execution_generation = int(snap.get("execution_generation") or 0)
        if reset_cursor or rec.replay_epoch is None or rec.replay_epoch != snap.get("replay_epoch"):
            rec.replay_epoch = snap.get("replay_epoch")
            rec.last_seq = int(snap.get("last_sequence") or 0)
        if rec.session_id:
            self._link.seed_cursor(rec.session_id, rec.replay_epoch, rec.last_seq)

    async def _set_reasoning(self, rec: ThreadSession) -> None:
        try:
            await self._link.turns.call("config.set", {"session_id": rec.session_id, "key": "show_reasoning",
                                                       "value": "on"})
        except RpcError as exc:
            self._log.warning("show_reasoning on failed for %s: %s", rec.session_id, exc)

    def _on_event(self, event: GatewayEvent) -> None:
        thread_id = self._by_session.get(event.session_id or "")
        rec = self._cache.get(thread_id) if thread_id else None
        if rec is None:
            return
        if event.seq is not None:
            if event.replay_epoch and event.replay_epoch != rec.replay_epoch:
                rec.replay_epoch = event.replay_epoch
                rec.last_seq = int(event.seq)
            else:
                rec.last_seq = max(rec.last_seq, int(event.seq))
        payload = event.payload
        if event.type == "session.usage":
            used = (payload.get("usage") or {}).get("context_used")
            if isinstance(used, int):
                rec.context_used = used
        elif event.type in ("session.info", "session.updated"):
            for key, attr in (("revision", "revision"), ("execution_generation", "execution_generation")):
                if isinstance(payload.get(key), int):
                    setattr(rec, attr, payload[key])
        elif event.type == "session.replay_gap":
            self._spawn(self._resync(rec, restarted=False))

    # ---- reconnect / restart (D14, D15) ---------------------------------------------------

    async def _on_reconnect(self, identity: GatewayIdentity, restarted: bool) -> None:
        self._attached.clear()
        self._attached_maintenance.clear()
        for thread_id in list(self._active):
            rec = self.get(thread_id)
            if rec is None or not rec.session_id:
                continue
            try:
                await self._resync(rec, restarted=restarted)
            except Exception:
                self._log.exception("resync of thread %s failed", thread_id)

    async def resync(self, thread_id: str, *, restarted: bool = False) -> Optional[ThreadSession]:
        """Reattach one thread's session and replay from the persisted cursor (bridge restart)."""
        rec = self.get(thread_id)
        if rec is None or not rec.session_id:
            return None
        self._remember(rec)
        await self._resync(rec, restarted=restarted)
        return rec

    async def _resync(self, rec: ThreadSession, *, restarted: bool) -> None:
        session_id = rec.session_id or ""
        self._link.hold_session(session_id)
        mode = "restarted" if restarted else "replayed"
        snapshot: Mapping[str, Any] = {}
        try:
            snapshot = await self._link.turns.call("session.resume", {"session_id": session_id})
            self._attached.add(session_id)
            await self._set_reasoning(rec)
            if restarted:
                rec.replay_epoch = None
                self._apply_snapshot(rec, snapshot, reset_cursor=True)
            else:
                since = await self._link.maintenance.call("session.events.since", {
                    "session_id": session_id, "last_sequence": rec.last_seq,
                    "replay_epoch": rec.replay_epoch or ""})
                if since.get("snapshot_required") or since.get("truncated"):
                    mode = "snapshot_required"
                    self._apply_snapshot(rec, snapshot, reset_cursor=True)
                else:
                    events = [GatewayEvent.from_params(e, received_at=time.time(), replayed=True)
                              for e in since.get("events") or ()]
                    self._link.inject_events(events)
                rec.revision = int(snapshot.get("revision") or rec.revision)
                rec.execution_generation = int(snapshot.get("execution_generation") or rec.execution_generation)
        finally:
            self._link.release_session(session_id)
        self._store.put_thread(rec)
        self._log.info("resync thread=%s session=%s mode=%s last_seq=%d", rec.thread_id, session_id, mode,
                       rec.last_seq)
        for listener in list(self._resync_listeners):
            await listener(rec, mode, snapshot)
