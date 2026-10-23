"""Bridge state v2: `<profile_home>/emperor/bridge-state.json`, one file per agent (section 5.3).

Atomic writes (tmp + fsync + replace) with the previous file kept as `.bak`; a corrupt file is
moved aside to `.corrupt` and the `.bak` is used. A 0.3 bridge state (`emperor-bridge-state.json`,
no `version` key) is imported once: `seen`, `lastSeenAt`, `retries`, direct threads, loop guard
and objective carry over; CLI `sessions`/`primed` do not (fresh sessions, S-3). The legacy file is
never modified, so a rollback to 0.3 still finds it.
"""
from __future__ import annotations

from types import MappingProxyType

import asyncio
import copy
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from .interfaces import ThreadSession

STATE_VERSION = 2
STATE_FILENAME = "bridge-state.json"

_THREAD_FIELDS = MappingProxyType({  # ThreadSession attribute -> persisted key
    "generation": "generation", "policy_hash": "policyHash", "create_params": "createParams",
    "session_id": "sessionId", "replay_epoch": "replayEpoch", "last_seq": "lastSeq",
    "revision": "revision", "execution_generation": "executionGeneration",
    "context_used": "contextUsed", "last_task_set_hash": "lastTaskSetHash",
    "last_turn_at": "lastTurnAt", "generation_started_at": "generationStartedAt",
})
_LEGACY_KEYS = MappingProxyType({"seen": "seen", "lastSeenAt": "lastSeenAt", "retries": "retries",
                "direct_threads": "directThreads", "loop_guard": "loopGuard",
                "objective": "objective", "goalTransportReady": "goalTransportReady"})


def utc_now_iso(ts: Optional[float] = None) -> str:
    moment = datetime.fromtimestamp(ts if ts is not None else time.time(), timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def state_path_for(profile_home: Path) -> Path:
    return Path(profile_home) / "emperor" / STATE_FILENAME


def empty_state(agent_id: str = "", runtime_id: str = "") -> dict[str, Any]:
    return {"version": STATE_VERSION, "agentId": agent_id, "runtimeId": runtime_id, "seen": [],
            "lastSeenAt": None, "directThreads": {}, "loopGuard": {}, "threads": {}, "turns": {},
            "objective": None}


def migrate_legacy(legacy: Mapping[str, Any], agent_id: str = "", runtime_id: str = "") -> dict[str, Any]:
    """0.3 state (no `version`) -> v2. Sessions are dropped on purpose (fresh sessions)."""
    data = empty_state(agent_id, runtime_id)
    for old_key, new_key in _LEGACY_KEYS.items():
        if old_key in legacy and legacy[old_key] is not None:
            data[new_key] = copy.deepcopy(legacy[old_key])
    data["migratedFrom"] = {"version": 1, "at": utc_now_iso(),
                            "droppedSessions": len(legacy.get("sessions") or {})}
    return data


def _read_json(path: Path) -> Optional[dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        try:
            os.replace(path, path.with_name(path.name + ".corrupt"))
        except OSError:
            pass
        return None
    return data if isinstance(data, dict) else None


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if path.exists():
        try:
            os.replace(path, path.with_name(path.name + ".bak"))
        except OSError:
            pass
    os.replace(tmp, path)


class BridgeState:
    """The persisted per-agent state. Implements interfaces.SessionStore and TurnStore.

    W4 reads/writes the Emperor-side sections (`seen`, `lastSeenAt`, `directThreads`, `loopGuard`,
    `objective`, `retries`) through `data` and calls `save()`.
    """

    def __init__(self, path: Path, data: dict[str, Any]) -> None:
        self.path = Path(path)
        self.data = data
        self.data.setdefault("threads", {})
        self.data.setdefault("turns", {})
        self._lock = asyncio.Lock()
        self._dirty = False

    # ---- load / save ----------------------------------------------------------------------

    @classmethod
    def load(cls, path: Path, *, legacy_path: Optional[Path] = None, agent_id: str = "",
             runtime_id: str = "") -> "BridgeState":
        path = Path(path)
        for candidate in (path, path.with_name(path.name + ".bak")):
            data = _read_json(candidate)
            if data is not None and data.get("version") == STATE_VERSION:
                if agent_id and data.get("agentId") not in ("", None, agent_id):
                    raise ValueError(f"{path} belongs to agent {data.get('agentId')}, not {agent_id}")
                data["agentId"] = agent_id or data.get("agentId", "")
                if runtime_id:
                    data["runtimeId"] = runtime_id
                return cls(path, data)
            if data is not None and "version" not in data:
                return cls._imported(path, data, agent_id, runtime_id)
        legacy = _read_json(Path(legacy_path)) if legacy_path else None
        if legacy is not None and "version" not in legacy:
            return cls._imported(path, legacy, agent_id, runtime_id)
        state = cls(path, empty_state(agent_id, runtime_id))
        state._dirty = True
        return state

    @classmethod
    def _imported(cls, path: Path, legacy: Mapping[str, Any], agent_id: str, runtime_id: str) -> "BridgeState":
        state = cls(path, migrate_legacy(legacy, agent_id, runtime_id))
        state._dirty = True
        return state

    def mark_dirty(self) -> None:
        self._dirty = True

    def save_sync(self) -> None:
        _write_atomic(self.path, json.dumps(self.data, indent=1, ensure_ascii=False))
        self._dirty = False

    async def save(self) -> None:
        async with self._lock:
            text = json.dumps(self.data, indent=1, ensure_ascii=False)
            await asyncio.to_thread(_write_atomic, self.path, text)
            self._dirty = False

    async def save_if_dirty(self) -> None:
        if self._dirty:
            await self.save()

    # ---- threads (SessionStore) -----------------------------------------------------------

    def get_thread(self, thread_id: str) -> Optional[ThreadSession]:
        raw = self.data["threads"].get(thread_id)
        if not isinstance(raw, dict) or not raw.get("createParams"):
            return None
        values = {attr: raw.get(key) for attr, key in _THREAD_FIELDS.items() if key in raw}
        values.setdefault("generation", 1)
        values.setdefault("policy_hash", "")
        values["last_seq"] = int(values.get("last_seq") or 0)
        values["revision"] = int(values.get("revision") or 0)
        values["execution_generation"] = int(values.get("execution_generation") or 0)
        return ThreadSession(thread_id=thread_id, **values)

    def put_thread(self, session: ThreadSession) -> None:
        raw = self.data["threads"].setdefault(session.thread_id, {})
        for attr, key in _THREAD_FIELDS.items():
            raw[key] = getattr(session, attr)
        self._dirty = True

    def all_threads(self) -> list[ThreadSession]:
        return [s for s in (self.get_thread(t) for t in list(self.data["threads"])) if s is not None]

    def prune_threads(self, older_than_days: int = 30, *, keep: set[str] = frozenset()) -> list[str]:
        """Drop thread records idle longer than N days (they regenerate as a new generation)."""
        cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
        busy = {r.get("threadId") for r in self.data["turns"].values()}
        dropped = []
        for thread_id, raw in list(self.data["threads"].items()):
            if thread_id in keep or thread_id in busy:
                continue
            last = _parse_iso(raw.get("lastTurnAt") or raw.get("generationStartedAt"))
            if last is not None and last < cutoff:
                # Keep the generation counter so a fresh session never reuses a request_id.
                self.data["threads"][thread_id] = {"generation": raw.get("generation", 1), "pruned": True}
                dropped.append(thread_id)
        if dropped:
            self._dirty = True
        return dropped

    def generation_floor(self, thread_id: str) -> int:
        raw = self.data["threads"].get(thread_id) or {}
        return int(raw.get("generation") or 0)

    # ---- turns (TurnStore) ----------------------------------------------------------------

    def get_turn(self, submission_id: str) -> Optional[dict[str, Any]]:
        return self.data["turns"].get(submission_id)

    def put_turn(self, submission_id: str, record: dict[str, Any]) -> None:
        self.data["turns"][submission_id] = record
        self._dirty = True

    def drop_turn(self, submission_id: str) -> None:
        if self.data["turns"].pop(submission_id, None) is not None:
            self._dirty = True

    def open_turns(self) -> dict[str, dict[str, Any]]:
        return {k: v for k, v in self.data["turns"].items() if v.get("status") != "delivered"}


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def load(path: Path, **kwargs: Any) -> BridgeState:
    """Doc signature (section 5.1)."""
    return BridgeState.load(path, **kwargs)
