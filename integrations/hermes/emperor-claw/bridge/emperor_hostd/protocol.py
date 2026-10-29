"""Host protocol 1 (server side: src/lib/runtime-hosts/protocol.ts).

Host -> server: hello, inventory, heartbeat, ack, progress, result.
Server -> host: welcome, command, inventory_request.

Every outgoing frame passes through :class:`Redactor`: API keys and tokens never leave the host,
even when one ends up in a log line or a bridge's lastError.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional

CLOSE_PROTOCOL_ERROR = 4400
#: Emperor revoked this host (only ever sent after a successful upgrade): the one permanent stop.
CLOSE_REVOKED = 4401
#: The hello came from a machine whose fingerprint does not match the paired one: retry slowly.
CLOSE_FINGERPRINT = 4403
CLOSE_REPLACED = 4409
CLOSE_RATE_LIMITED = 4429

#: sysexits EX_CONFIG: the unit has RestartPreventExitStatus=78, so a revoked host stays down.
EXIT_REVOKED = 78
EXIT_CONFIG = 78

LOG_TAIL_MAX = 8 * 1024
LINE_MAX = 1000

_SECRET_PATTERNS = (
    re.compile(r"\bech?_[A-Za-z0-9_]{16,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*\S+"),
)
SECRET_KEY_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)", re.I)


class Redactor:
    """Removes known secret values (collected from the .env files it read) and secret-shaped text."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets: set[str] = set()
        self.add(secrets)

    def add(self, secrets: Iterable[str]) -> None:
        for value in secrets:
            value = (value or "").strip().strip("'\"")
            if len(value) >= 6:
                self._secrets.add(value)

    def add_env(self, values: Mapping[str, str]) -> None:
        """Every value of a key that looks like a credential (…_API_KEY, …_TOKEN, …)."""
        self.add(v for k, v in values.items() if SECRET_KEY_RE.search(k))

    def text(self, value: str) -> str:
        out = value
        for secret in sorted(self._secrets, key=len, reverse=True):
            if secret in out:
                out = out.replace(secret, "[redacted]")
        out = _SECRET_PATTERNS[0].sub("[redacted]", out)
        out = _SECRET_PATTERNS[1].sub("[redacted]", out)
        out = _SECRET_PATTERNS[2].sub(lambda m: f"{m.group(1)} [redacted]", out)
        out = _SECRET_PATTERNS[3].sub(lambda m: f"{m.group(1)}=[redacted]", out)
        return out

    def scrub(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, Mapping):
            return {k: self.scrub(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.scrub(v) for v in value]
        return value


def encode(frame: Mapping[str, Any], redactor: Optional[Redactor] = None) -> str:
    """One outgoing frame as JSON text (redacted)."""
    data = redactor.scrub(frame) if redactor else dict(frame)
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def decode(raw: Any) -> Optional[dict[str, Any]]:
    """One incoming server frame; None when it is not a JSON object with a type."""
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("type"), str):
        return None
    return data


_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean_text(text: str) -> str:
    """Terminal output without ANSI escapes or control characters (newlines and tabs kept)."""
    return _CONTROL_RE.sub("", _ANSI_RE.sub("", text.replace("\r\n", "\n")))


def fit_json(text: str, limit: int = LOG_TAIL_MAX) -> str:
    """The END of text, cut so its JSON encoding stays within ``limit`` bytes (escaping can grow it)."""
    while text and len(json.dumps(text, ensure_ascii=False).encode("utf-8")) > limit:
        overflow = len(json.dumps(text, ensure_ascii=False).encode("utf-8")) - limit
        text = text[max(1, overflow // 2):]
    return text


def clip_tail(text: str, limit: int = LOG_TAIL_MAX) -> str:
    """The last ``limit`` bytes of text (UTF-8 safe)."""
    raw = text.encode("utf-8", "replace")
    if len(raw) <= limit:
        return text
    return raw[-limit:].decode("utf-8", "ignore")


@dataclass
class Welcome:
    host_id: str
    protocol: int
    heartbeat_sec: int = 30
    inventory_sec: int = 300
    upgrade_required: bool = False
    server_version: str = ""
    bridge: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def parse(cls, frame: Mapping[str, Any]) -> "Welcome":
        def num(key: str, default: int, low: int, high: int) -> int:
            try:
                return max(low, min(high, int(frame.get(key, default))))
            except (TypeError, ValueError):
                return default
        return cls(host_id=str(frame.get("hostId", "")), protocol=num("protocol", 1, 0, 1000),
                   heartbeat_sec=num("heartbeatSec", 30, 5, 600), inventory_sec=num("inventorySec", 300, 30, 3600),
                   upgrade_required=bool(frame.get("upgradeRequired")), server_version=str(frame.get("serverVersion", "")),
                   bridge=dict(frame.get("bridge") or {}))


def ack(job_id: str, accepted: bool, reason: Optional[str] = None) -> dict[str, Any]:
    frame: dict[str, Any] = {"type": "ack", "jobId": job_id, "accepted": accepted}
    if reason:
        frame["reason"] = reason[:200]
    return frame


def progress(job_id: str, seq: int, line: str, step: Optional[str] = None) -> dict[str, Any]:
    frame: dict[str, Any] = {"type": "progress", "jobId": job_id, "seq": seq, "line": clean_text(line)[:LINE_MAX]}
    if step:
        frame["step"] = clean_text(step)[:300]
    return frame


def result(job_id: str, ok: bool, exit_code: Optional[int], summary: str, log_tail: str = "",
           error_code: Optional[str] = None, units: Optional[list[str]] = None,
           token_sha256: Optional[str] = None) -> dict[str, Any]:
    # The whole frame must stay under the server's 32 KiB limit for non-inventory frames:
    # an 8 KiB budget for the tail's JSON encoding, the rest is small and bounded.
    frame: dict[str, Any] = {"type": "result", "jobId": job_id, "ok": ok, "exitCode": exit_code,
                             "summary": clean_text(summary)[:500], "logTail": fit_json(clean_text(log_tail))}
    if error_code:
        frame["errorCode"] = error_code[:80]
    if units:
        frame["units"] = list(units)[:20]
    if token_sha256 and re.fullmatch(r"[0-9a-f]{64}", token_sha256):
        # Which minted token the new profile holds (Emperor keeps that one, revokes any other).
        frame["tokenSha256"] = token_sha256
    return frame
