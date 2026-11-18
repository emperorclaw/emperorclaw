"""Deliver an agent's Emperor secrets into the profile ``.env`` that Hermes re-reads every turn.

The bridge fetches ``/api/mcp/runtime/env-vars`` with the profile's own runtime token and rewrites
only the managed block in ``<profile>/.env``. Every line outside the block is preserved byte for
byte. HTTP and TLS follow the rest of the bridge (stdlib urllib, one short timeout); a transient
failure never removes secrets that are already in the file. Nothing here restarts Hermes.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

from .events import register_secrets
from .version import USER_AGENT

MANAGED_START = "# >>> emperor-claw managed secrets (do not edit) >>>"
MANAGED_END = "# <<< emperor-claw managed secrets <<<"

API_PATH = "/api/mcp/runtime/env-vars"
SYNC_TIMEOUT_S = 15.0
_SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: a 3xx must never forward the Authorization header to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


# One module-level opener: the stock urlopen follows redirects and would carry the token along.
_OPENER = urllib.request.build_opener(_NoRedirectHandler())


@dataclass(frozen=True)
class FetchResult:
    """One request's outcome: ok, unchanged, disabled (stop until restart) or retry."""

    kind: str
    etag: str = ""
    secrets: tuple[dict[str, Any], ...] = ()
    failed: tuple[str, ...] = ()
    reason: str = ""


@dataclass(frozen=True)
class ApplyResult:
    """What apply_block did: whether it wrote, and which names it skipped."""

    written: bool
    skipped: tuple[str, ...] = ()
    names: tuple[str, ...] = ()


@dataclass
class SyncState:
    """In-memory only: the last ETag and the block hash remembered for the next pass."""

    etag: str = ""
    block_hash: Optional[str] = None
    disabled: bool = False


def fetch_secrets(base_url: str, agent_token: str, etag: str, *, opener: Any = None,
                  timeout: float = SYNC_TIMEOUT_S) -> FetchResult:
    """GET the runtime secrets with the profile's token; never raises for an expected answer."""
    if not agent_token:
        return FetchResult("disabled", reason="no agent token")
    url = base_url.rstrip("/") + API_PATH
    headers = {"Authorization": f"Bearer {agent_token}", "Accept": "application/json",
               "User-Agent": USER_AGENT}
    if etag:
        headers["If-None-Match"] = etag
    request = urllib.request.Request(url, headers=headers, method="GET")
    open_url = opener or _OPENER.open
    try:
        with open_url(request, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            body = response.read().decode("utf-8", errors="replace")
            if status == 304:
                return FetchResult("unchanged", etag=etag)
            if status == 404:
                return FetchResult("disabled", reason="runtime secrets endpoint not available")
            if status == 403 and "agent_bound_token_required" in body:
                return FetchResult("disabled", reason="agent_bound_token_required")
            return _parse_success(body, _header(response, "ETag"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        if exc.code == 304:
            return FetchResult("unchanged", etag=etag)
        if exc.code == 404:
            return FetchResult("disabled", reason="runtime secrets endpoint not available")
        if exc.code == 403 and "agent_bound_token_required" in body:
            return FetchResult("disabled", reason="agent_bound_token_required")
        return FetchResult("retry", reason=f"HTTP {exc.code}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return FetchResult("retry", reason=str(exc))


def _header(response: Any, name: str) -> str:
    headers = getattr(response, "headers", None)
    if headers is None:
        return ""
    for key, value in headers.items():
        if str(key).lower() == name.lower():
            return str(value)
    return ""


def _parse_success(body: str, etag: str) -> FetchResult:
    try:
        payload = json.loads(body) if body else {}
    except ValueError:
        return FetchResult("retry", reason="invalid JSON")
    if not isinstance(payload, Mapping):
        return FetchResult("retry", reason="unexpected payload")
    secrets = payload.get("secrets")
    # An empty list is a valid "no secrets"; a missing or non-list value is not: deleting the
    # managed block on a malformed answer would silently drop every secret.
    if not isinstance(secrets, list):
        return FetchResult("retry", reason="unexpected payload")
    failed = payload.get("failed")
    rows = tuple(dict(row) for row in secrets if isinstance(row, Mapping))
    names = tuple(str(name) for name in failed) if isinstance(failed, list) else ()
    return FetchResult("ok", etag=etag or str(payload.get("etag") or ""), secrets=rows, failed=names)


def _secret_pairs(secrets: Iterable[Any] | Mapping[str, Any]) -> list[tuple[str, str]]:
    if isinstance(secrets, Mapping):
        items: Iterable[tuple[Any, Any]] = secrets.items()
    else:
        items = ((row.get("name"), row.get("value")) for row in secrets)
    pairs: list[tuple[str, str]] = []
    for name, value in items:
        text_name = str(name or "")
        if not text_name:
            continue
        pairs.append((text_name, "" if value is None else str(value)))
    pairs.sort(key=lambda pair: pair[0])
    return pairs


def quote_value(value: str) -> str:
    """Quote so python-dotenv reads the exact value back.

    Single quotes (no escape processing) only when the value has neither a quote nor a backslash;
    otherwise double quotes with the two escapes the real parser honours.
    """
    if "'" not in value and "\\" not in value:
        return f"'{value}'"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _build_block(secrets: Iterable[Any] | Mapping[str, Any],
                 extra_lines: Sequence[str] = ()) -> tuple[Optional[str], tuple[str, ...], tuple[str, ...]]:
    lines: list[str] = []
    skipped: list[str] = []
    names: list[str] = []
    for name, value in _secret_pairs(secrets):
        if not _SECRET_NAME_RE.fullmatch(name):
            skipped.append(name)
            continue
        # A value must be one dotenv line. splitlines() also splits on \r, \x0b, \x0c,
        # \x1c-\x1e, U+0085, U+2028 and U+2029, any of which could forge the end marker.
        # dotenv expands "${NAME}" even inside quotes, so such a value cannot be written faithfully.
        # A trailing backslash escapes the closing quote in python-dotenv (in either quote style),
        # which makes the parser run on into the following lines.
        if len(value.splitlines()) != 1 or "${" in value or value.endswith("\\"):
            skipped.append(name)
            continue
        lines.append(f"{name}={quote_value(value)}")
        names.append(name)
    lines.extend(extra_lines)
    if not lines:
        return None, tuple(skipped), ()
    return "\n".join([MANAGED_START, *lines, MANAGED_END]) + "\n", tuple(skipped), tuple(names)


def render_block(secrets: Iterable[Any] | Mapping[str, Any]) -> str:
    """The managed block text (names sorted); empty when there is nothing to write."""
    return _build_block(secrets)[0] or ""


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _block_span(lines: Sequence[str]) -> Optional[tuple[int, int]]:
    start = next((i for i, line in enumerate(lines) if line.rstrip("\r\n") == MANAGED_START), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].rstrip("\r\n") == MANAGED_END), None)
    if end is not None:
        return start, end
    # A block that lost its end marker stops at the first blank or comment line, so a damaged
    # file never has unrelated settings below the marker treated as ours and deleted.
    last = start
    for i in range(start + 1, len(lines)):
        text = lines[i].strip()
        if not text or text.startswith("#"):
            break
        last = i
    return start, last


def block_text(text: str) -> str:
    """The managed block, markers included; empty when the file has none."""
    lines = text.splitlines(keepends=True)
    span = _block_span(lines)
    return "".join(lines[span[0]:span[1] + 1]) if span else ""


def block_hash(text: str) -> str:
    return hashlib.sha256(block_text(text).encode("utf-8")).hexdigest()


def _defined_keys(lines: Sequence[str]) -> set[str]:
    keys: set[str] = set()
    for line in lines:
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key = text.split("=", 1)[0].strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        keys.add(key)
    return keys


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _managed_lines(lines: Sequence[str], span: Optional[tuple[int, int]]) -> dict[str, str]:
    """The raw line for each key already inside the managed block."""
    raw: dict[str, str] = {}
    if span is None:
        return raw
    for line in lines[span[0]:span[1] + 1]:
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key = text.split("=", 1)[0].strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        raw.setdefault(key, line.rstrip("\r\n"))
    return raw


def apply_block(env_path: Path | str, secrets: Iterable[Any] | Mapping[str, Any],
                keep_names: Sequence[str] = ()) -> ApplyResult:
    """Rewrite only the managed block; never create the profile .env.

    ``keep_names`` are secrets the server could not decrypt: their existing block lines are carried
    over unchanged instead of being deleted by an apparently successful, incomplete answer.
    """
    path = Path(env_path)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ApplyResult(False)
    lines = raw.splitlines(keepends=True)
    span = _block_span(lines)
    outside = lines[:span[0]] + lines[span[1] + 1:] if span else lines
    defined = _defined_keys(outside)

    pairs = _secret_pairs(secrets)
    kept: list[dict[str, str]] = []
    skipped: list[str] = []
    for name, value in pairs:
        if name in defined:
            skipped.append(name)
            continue
        kept.append({"name": name, "value": value})

    existing = _managed_lines(lines, span)
    present = {name for name, _ in pairs}
    carried: list[str] = []
    for name in keep_names:
        if name in present:
            continue
        line = existing.get(name)
        if line is not None:
            carried.append(line)

    rendered, newline_skipped, names = _build_block(kept, tuple(carried))
    skipped.extend(newline_skipped)

    before = lines[:span[0]] if span else lines
    after = lines[span[1] + 1:] if span else []
    if rendered is None:
        new_text = "".join([*before, *after])
    else:
        if not span and before and not before[-1].endswith(("\n", "\r")):
            before = [*before[:-1], before[-1] + "\n"]
        new_text = "".join([*before, *rendered.splitlines(keepends=True), *after])

    if new_text != raw:
        _atomic_write(path, new_text)
        return ApplyResult(True, tuple(skipped), names)
    return ApplyResult(False, tuple(skipped), names)


def managed_values(text: str) -> dict[str, str]:
    """Every key/value inside the managed block, whatever the key is named."""
    values: dict[str, str] = {}
    for line in block_text(text).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1].replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\")
        values[key] = value
    return values


def sync_once(state: SyncState, *, base_url: str, agent_token: str, env_path: Path | str,
              fetch: Any = fetch_secrets, logger: Optional[logging.Logger] = None) -> str:
    """One synchronous pass. Returns ok, unchanged, disabled, retry, skipped or missing."""
    log = logger or logging.getLogger("emperor_bridge.secrets")
    if state.disabled:
        return "disabled"
    if not agent_token:
        return "skipped"
    path = Path(env_path)
    current_text = _read_text(path)
    current_hash = block_hash(current_text)
    use_etag = state.etag if state.block_hash is not None and current_hash == state.block_hash else ""
    result = fetch(base_url, agent_token, use_etag)
    if result.kind == "disabled":
        state.disabled = True
        log.info("agent secrets sync disabled for %s: %s", path.parent.name, result.reason or "not available")
        return "disabled"
    if result.kind == "retry":
        log.debug("agent secrets sync will retry for %s: %s", path.parent.name, result.reason)
        return "retry"
    if result.kind == "unchanged":
        return "unchanged"
    if not path.exists():
        return "missing"

    values = [row.get("value") for row in result.secrets]
    register_secrets(value for value in values if value is not None)
    applied = apply_block(path, result.secrets, keep_names=result.failed)
    state.etag = result.etag
    state.block_hash = block_hash(_read_text(path))
    details = f"{len(applied.names)} applied"
    if applied.skipped:
        details += f", {len(applied.skipped)} skipped ({', '.join(applied.skipped)})"
    if result.failed:
        details += f", {len(result.failed)} unreadable ({', '.join(result.failed)})"
    log.info("agent secrets synced for %s: %s", path.parent.name, details)
    return "ok"


async def sync_loop(cfg: Any, logger: logging.Logger, *, fetch: Any = fetch_secrets) -> None:
    """One pass at bridge start, then every EMPEROR_CLAW_SECRETS_SYNC_SECONDS (0 disables)."""
    if cfg.secrets_sync_s <= 0:
        return
    state = SyncState()
    env_path = cfg.profile_home / ".env"
    while True:
        try:
            outcome = await asyncio.to_thread(
                sync_once, state, base_url=cfg.api_url, agent_token=cfg.api_token, env_path=env_path,
                fetch=fetch, logger=logger)
            if outcome == "disabled":
                return
        except Exception as exc:  # a sync failure must never take the bridge down
            logger.warning("agent secrets sync failed for %s: %s", cfg.profile_name, exc)
        await asyncio.sleep(cfg.secrets_sync_s)
