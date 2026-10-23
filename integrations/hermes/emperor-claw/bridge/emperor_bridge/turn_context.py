"""The turn file the plugin reads (section 5.4, plugin contract from W5).

Path `<profile_home>/emperor/turns/<threadId>.json`, mode 0600, written atomically before
`prompt.submit` and removed after the turn settles. The plugin matches it against the session's
`EMPEROR_THREAD_ID` / `EMPEROR_SESSION_GEN` (from `bound_client_env()`) and ignores it after
`expiresAt`. Required: messageId, sessionGeneration, expiresAt. Optional: threadId, runId,
submissionId.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")  # same rule as the plugin


@dataclass(frozen=True)
class TurnContext:
    thread_id: str
    session_generation: int
    message_id: str
    run_id: str = ""
    submission_id: str = ""
    message_ids: tuple[str, ...] = ()
    expires_at: float = field(default=0.0)  # epoch seconds

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "messageId": self.message_id,
            "sessionGeneration": str(self.session_generation),
            "expiresAt": datetime.fromtimestamp(self.expires_at, timezone.utc).isoformat().replace("+00:00", "Z"),
            "threadId": self.thread_id,
        }
        if self.run_id:
            out["runId"] = self.run_id
        if self.submission_id:
            out["submissionId"] = self.submission_id
        if self.message_ids:
            out["messageIds"] = list(self.message_ids)
        return out


def turn_file_path(profile_home: Path, thread_id: str) -> Path:
    if not SAFE_ID.match(thread_id or ""):
        raise ValueError(f"unsafe thread id for a turn file: {thread_id!r}")
    return Path(profile_home) / "emperor" / "turns" / f"{thread_id}.json"


def write(profile_home: Path, thread_id: str, ctx: TurnContext) -> Path:
    path = turn_file_path(profile_home, thread_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(ctx.to_json(), handle)
    os.replace(tmp, path)
    return path


def read(profile_home: Path, thread_id: str) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(turn_file_path(profile_home, thread_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def clear(profile_home: Path, thread_id: str, submission_id: Optional[str] = None) -> bool:
    """Remove the file. With `submission_id`, only when it still belongs to that submission."""
    try:
        path = turn_file_path(profile_home, thread_id)
    except ValueError:
        return False
    if submission_id is not None:
        current = read(profile_home, thread_id)
        if current is not None and current.get("submissionId") not in (None, submission_id):
            return False
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def expiry_from_now(ttl_s: float) -> float:
    return time.time() + ttl_s
