from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


TOOLSET = "emperor-claw"
PLUGIN_VERSION = "0.9.0"
DEFAULT_API_URL = "https://emperorclaw.malecu.eu"
CREDENTIAL_KEYS = ("EMPEROR_CLAW_API_URL", "EMPEROR_CLAW_API_TOKEN", "EMPEROR_CLAW_AGENT_ID", "EMPEROR_CLAW_AGENT_NAME")


# ---- Session binding --------------------------------------------------------
# One gateway process can serve several sessions at once, and in shared mode
# several agents (profiles). Per-session data therefore never comes from
# os.environ, which is process-wide: the bridge passes it as client_env on
# session.create, and Hermes exposes that to plugin code only through
# bound_client_env() (a per-turn ContextVar). Names starting with HERMES_ and
# secret-looking names (*_TOKEN, *_KEY) are dropped from client_env, so the
# token itself is read from the bound profile's .env.


def _bound_env() -> Dict[str, str]:
    """The client_env of the session running this tool call, or {} outside one."""
    try:
        from agent.session_client_env import bound_client_env
    except Exception:
        return {}
    try:
        bound = bound_client_env()
    except Exception:
        return {}
    return {str(k): str(v) for k, v in dict(bound).items()} if bound else {}


def _profile_home(bound: Dict[str, str]) -> Path | None:
    raw = (bound.get("EMPEROR_PROFILE_HOME") or "").strip()
    return Path(raw) if raw else None


_DOTENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
_dotenv_cache: Dict[str, tuple[tuple[int, int], Dict[str, str]]] = {}
_dotenv_lock = threading.Lock()


def _parse_dotenv(text: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = _DOTENV_LINE.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        values[key] = value
    return values


def _read_dotenv(path: Path) -> Dict[str, str]:
    """Parse a profile .env, cached by (mtime, size) so a token rotation lands on the next call."""
    try:
        stat = path.stat()
    except OSError:
        return {}
    stamp = (stat.st_mtime_ns, stat.st_size)
    key = str(path)
    with _dotenv_lock:
        cached = _dotenv_cache.get(key)
        if cached and cached[0] == stamp:
            return cached[1]
    try:
        values = _parse_dotenv(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return {}
    with _dotenv_lock:
        _dotenv_cache[key] = (stamp, values)
    return values


def _hermes_root() -> Path:
    env = os.environ
    return Path(env.get("EMPEROR_HERMES_ROOT") or env.get("HOME") or Path.home()) / ".hermes"


def _profile_env_count() -> int:
    """How many profile .env files live under the Hermes root."""
    profiles = _hermes_root() / "profiles"
    if not profiles.is_dir():
        return 0
    try:
        return sum(1 for entry in profiles.iterdir() if (entry / ".env").is_file())
    except OSError:
        return 0


def _process_credentials_allowed() -> bool:
    """May an unbound call use this process's os.environ credentials? (M6)

    EMPEROR_GATEWAY_TOPOLOGY (standalone|shared), set in the gateway's own environment by the
    installer's systemd units and the managed supervisor, decides. Without it (a hand-started
    gateway): a standalone gateway runs as `hermes -p <profile>`: HERMES_HOME is that profile's home and its
    os.environ was loaded from that profile's .env, so the fallback is unambiguous. A shared
    gateway runs on the default home and serves several profiles in one process: os.environ
    belongs to no agent there, so the fallback is refused unless the operator opts in with
    EMPEROR_ALLOW_PROCESS_CREDENTIALS=1.
    """
    if os.environ.get("EMPEROR_ALLOW_PROCESS_CREDENTIALS") == "1":
        return True
    topology = (os.environ.get("EMPEROR_GATEWAY_TOPOLOGY") or "").strip().lower()
    if topology:  # set by the gateway's systemd unit / the managed supervisor: authoritative
        return topology != "shared"
    home = (os.environ.get("HERMES_HOME") or "").strip()
    if home and Path(home).parent.name == "profiles":
        return True
    return _profile_env_count() <= 1


def _creds() -> Dict[str, Any]:
    """Emperor credentials for the session running this tool call.

    An Emperor session (bound EMPEROR_PROFILE_HOME) uses only its own profile's
    .env, never the process environment, so a shared gateway cannot hand one
    agent another agent's token. Anything else (a human on the CLI, a
    non-Emperor session) falls back to os.environ only when that is unambiguous
    (see _process_credentials_allowed).
    """
    bound = _bound_env()
    home = _profile_home(bound)
    if home is not None:
        source_path = home / ".env"
        values = dict(_read_dotenv(source_path))
        values.setdefault("EMPEROR_CLAW_AGENT_ID", bound.get("EMPEROR_AGENT_ID", ""))
        source = str(source_path)
    elif not _process_credentials_allowed():
        values = {}
        source = "environment (refused: shared gateway with multiple profiles)"
    else:
        values = {k: os.environ.get(k, "") for k in CREDENTIAL_KEYS}
        source = "environment"
    return {
        "url": (values.get("EMPEROR_CLAW_API_URL") or "").strip().rstrip("/") or DEFAULT_API_URL,
        "token": (values.get("EMPEROR_CLAW_API_TOKEN") or "").strip(),
        "agent_ref": (values.get("EMPEROR_CLAW_AGENT_ID") or "").strip()
        or (values.get("EMPEROR_CLAW_AGENT_NAME") or "").strip(),
        "source": source,
    }


def _missing_token_error(creds: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": False, "error": f"Emperor credentials are not configured: EMPEROR_CLAW_API_TOKEN is not set in {creds['source']}"}


def _token() -> str:
    return _creds()["token"]


def _agent_ref() -> str:
    return _creds()["agent_ref"]


def _available() -> bool:
    # Inside an Emperor session the answer is exact. Outside one (gateway boot
    # in shared mode has no single token) the tools stay listed and a call
    # without credentials returns a clear error instead.
    if _profile_home(_bound_env()) is None:
        return True
    return bool(_token())


# ---- Turn context -----------------------------------------------------------
# The bridge writes <profileHome>/emperor/turns/<threadId>.json (0600, atomic)
# before prompt.submit and deletes it after the turn settles. It names the
# Emperor message the running turn answers. A file from another session
# generation or past its expiresAt is stale and is never used.

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _parse_expiry(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
        return seconds / 1000.0 if seconds > 1e11 else seconds
    if isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.timestamp()
    return None


def _turn_context() -> Dict[str, Any] | None:
    """The Emperor turn this tool call belongs to, or None when there is no valid one."""
    bound = _bound_env()
    home = _profile_home(bound)
    thread_id = (bound.get("EMPEROR_THREAD_ID") or "").strip()
    generation = (bound.get("EMPEROR_SESSION_GEN") or "").strip()
    if home is None or not thread_id or not generation or not _SAFE_ID.match(thread_id):
        return None
    try:
        data = json.loads((home / "emperor" / "turns" / f"{thread_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if str(data.get("sessionGeneration", "")).strip() != generation:
        return None
    file_thread = data.get("threadId")
    if file_thread not in (None, "") and str(file_thread) != thread_id:
        return None
    expires = _parse_expiry(data.get("expiresAt"))
    if expires is None or expires <= time.time():
        return None
    message_id = str(data.get("messageId") or "").strip()
    if not message_id:
        return None
    return {
        "threadId": thread_id,
        "threadType": (bound.get("EMPEROR_THREAD_TYPE") or "").strip() or None,
        "messageId": message_id,
        "runId": str(data.get("runId") or "").strip() or None,
        "submissionId": str(data.get("submissionId") or "").strip() or None,
        "sessionGeneration": generation,
        "agentId": (bound.get("EMPEROR_AGENT_ID") or "").strip() or None,
    }


DEFAULT_TOOL_RESULT_MAX_CHARS = 12000
TRUNCATION_HINT = "narrow with filters/limit or fetch one item by id"
# Shrink passes, mildest first: (max string chars, max list items). Strings
# lose their tails before lists lose items.
_FIT_STEPS: tuple[tuple[int, int | None], ...] = (
    (2000, None), (1000, None), (500, None),
    (500, 50), (500, 30), (500, 20), (500, 10),
    (300, 10), (300, 5), (160, 5), (160, 3), (160, 1),
)
# Lists under these keys are oldest-first (thread messages, task events), so
# a shortened one keeps its newest items. Every other list keeps its first.
CHRONOLOGICAL_KEYS = frozenset({"messages", "events", "history", "timeline"})
# Errors are never dropped; they are only bounded by these (strings, list items).
_ERROR_FIT_STEPS: tuple[tuple[int, int], ...] = ((4000, 50), (1000, 20))
_DROP_MIN_CHARS = 256
_DROP_MAX_ROUNDS = 8
_STUB_SCALAR_MAX_CHARS = 200


def _compact(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _tool_result_budget() -> int:
    raw = os.environ.get("EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS", "").strip()
    if not raw:
        return DEFAULT_TOOL_RESULT_MAX_CHARS
    try:
        return max(int(raw), 0)
    except ValueError:
        return DEFAULT_TOOL_RESULT_MAX_CHARS


def _cut_string(value: str, cap: int) -> str:
    if len(value) <= cap:
        return value
    return value[:cap] + f"…[+{len(value) - cap} chars]"


def _shrink(node: Any, str_cap: int, list_cap: int | None) -> Any:
    """Return a copy with long strings cut and long lists shortened.

    A shortened list keeps valid JSON and says so: inside an object the list
    stays at its key and the object gains `_truncated` {key: {returned, total}}
    plus `_hint`, merged into any `_truncated` already there so an earlier
    total survives; a list directly inside a list (or at the top) is wrapped
    as {items, truncated, returned, total, hint}. Lists under
    CHRONOLOGICAL_KEYS keep their newest (last) items.
    """
    if isinstance(node, str):
        return _cut_string(node, str_cap)
    if isinstance(node, list):
        items, total = _shrink_list(node, str_cap, list_cap, newest=False)
        if total > len(items):
            return {"items": items, "truncated": True, "returned": len(items), "total": total, "hint": TRUNCATION_HINT}
        return items
    if isinstance(node, dict):
        out: Dict[str, Any] = {}
        cut: Dict[str, Any] = {}
        for key, value in node.items():
            if key in ("_truncated", "_hint"):
                continue
            if isinstance(value, list):
                newest = key in CHRONOLOGICAL_KEYS
                items, total = _shrink_list(value, str_cap, list_cap, newest=newest)
                out[key] = items
                if total > len(items):
                    cut[key] = {"returned": len(items), "total": total}
                    if newest:
                        cut[key]["kept"] = "newest"
            else:
                out[key] = _shrink(value, str_cap, list_cap)
        earlier = node.get("_truncated") if isinstance(node.get("_truncated"), dict) else {}
        if earlier or cut:
            merged: Dict[str, Any] = dict(earlier)
            for key, entry in cut.items():
                prior = earlier.get(key) if isinstance(earlier.get(key), dict) else {}
                total = max(int(prior.get("total") or 0), entry["total"])
                merged[key] = {**prior, **entry, "total": total}
            out["_truncated"] = merged
            out["_hint"] = node.get("_hint") or TRUNCATION_HINT
        return out
    return node


def _shrink_list(items: list, str_cap: int, list_cap: int | None, newest: bool) -> tuple[list, int]:
    if list_cap is None or len(items) <= list_cap:
        kept = items
    else:
        kept = items[-list_cap:] if newest else items[:list_cap]
    return [_shrink(item, str_cap, list_cap) for item in kept], len(items)


def _measure(node: Any, depth: int, parent: Any, key: Any, found: list) -> int:
    """Compact-JSON length of `node`, computed in a single pass.

    Appends to `found` every bulky container (at least _DROP_MIN_CHARS) that
    holds no bulky container itself, as (size, depth, parent, key).
    """
    if isinstance(node, dict):
        size = 2 + max(len(node) - 1, 0)
        has_bulky_child = False
        for k, value in node.items():
            child = _measure(value, depth + 1, node, k, found)
            size += len(_compact(str(k))) + 1 + child
            has_bulky_child = has_bulky_child or (isinstance(value, (dict, list)) and child >= _DROP_MIN_CHARS)
    elif isinstance(node, list):
        size = 2 + max(len(node) - 1, 0)
        has_bulky_child = False
        for index, value in enumerate(node):
            child = _measure(value, depth + 1, node, index, found)
            size += child
            has_bulky_child = has_bulky_child or (isinstance(value, (dict, list)) and child >= _DROP_MIN_CHARS)
    else:
        return len(_compact(node))
    if parent is not None and size >= _DROP_MIN_CHARS and not has_bulky_child:
        found.append((size, depth, parent, key))
    return size


def _drop_bulky(node: Any, budget: int) -> Any:
    """Last resort: replace bulky containers with a size marker.

    Each round measures the tree once and drops the largest innermost bulky
    containers until the result fits; their parents become candidates in the
    next round. After _DROP_MAX_ROUNDS the payload collapses to a stub that
    keeps only short top-level scalars.
    """
    for _ in range(_DROP_MAX_ROUNDS):
        found: list = []
        total = _measure(node, 0, None, None, found)
        if total <= budget:
            return node
        if not found:
            break
        # Largest first; ties resolve by depth, then by tree order.
        order = sorted(range(len(found)), key=lambda i: (-found[i][0], found[i][1], i))
        for index in order:
            size, _, parent, key = found[index]
            stub = f"…[omitted {size} chars; {TRUNCATION_HINT}]"
            parent[key] = stub
            total -= size - len(_compact(stub))
            if total <= budget:
                return node
    size = len(_compact(node))
    if size <= budget:
        return node
    stub = f"…[omitted {size} chars; {TRUNCATION_HINT}]"
    if isinstance(node, dict):
        kept = {
            k: v for k, v in node.items()
            if v is None or isinstance(v, (bool, int, float))
            or (isinstance(v, str) and len(v) <= _STUB_SCALAR_MAX_CHARS)
        }
        kept["_omitted"] = stub
        return kept
    return stub


def _fit_error(error: Any, budget_chars: int) -> Any:
    """Bound an error without ever dropping it: only strings and lists shrink."""
    fitted = error
    for str_cap, list_cap in _ERROR_FIT_STEPS:
        fitted = _shrink(error, str_cap, list_cap)
        if len(_compact(fitted)) <= budget_chars:
            break
    return fitted


def _fit(data: Any, budget_chars: int) -> str:
    """Serialize a tool result compactly and bound it to `budget_chars`.

    Deterministic: the same input and budget always give the same output. A
    result that already fits is returned unchanged. A top-level `error` is
    never dropped, only bounded, so a failure stays readable.
    """
    text = _compact(data)
    if budget_chars <= 0 or len(text) <= budget_chars:
        return text

    error_key = isinstance(data, dict) and "error" in data
    error_value = _fit_error(data["error"], budget_chars) if error_key else None
    rest = {k: v for k, v in data.items() if k != "error"} if error_key else data

    def assemble(body: Any) -> Any:
        if not error_key:
            return body
        out = dict(body) if isinstance(body, dict) else {"data": body}
        out["error"] = error_value
        return out

    candidate: Any = rest
    for str_cap, list_cap in _FIT_STEPS:
        candidate = _shrink(rest, str_cap, list_cap)
        text = _compact(assemble(candidate))
        if len(text) <= budget_chars:
            return text

    reserve = len(_compact(assemble({}))) if error_key else 0
    candidate = _drop_bulky(candidate, max(budget_chars - reserve, 0))
    return _compact(assemble(candidate))


def _json(data: Any) -> str:
    return _fit(data, _tool_result_budget())


def _request(method: str, path: str, body: Dict[str, Any] | None = None, query: Dict[str, Any] | None = None, timeout: int = 30) -> Dict[str, Any]:
    creds = _creds()
    token = creds["token"]
    if not token:
        return _missing_token_error(creds)

    clean_path = "/" + str(path or "").lstrip("/")
    if not clean_path.startswith("/api/"):
        clean_path = "/api/mcp" + clean_path

    url = creds["url"] + clean_path
    if query:
        pairs = {k: v for k, v in query.items() if v is not None and v != ""}
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)

    payload = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": f"hermes-emperor-claw-plugin/{PLUGIN_VERSION}",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        headers["Idempotency-Key"] = str(uuid.uuid4())

    req = urllib.request.Request(url, data=payload, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            text = res.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(text) if text else {}
            except json.JSONDecodeError:
                data = {"text": text}
            return {"ok": True, "status": res.status, "data": data}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            data = {"text": text}
        return {"ok": False, "status": exc.code, "error": data}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _multipart_upload(path: str, file_path: str, fields: Dict[str, str], method: str = "POST") -> Dict[str, Any]:
    creds = _creds()
    token = creds["token"]
    if not token:
        return _missing_token_error(creds)
    url = creds["url"] + path
    boundary = uuid.uuid4().hex
    filename = os.path.basename(file_path)
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    try:
        with open(file_path, "rb") as fh:
            file_bytes = fh.read()
    except OSError as exc:
        return {"ok": False, "error": str(exc)}

    parts: list[bytes] = []
    for key, val in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode()
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
        "User-Agent": f"hermes-emperor-claw-plugin/{PLUGIN_VERSION}",
        "Idempotency-Key": str(uuid.uuid4()),
    }
    req = urllib.request.Request(url, data=body, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(text) if text else {}
            except json.JSONDecodeError:
                data = {"text": text}
            return {"ok": True, "status": res.status, "data": data}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            data = {"text": text}
        return {"ok": False, "status": exc.code, "error": data}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def emperor_health(args: Dict[str, Any], **_: Any) -> str:
    return _json(_request("GET", "/runtime/health"))


def emperor_request(args: Dict[str, Any], **_: Any) -> str:
    method = str(args.get("method") or "GET").upper()
    path = str(args.get("path") or "")
    body = args.get("body")
    query = args.get("query")
    if body is not None and not isinstance(body, dict):
        return _json({"error": "body must be an object when provided"})
    if query is not None and not isinstance(query, dict):
        return _json({"error": "query must be an object when provided"})
    # Agents often inline the query string in the path ("/artifacts?kind=x").
    # Split it so defaults merge in and the URL never gets a second "?".
    if "?" in path:
        path, _, inline = path.partition("?")
        merged: Dict[str, Any] = dict(urllib.parse.parse_qsl(inline, keep_blank_values=False))
        merged.update(query or {})
        query = merged
    route = "/" + path.strip("/").removeprefix("api/mcp/")
    if method == "GET" and _ARTIFACT_LIST_PATH.match(route) and not (query or {}).get("limit"):
        # GET /api/mcp/artifacts honors `limit` (server default 100).
        query = {**(query or {}), "limit": DEFAULT_ARTIFACT_LIST_LIMIT}
    result = _request(method, path, body=body, query=query)
    if method == "GET" and _TASK_NOTES_PATH.match(route):
        result = _tail_task_notes(result, (query or {}).get("limit"))
    if (method in _WRITE_METHODS and _TASK_WRITE_PATH.match(route)
            and not _TASK_WORK_SPEC_PATH.match(route) and not args.get("full")):
        result = _task_write_receipt(result)
    return _json(result)


_WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}
_TASK_WRITE_PATH = re.compile(r"^/tasks(/.*)?$")
# Writes whose answer is the work spec the agent must act on next: claiming
# hands over a task (POST /tasks/claim, POST /tasks/{id}/assign mode=claim).
_TASK_WORK_SPEC_PATH = re.compile(r"^/tasks/(claim|[^/]+/assign|[^/]+/context)$")
RECEIPT_TEXT_MAX_CHARS = 160
_RECEIPT_SCALAR_MAX_CHARS = 200


def _record_receipt(record: Dict[str, Any]) -> Dict[str, Any]:
    """Keep a record's short scalar fields; summarize or drop nested bodies.

    Task write routes answer {message, task} ({message, event, memory} for
    notes); the task row carries title/description inside inputJson and the
    result inside outputJson.
    """
    out: Dict[str, Any] = {}
    for key, value in record.items():
        if value is None or isinstance(value, (bool, int, float)):
            out[key] = value
        elif isinstance(value, str):
            if len(value) <= _RECEIPT_SCALAR_MAX_CHARS:
                out[key] = value
        elif key == "assignee" and isinstance(value, dict):
            out[key] = {k: value.get(k) for k in ("type", "id", "name") if value.get(k)}
        elif key == "blockedByTaskIds" and isinstance(value, list):
            out["blockers"] = len(value)
    for key in ("inputJson", "payloadJson"):
        spec = record.get(key)
        if not isinstance(spec, dict):
            continue
        title = _one_line(spec.get("title"), RECEIPT_TEXT_MAX_CHARS)
        summary = _one_line(
            spec.get("description") or spec.get("note") or spec.get("summary") or spec.get("goal"),
            RECEIPT_TEXT_MAX_CHARS,
        )
        if title and "title" not in out:
            out["title"] = title
        if summary and "summary" not in out:
            out["summary"] = summary
        if isinstance(spec.get("kind"), str) and "kind" not in out:
            out["kind"] = spec["kind"]
    return out


def _task_write_receipt(result: Dict[str, Any]) -> Dict[str, Any]:
    """Compact receipt for a successful task write; failures pass through."""
    data = result.get("data") if isinstance(result, dict) else None
    if not result.get("ok") or not isinstance(data, dict):
        return result
    compact: Dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(value, dict):
            compact[key] = _record_receipt(value)
        elif value is None or isinstance(value, (bool, int, float)):
            compact[key] = value
        elif isinstance(value, str):
            compact[key] = _cut_string(value, _RECEIPT_SCALAR_MAX_CHARS)
        # Lists (notes, history) are dropped from write receipts.
    return {**result, "data": compact}


DEFAULT_ARTIFACT_LIST_LIMIT = 30
DEFAULT_TASK_NOTES_LIMIT = 20
_ARTIFACT_LIST_PATH = re.compile(r"^/artifacts$")
_TASK_NOTES_PATH = re.compile(r"^/tasks/[^/]+/notes$")


def _tail_task_notes(result: Dict[str, Any], limit: Any) -> Dict[str, Any]:
    """Keep only the newest task events.

    GET /tasks/{id}/notes takes no limit and returns the whole history oldest
    first, so the bound is applied here: the latest `limit` events (default 20).
    """
    data = result.get("data") if isinstance(result, dict) else None
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        return result
    try:
        keep = max(int(limit), 1) if limit not in (None, "") else DEFAULT_TASK_NOTES_LIMIT
    except (TypeError, ValueError):
        keep = DEFAULT_TASK_NOTES_LIMIT
    if len(events) <= keep:
        return result
    trimmed = {
        **data,
        "events": events[-keep:],
        "_truncated": {"events": {"returned": keep, "total": len(events), "kept": "newest"}},
        "_hint": "pass query.limit for more of the newest events",
    }
    return {**result, "data": trimmed}


def emperor_list_projects(args: Dict[str, Any], **_: Any) -> str:
    return _json(_request("GET", "/projects", query={"limit": args.get("limit") or 20}))


def emperor_create_project(args: Dict[str, Any], **_: Any) -> str:
    goal = str(args.get("goal") or "").strip()
    if not goal:
        return _json({"error": "goal is required"})
    body = {
        "goal": goal,
        "status": args.get("status") or "active",
    }
    for key in ("customerId", "leadAgentId", "maxActiveAgents"):
        if args.get(key) not in (None, ""):
            body[key] = args.get(key)
    return _json(_request("POST", "/projects", body=body))


def _bounded_int(value: Any, default: int, maximum: int) -> int:
    try:
        number = int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        number = default
    return min(max(number, 1), maximum)


def _one_line(value: Any, cap: int) -> str | None:
    if isinstance(value, list):
        value = "; ".join(str(item) for item in value if isinstance(item, (str, int, float)))
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text:
        return None
    return text if len(text) <= cap else text[: cap - 1].rstrip() + "…"


def _task_summary(task: Dict[str, Any]) -> Dict[str, Any]:
    """Compact board row for one task from GET /tasks (raw row + assignee).

    Title, description and acceptance criteria live in inputJson; the row has
    no project or assignee names, so those appear only when the server sends them.
    """
    spec = task.get("inputJson") if isinstance(task.get("inputJson"), dict) else {}
    blockers = task.get("blockedByTaskIds") if isinstance(task.get("blockedByTaskIds"), list) else []
    assignee = task.get("assignee") if isinstance(task.get("assignee"), dict) else None
    if assignee is not None:
        assignee = {k: assignee.get(k) for k in ("type", "id", "name") if assignee.get(k)}
        name = task.get("assigneeName") or task.get("assignedAgentName")
        if name and "name" not in assignee:
            assignee["name"] = name
    project = task.get("project") if isinstance(task.get("project"), dict) else {}
    approvals = task.get("approvalSummary") if isinstance(task.get("approvalSummary"), dict) else {}
    row = {
        "id": task.get("id"),
        "code": task.get("code") or task.get("shortCode") or spec.get("code"),
        "title": _one_line(spec.get("title") or task.get("title"), 160) or task.get("taskType"),
        "state": task.get("state"),
        "priority": task.get("priority"),
        "assignee": assignee or None,
        "projectId": task.get("projectId"),
        "projectName": task.get("projectName") or project.get("name") or project.get("goal"),
        "updatedAt": task.get("updatedAt"),
        "slaDueAt": task.get("slaDueAt"),
        "blocked": task.get("state") == "blocked" or bool(blockers) or None,
        "blockers": len(blockers) or None,
        "blockedReason": _one_line(spec.get("blockedReason"), 160),
        "pendingApprovals": approvals.get("pending") or None,
        "summary": _one_line(
            spec.get("description") or spec.get("acceptanceCriteria") or spec.get("definitionOfDone") or spec.get("goal"),
            160,
        ),
    }
    return {k: v for k, v in row.items() if v not in (None, "", [], {})}


def emperor_list_tasks(args: Dict[str, Any], **_: Any) -> str:
    query = {
        "projectId": args.get("projectId"),
        "state": args.get("state"),
        "limit": _bounded_int(args.get("limit"), 20, 50),
    }
    result = _request("GET", "/tasks", query=query)
    data = result.get("data") if isinstance(result, dict) else None
    if args.get("detail") or not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        return _json(result)
    tasks = [_task_summary(task) for task in data["tasks"] if isinstance(task, dict)]
    return _json({
        **result,
        "data": {
            "tasks": tasks,
            "returned": len(tasks),
            "hint": "compact rows; GET /tasks/{id} or detail=true for full fields",
        },
    })


def emperor_get_task_overview(args: Dict[str, Any], **_: Any) -> str:
    query = {
        "projectId": args.get("projectId"),
        "maxItems": args.get("maxItems") or 10,
    }
    return _json(_request("GET", "/tasks/overview", query=query))


def emperor_list_threads(args: Dict[str, Any], **_: Any) -> str:
    query = {
        "type": args.get("type"),
        "agentId": args.get("agentId") or args.get("agent_id"),
        "projectId": args.get("projectId") or args.get("project_id"),
        "taskId": args.get("taskId") or args.get("task_id"),
    }
    return _json(_request("GET", "/threads", query=query))


def _string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [part for part in value.split(",")]
    return [str(item).strip() for item in (value or []) if str(item).strip()] if isinstance(value, list) else []


def emperor_request_approval(args: Dict[str, Any], **_: Any) -> str:
    task_id = str(args.get("taskId") or args.get("task_id") or "").strip()
    rationale = str(args.get("rationale") or "").strip()
    if not task_id or not rationale:
        return _json({"error": "taskId and rationale are required"})
    body = {"taskId": task_id, "rationale": rationale, "actionType": args.get("actionType") or "task_done", "requesterAgentId": _agent_ref()}
    return _json(_request("POST", "/approvals", body=body))


CHECK_ACTIONS = ("send_email", "post_social", "spend_money", "delete_data", "deploy", "browse_web", "run_shell")


def emperor_check_action(args: Dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "").strip()
    if action not in CHECK_ACTIONS:
        return _json({"error": f"action must be one of: {', '.join(CHECK_ACTIONS)}"})
    details = args.get("details")
    if details is None:
        details = {}
    if not isinstance(details, dict):
        details = {"details": str(details)}
    body = {"action": action, "details": details, "agentId": _agent_ref() or None}
    return _json(_request("POST", "/action-policies/check", body=body))


def emperor_remember(args: Dict[str, Any], **_: Any) -> str:
    content = str(args.get("content") or "").strip()
    if not content:
        return _json({"error": "content is required"})
    kind = str(args.get("kind") or "lesson").strip().lower()
    if kind not in {"preference", "lesson", "fact", "context"}:
        kind = "lesson"
    agent = _agent_ref()
    if not agent:
        return _json({"error": "EMPEROR_CLAW_AGENT_ID is not set"})
    body = {"kind": kind, "content": content[:1000], "summary": str(args.get("summary") or "").strip()[:200] or None}
    result = _request("POST", f"/agents/{urllib.parse.quote(agent)}/memory", body=body)
    data = result.get("data") if isinstance(result, dict) else None
    if not result.get("ok") or not isinstance(data, dict):
        return _json(result)
    # The server answers {entry, snapshot}; the snapshot can be the whole memory.
    entry = data.get("entry") if isinstance(data.get("entry"), dict) else data
    return _json(_confirmation(result, {"id": entry.get("id"), "kind": entry.get("kind") or kind}))


def emperor_list_groups(args: Dict[str, Any], **_: Any) -> str:
    query = {"mine": "1" if args.get("mine", True) else None, "agentId": _agent_ref()}
    return _json(_request("GET", "/groups", query={k: v for k, v in query.items() if v}))


def emperor_create_group(args: Dict[str, Any], **_: Any) -> str:
    title = str(args.get("title") or "").strip()
    if not title:
        return _json({"error": "title is required"})
    body = {
        "title": title,
        "description": args.get("description"),
        "agentIds": _string_list(args.get("agentIds") or args.get("agents")),
        "humanUserIds": _string_list(args.get("humanUserIds")),
        "agentId": _agent_ref(),
    }
    return _json(_request("POST", "/groups", body={k: v for k, v in body.items() if v not in (None, "", [])}))


def emperor_add_group_members(args: Dict[str, Any], **_: Any) -> str:
    group_id = str(args.get("groupId") or args.get("threadId") or "").strip()
    if not group_id:
        return _json({"error": "groupId is required"})
    body = {
        "agentIds": _string_list(args.get("agentIds") or args.get("agents")),
        "humanUserIds": _string_list(args.get("humanUserIds")),
        "agentId": _agent_ref(),
    }
    return _json(_request("POST", f"/groups/{urllib.parse.quote(group_id)}/members", body={k: v for k, v in body.items() if v}))


def emperor_remove_group_member(args: Dict[str, Any], **_: Any) -> str:
    group_id = str(args.get("groupId") or args.get("threadId") or "").strip()
    member_id = str(args.get("memberId") or "").strip()
    kind = str(args.get("kind") or "agent")
    if not group_id or not member_id:
        return _json({"error": "groupId and memberId are required"})
    return _json(_request("DELETE", f"/groups/{urllib.parse.quote(group_id)}/members", body={"kind": kind, "memberId": member_id, "agentId": _agent_ref()}))


def emperor_get_thread_messages(args: Dict[str, Any], **_: Any) -> str:
    thread_id = str(args.get("threadId") or args.get("thread_id") or "").strip()
    if not thread_id:
        return _json({"error": "threadId is required"})
    query = {
        "limit": _bounded_int(args.get("limit"), 30, 100),
        "since": args.get("since"),
        # A company-wide token reads a person's private chat only as the agent it names.
        "agentId": _agent_ref(),
    }
    result = _request("GET", f"/threads/{urllib.parse.quote(thread_id)}/messages", query=query)
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return _json(result)
    thread = data.get("thread") if isinstance(data.get("thread"), dict) else {}
    compact: Dict[str, Any] = {
        "thread": {k: thread.get(k) for k in ("id", "type", "title") if thread.get(k)} or None,
        # The route returns oldest-first; with `since` it is unbounded, so keep
        # the newest `limit` messages here.
        "messages": [_message_summary(m) for m in data["messages"][-query["limit"]:] if isinstance(m, dict)],
        "hasMore": data.get("hasMore") or len(data["messages"]) > query["limit"] or None,
    }
    return _json({**result, "data": {k: v for k, v in compact.items() if v is not None}})


MESSAGE_TEXT_MAX_CHARS = 1500


def _message_summary(message: Dict[str, Any]) -> Dict[str, Any]:
    meta = message.get("metadataJson") if isinstance(message.get("metadataJson"), dict) else {}
    sender = {
        "type": message.get("senderType"),
        "id": message.get("senderId"),
        "name": message.get("senderName") or meta.get("senderName") or meta.get("agentName"),
    }
    text = message.get("text")
    row = {
        "id": message.get("id"),
        "sender": {k: v for k, v in sender.items() if v},
        "createdAt": message.get("createdAt"),
        "text": _cut_string(text, MESSAGE_TEXT_MAX_CHARS) if isinstance(text, str) else text,
        "replyToMessageId": message.get("replyToMessageId") or meta.get("replyToMessageId"),
    }
    return {k: v for k, v in row.items() if v not in (None, "", {})}


def emperor_create_folder(args: Dict[str, Any], **_: Any) -> str:
    name = str(args.get("name") or "").strip()
    if not name:
        return _json({"error": "name is required"})
    body: Dict[str, Any] = {"name": name}
    for key in ("projectId", "customerId", "parentFolderId", "agentId", "kind"):
        if args.get(key) not in (None, ""):
            body[key] = args[key]
    return _json(_request("POST", "/folders", body=body))


def emperor_list_folder_contents(args: Dict[str, Any], **_: Any) -> str:
    folder_id = str(args.get("folderId") or "").strip()
    if not folder_id:
        return _json({"error": "folderId is required"})
    query: Dict[str, Any] = {}
    if args.get("search"):
        query["search"] = args["search"]
    if args.get("limit"):
        query["limit"] = args["limit"]
    return _json(_request("GET", f"/folders/{urllib.parse.quote(folder_id)}/contents", query=query or None))


def emperor_upload_artifact(args: Dict[str, Any], **_: Any) -> str:
    file_path = str(args.get("filePath") or "").strip()
    kind = str(args.get("kind") or "").strip()
    if not file_path or not kind:
        return _json({"error": "filePath and kind are required"})
    if not os.path.isfile(file_path):
        return _json({"error": f"File not found: {file_path}"})
    fields: Dict[str, str] = {"kind": kind}
    for key in ("projectId", "taskId", "customerId", "folderId", "title", "artifactClass", "importance", "contentType", "visibility"):
        val = args.get(key)
        if val not in (None, ""):
            fields[key] = str(val)
    agent = args.get("agentId") or _agent_ref()
    if agent:
        fields["agentId"] = agent
    if "visibility" not in fields:
        fields["visibility"] = "private"
    return _json(_artifact_receipt(_multipart_upload("/api/mcp/artifacts/upload", file_path, fields)))


def emperor_upload_artifacts(args: Dict[str, Any], **_: Any) -> str:
    """Upload a bounded batch and report every per-file outcome.

    This intentionally composes the single-file endpoint so each file keeps
    its own idempotency key and rollback behavior. A partial failure is never
    presented as all-or-nothing success.
    """
    files = args.get("files")
    if not isinstance(files, list) or not files:
        return _json({"error": "files must be a non-empty array"})
    if len(files) > 25:
        return _json({"error": "A batch may contain at most 25 files"})

    shared = {key: value for key, value in args.items() if key != "files"}
    results: list[Dict[str, Any]] = []
    for entry in files:
        item = dict(shared)
        if isinstance(entry, str):
            item["filePath"] = entry
        elif isinstance(entry, dict):
            item.update(entry)
        else:
            results.append({"ok": False, "error": "Each file must be a path string or object"})
            continue
        file_path = str(item.get("filePath") or "")
        try:
            result = json.loads(emperor_upload_artifact(item))
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
        results.append({"filePath": file_path, **result})
    succeeded = sum(1 for result in results if result.get("ok") is True)
    return _json({
        "ok": succeeded == len(results),
        "succeeded": succeeded,
        "failed": len(results) - succeeded,
        "results": results,
    })


def emperor_replace_artifact(args: Dict[str, Any], **_: Any) -> str:
    artifact_id = str(args.get("artifactId") or "").strip()
    file_path = str(args.get("filePath") or "").strip()
    if not artifact_id or not file_path:
        return _json({"error": "artifactId and filePath are required"})
    if not os.path.isfile(file_path):
        return _json({"error": f"File not found: {file_path}"})
    fields: Dict[str, str] = {}
    for key in ("folderId", "name", "title", "contentType"):
        value = args.get(key)
        if value not in (None, ""):
            fields[key] = str(value)
    path = "/api/mcp/artifacts/" + urllib.parse.quote(artifact_id) + "/replace"
    return _json(_artifact_receipt(_multipart_upload(path, file_path, fields, method="PATCH")))


def emperor_verify_artifact(args: Dict[str, Any], **_: Any) -> str:
    artifact_id = str(args.get("artifactId") or "").strip()
    if not artifact_id:
        return _json({"error": "artifactId is required"})
    return _json(_request("GET", f"/artifacts/{urllib.parse.quote(artifact_id)}/verify"))


def emperor_add_task_note(args: Dict[str, Any], **_: Any) -> str:
    task_id = str(args.get("taskId") or "").strip()
    note = str(args.get("note") or "").strip()
    if not task_id or not note:
        return _json({"error": "taskId and note are required"})
    body: Dict[str, Any] = {"note": note}
    if args.get("kind") in ("progress", "handoff", "blocker"):
        body["kind"] = args["kind"]
    if isinstance(args.get("handoff"), dict):
        body["handoff"] = args["handoff"]
    body["agentId"] = args.get("agentId") or _agent_ref()
    result = _request("POST", f"/tasks/{urllib.parse.quote(task_id)}/notes", body=body)
    data = result.get("data") if isinstance(result, dict) else None
    if not result.get("ok") or not isinstance(data, dict):
        return _json(result)
    event = data.get("event") if isinstance(data.get("event"), dict) else {}
    memory = data.get("memory") if isinstance(data.get("memory"), dict) else {}
    payload = event.get("payloadJson") if isinstance(event.get("payloadJson"), dict) else {}
    return _json(_confirmation(result, {
        "id": event.get("id"),
        "taskId": event.get("taskId") or task_id,
        "kind": payload.get("kind") or body.get("kind"),
        "memoryId": memory.get("id"),
    }))


def _confirmation(result: Dict[str, Any], fields: Dict[str, Any]) -> Dict[str, Any]:
    """Small write receipt instead of echoing the stored record back."""
    out: Dict[str, Any] = {"ok": result.get("ok"), "status": result.get("status")}
    out.update({k: v for k, v in fields.items() if v not in (None, "")})
    return out


ARTIFACT_RECEIPT_FIELDS = (
    "id", "title", "originalFilename", "path", "kind", "contentType", "sizeBytes",
    "sha256", "visibility", "folderId", "projectId", "taskId", "customerId",
)


def _artifact_receipt(result: Dict[str, Any]) -> Dict[str, Any]:
    data = result.get("data") if isinstance(result, dict) else None
    artifact = data.get("artifact") if isinstance(data, dict) else None
    if not result.get("ok") or not isinstance(artifact, dict):
        return result
    receipt = {k: artifact.get(k) for k in ARTIFACT_RECEIPT_FIELDS if artifact.get(k) not in (None, "")}
    return _confirmation(result, {"artifact": receipt})


def emperor_send_message(args: Dict[str, Any], **_: Any) -> str:
    text = str(args.get("text") or "").strip()
    if not text:
        return _json({"error": "text is required"})
    # The bridge's turn file names the message this turn answers. A post into
    # that same thread (the one allowed "acknowledge first" message) must say
    # which message it answers: without replyToMessageId the server marks the
    # thread answered up to the ack's own instant and drops @mentions that
    # arrive while the agent is still working.
    turn = _turn_context()
    turn_thread = turn["threadId"] if turn else None
    turn_message = turn["messageId"] if turn else None
    thread_id = args.get("threadId") or args.get("thread_id")
    thread_type = args.get("threadType") or args.get("thread_type")
    acknowledge = bool(args.get("acknowledge"))
    if acknowledge:
        # An ack only means something inside a bridge turn answering a real
        # message: without one it would fall through to the team channel.
        # A missing, expired or other-generation turn file posts nothing.
        if not turn:
            return _json({"error": "acknowledge is only available inside a bridge turn"})
        if thread_id and thread_id != turn_thread:
            return _json({"error": "acknowledge posts only into the thread of the message you are answering"})
        thread_id = turn_thread
        thread_type = thread_type or turn["threadType"]
    reply_to = turn_message if turn_thread and thread_id == turn_thread else None
    body = {
        "text": text,
        "agentId": args.get("agentId") or args.get("agent_id") or _agent_ref(),
        "thread_id": thread_id,
        "thread_type": thread_type or "team",
        "chat_id": args.get("chatId") or args.get("chat_id"),
        "targetAgentId": args.get("targetAgentId") or args.get("target_agent_id"),
        "private": args.get("private"),
        "replyToMessageId": reply_to,
        # Tells the server this post answers nothing (see answeredCutoffByThread).
        "ack": True if acknowledge else None,
    }
    body = {k: v for k, v in body.items() if v not in (None, "")}
    return _json(_request("POST", "/messages/send", body=body))


def emperor_list_objectives(args: Dict[str, Any], **_: Any) -> str:
    # The bound runtime token fixes the acting agent, so this never accepts an
    # agentId: an agent can only ever see its own objectives.
    return _json(_request("GET", "/objectives"))


def emperor_update_objective(args: Dict[str, Any], **_: Any) -> str:
    objective_id = str(args.get("objectiveId") or args.get("objective_id") or "").strip()
    action = str(args.get("action") or "").strip().lower()
    allowed = {"update", "pause", "resume", "block", "complete", "cancel"}
    if not objective_id or action not in allowed:
        return _json({"error": "objectiveId and an action (update/pause/resume/block/complete/cancel) are required"})
    body: Dict[str, Any] = {"objectiveId": objective_id, "action": action}
    for key in ("summary", "blockerReason", "completionSummary", "objective"):
        value = args.get(key)
        if value not in (None, ""):
            body[key] = value
    if args.get("cadenceMinutes") not in (None, ""):
        body["cadenceMinutes"] = args.get("cadenceMinutes")
    # No agentId is ever sent: the token binding decides whose objective this is.
    return _json(_request("POST", "/objectives", body=body))


def emperor_get_manual(args: Dict[str, Any], **_: Any) -> str:
    section = str(args.get("section") or "").strip()
    query: Dict[str, Any] = {"section": section} if section else {}
    return _json(_request("GET", "/manual", query=query or None))


def emperor_get_knowledge_note(args: Dict[str, Any], **_: Any) -> str:
    note_id = str(args.get("id") or args.get("resourceId") or args.get("resource_id") or "").strip()
    if not note_id:
        return _json({"error": "id is required"})
    return _json(_request("GET", f"/knowledge/{urllib.parse.quote(note_id)}"))


def emperor_search_knowledge(args: Dict[str, Any], **_: Any) -> str:
    query = str(args.get("query") or args.get("q") or "").strip()
    if not query:
        return _json({"error": "query is required"})
    return _json(_request("GET", "/knowledge/search", query={"q": query, "limit": args.get("limit") or 10}))


def emperor_list_knowledge_folders(args: Dict[str, Any], **_: Any) -> str:
    return _json(_request("GET", "/knowledge/folders"))


def _view_id(args: Dict[str, Any]) -> str:
    return str(args.get("viewId") or args.get("view_id") or args.get("id") or "").strip()


def _view_query(extra: Dict[str, Any] | None = None) -> Dict[str, Any]:
    # Every views call names the acting agent (like the task/message tools), so
    # an operator token acts with this agent's scope and is recorded as it:
    # the server checks writes against the view's builder.
    return {**(extra or {}), "agentId": _agent_ref()}


def emperor_list_views(args: Dict[str, Any], **_: Any) -> str:
    query: Dict[str, Any] = {
        "scopeType": args.get("scopeType") or args.get("scope_type"),
        "scopeId": args.get("scopeId") or args.get("scope_id"),
        "includeArchived": "true" if args.get("includeArchived") else None,
    }
    return _json(_request("GET", "/views", query=_view_query(query)))


def emperor_get_view(args: Dict[str, Any], **_: Any) -> str:
    view_id = _view_id(args)
    if not view_id:
        return _json({"error": "viewId is required"})
    return _json(_request("GET", f"/views/{urllib.parse.quote(view_id)}", query=_view_query()))


def emperor_create_view(args: Dict[str, Any], **_: Any) -> str:
    title = str(args.get("title") or "").strip()
    panels = args.get("panels")
    if not title or not isinstance(panels, list):
        return _json({"error": "title and a panels array are required"})
    body = {
        "title": title,
        "description": args.get("description"),
        "scopeType": args.get("scopeType") or args.get("scope_type"),
        "scopeId": args.get("scopeId") or args.get("scope_id"),
        "panels": panels,
    }
    body = {k: v for k, v in body.items() if v not in (None, "")}
    return _json(_request("POST", "/views", body=body, query=_view_query()))


def emperor_update_view(args: Dict[str, Any], **_: Any) -> str:
    view_id = _view_id(args)
    if not view_id:
        return _json({"error": "viewId is required"})
    body = {key: args.get(key) for key in ("title", "description", "panels") if args.get(key) is not None}
    if not body:
        return _json({"error": "Pass title, description or panels"})
    return _json(_request("PATCH", f"/views/{urllib.parse.quote(view_id)}", body=body, query=_view_query()))


def emperor_update_panel(args: Dict[str, Any], **_: Any) -> str:
    view_id = _view_id(args)
    panel_id = str(args.get("panelId") or args.get("panel_id") or "").strip()
    data = args.get("data")
    if not view_id or not panel_id or not isinstance(data, dict):
        return _json({"error": "viewId, panelId and a data object are required"})
    path = f"/views/{urllib.parse.quote(view_id)}/panels/{urllib.parse.quote(panel_id, safe='')}"
    return _json(_request("PUT", path, body={"data": data}, query=_view_query()))


def emperor_archive_view(args: Dict[str, Any], **_: Any) -> str:
    view_id = _view_id(args)
    if not view_id:
        return _json({"error": "viewId is required"})
    return _json(_request("POST", f"/views/{urllib.parse.quote(view_id)}/archive", body={}, query=_view_query()))


def emperor_create_agent(args: Dict[str, Any], **kwargs: Any) -> str:
    return _json(_request("POST", "/agents", {
        "name": args.get("name", ""),
        "role": args.get("role", "operator"),
        "deploymentMode": "local",
        "sourceAgentId": _agent_ref(),
        "doctrineJson": args.get("doctrineJson", {}),
    }, timeout=600))


def _schema(description: str, properties: Dict[str, Any], required: list[str] | None = None) -> Dict[str, Any]:
    return {
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }


def register(ctx: Any) -> None:
    # No gate on os.environ: in a shared gateway the process has no single
    # token, so credentials are resolved per session at call time (_creds).
    # No pre_llm_call hook either: hook output is appended to every user
    # message and replayed with history; the bridge puts the operating guide
    # in the session system prompt, and the skill below keeps it readable.
    requires = ["EMPEROR_CLAW_API_TOKEN"]
    plugin_dir = Path(__file__).resolve().parent
    skill_dir = plugin_dir / "skills" / "emperor-claw"
    if skill_dir.exists():
        ctx.register_skill(
            "emperor-claw",
            skill_dir,
            "Use Emperor Claw as the durable control plane for Hermes agents.",
        )
    ctx.register_tool(
        "emperor_health",
        TOOLSET,
        _schema("Check Emperor MCP runtime health and capabilities.", {}),
        emperor_health,
        check_fn=_available,
        requires_env=requires,
        description="Check Emperor health",
    )
    ctx.register_tool(
        "emperor_request",
        TOOLSET,
        _schema(
            "Call an Emperor MCP REST endpoint. Paths may be full /api/mcp paths or short MCP paths such as /projects. Prefer filtered reads (one id, query filters, limit). GET /artifacts defaults to limit 30 and GET /tasks/{id}/notes returns the newest 20 events unless query.limit is set. Large results are shortened and marked _truncated. Task writes (POST/PATCH/PUT/DELETE on /tasks...) return a compact receipt (ids, state, title, summary) unless full=true.",
            {
                "method": {"type": "string", "enum": ["GET", "POST", "PATCH", "PUT", "DELETE"]},
                "path": {"type": "string"},
                "query": {"type": "object"},
                "body": {"type": "object"},
                "full": {"type": "boolean", "description": "Return the full echoed record for a task write instead of the compact receipt."},
            },
            ["path"],
        ),
        emperor_request,
        check_fn=_available,
        requires_env=requires,
        description="Generic Emperor MCP request",
    )
    ctx.register_tool(
        "emperor_list_projects",
        TOOLSET,
        _schema("List Emperor projects.", {"limit": {"type": "integer", "default": 50}}),
        emperor_list_projects,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor projects",
    )
    ctx.register_tool(
        "emperor_create_project",
        TOOLSET,
        _schema(
            "Create an Emperor project for a clear business goal.",
            {
                "goal": {"type": "string", "description": "Short displayed project name, 3–8 words, preferably under 80 characters. Put details in memory/tasks."},
                "status": {"type": "string", "default": "active"},
                "customerId": {"type": "string"},
                "leadAgentId": {"type": "string"},
                "maxActiveAgents": {"type": "integer"},
            },
            ["goal"],
        ),
        emperor_create_project,
        check_fn=_available,
        requires_env=requires,
        description="Create Emperor project",
    )
    ctx.register_tool(
        "emperor_list_tasks",
        TOOLSET,
        _schema(
            "List Emperor tasks, optionally filtered by project or state. Returns compact rows (id, title, state, priority, assignee, project, dates, blockers, one-line summary); fetch one task with GET /tasks/{id} for full fields.",
            {
                "projectId": {"type": "string"},
                "state": {"type": "string"},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 50},
                "detail": {"type": "boolean", "description": "Return full task objects instead of compact rows. Use only when you need fields the rows omit."},
            },
        ),
        emperor_list_tasks,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor tasks",
    )
    ctx.register_tool(
        "emperor_get_task_overview",
        TOOLSET,
        _schema(
            "Get exact server-side task totals plus bounded priority, genuinely blocked, and pending-approval lists. Use this first for board/status questions instead of loading hundreds of tasks.",
            {
                "projectId": {"type": "string", "description": "Optional project restriction."},
                "maxItems": {"type": "integer", "default": 10, "minimum": 1, "maximum": 25},
            },
        ),
        emperor_get_task_overview,
        check_fn=_available,
        requires_env=requires,
        description="Get compact Emperor task overview",
    )
    ctx.register_tool(
        "emperor_list_threads",
        TOOLSET,
        _schema(
            "List Emperor message threads. Use this to find team, direct, project, or task threads before reading chat history.",
            {
                "type": {"type": "string", "enum": ["direct", "team", "group", "project", "task", "incident"]},
                "agentId": {"type": "string"},
                "projectId": {"type": "string"},
                "taskId": {"type": "string"},
            },
        ),
        emperor_list_threads,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor message threads",
    )
    ctx.register_tool(
        "emperor_get_thread_messages",
        TOOLSET,
        _schema(
            "Read exact message history for an Emperor thread.",
            {
                "threadId": {"type": "string"},
                "limit": {"type": "integer", "default": 30, "minimum": 1, "maximum": 100},
                "since": {"type": "string", "description": "Optional ISO timestamp. Only newer messages are returned."},
            },
            ["threadId"],
        ),
        emperor_get_thread_messages,
        check_fn=_available,
        requires_env=requires,
        description="Read Emperor thread messages",
    )
    ctx.register_tool(
        "emperor_create_folder",
        TOOLSET,
        _schema(
            "Create a Storage folder (or a nested subfolder) in Emperor. "
            "Returns folder.id — pass it as folderId when uploading files into this folder.",
            {
                "name": {"type": "string", "description": "Folder name."},
                "projectId": {"type": "string", "description": "Required unless customerId is provided."},
                "customerId": {"type": "string", "description": "Required unless projectId is provided."},
                "parentFolderId": {"type": "string", "description": "ID of the parent folder. Omit for a top-level folder; provide to create a subfolder inside an existing folder."},
                "agentId": {"type": "string"},
            },
            ["name"],
        ),
        emperor_create_folder,
        check_fn=_available,
        requires_env=requires,
        description="Create a Storage folder or subfolder",
    )
    ctx.register_tool(
        "emperor_list_folder_contents",
        TOOLSET,
        _schema(
            "List the subfolders and files inside a Storage folder. Use this to browse or verify what has been uploaded.",
            {
                "folderId": {"type": "string"},
                "search": {"type": "string", "description": "Optional filename search filter."},
                "limit": {"type": "integer", "default": 100},
            },
            ["folderId"],
        ),
        emperor_list_folder_contents,
        check_fn=_available,
        requires_env=requires,
        description="List contents of a Storage folder",
    )
    ctx.register_tool(
        "emperor_upload_artifact",
        TOOLSET,
        _schema(
            "Upload a local file from disk to Emperor Storage (artifacts). Use this for any file upload — never use emperor_request, curl, Bunny, or direct blob-provider APIs for normal uploads. Pass folderId when the file belongs in a folder.",
            {
                "filePath": {"type": "string", "description": "Absolute path to the file on this machine."},
                "kind": {"type": "string", "description": "Artifact kind, e.g. report, invoice, deliverable, evidence, export."},
                "projectId": {"type": "string"},
                "taskId": {"type": "string"},
                "customerId": {"type": "string"},
                "title": {"type": "string"},
                "artifactClass": {"type": "string"},
                "importance": {"type": "string"},
                "contentType": {"type": "string", "description": "MIME type override. Auto-detected from filename if omitted."},
                "visibility": {"type": "string", "enum": ["private", "public"], "default": "private"},
                "agentId": {"type": "string"},
            },
            ["filePath", "kind"],
        ),
        emperor_upload_artifact,
        check_fn=_available,
        requires_env=requires,
        description="Upload a local file to Emperor Storage",
    )
    ctx.register_tool(
        "emperor_upload_artifacts",
        TOOLSET,
        _schema(
            "Upload up to 25 local files to Emperor Storage and return a result for every file. Shared fields apply to the batch; each file object may override them. Partial failures are reported explicitly.",
            {
                "files": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 25,
                    "items": {
                        "oneOf": [
                            {"type": "string", "description": "Absolute local file path."},
                            {"type": "object", "properties": {
                                "filePath": {"type": "string"},
                                "kind": {"type": "string"},
                                "title": {"type": "string"},
                                "contentType": {"type": "string"},
                            }, "required": ["filePath"]},
                        ]
                    },
                },
                "kind": {"type": "string", "description": "Shared artifact kind unless overridden per file."},
                "projectId": {"type": "string"},
                "taskId": {"type": "string"},
                "customerId": {"type": "string"},
                "folderId": {"type": "string"},
                "artifactClass": {"type": "string"},
                "importance": {"type": "string"},
                "visibility": {"type": "string", "enum": ["private", "public"], "default": "private"},
            },
            ["files", "kind"],
        ),
        emperor_upload_artifacts,
        check_fn=_available,
        requires_env=requires,
        description="Upload a bounded batch to Emperor Storage",
    )
    ctx.register_tool(
        "emperor_replace_artifact",
        TOOLSET,
        _schema(
            "Replace the bytes of an existing Storage artifact while preserving its identity. Verify it afterward for important deliverables.",
            {
                "artifactId": {"type": "string"},
                "filePath": {"type": "string", "description": "Absolute path to replacement bytes."},
                "folderId": {"type": "string"},
                "name": {"type": "string"},
                "title": {"type": "string"},
                "contentType": {"type": "string"},
            },
            ["artifactId", "filePath"],
        ),
        emperor_replace_artifact,
        check_fn=_available,
        requires_env=requires,
        description="Replace an Emperor Storage artifact",
    )
    ctx.register_tool(
        "emperor_verify_artifact",
        TOOLSET,
        _schema(
            "Verify that a Storage artifact's bytes exist and match its recorded size and SHA-256. Use after important uploads or replacements.",
            {"artifactId": {"type": "string"}},
            ["artifactId"],
        ),
        emperor_verify_artifact,
        check_fn=_available,
        requires_env=requires,
        description="Verify a Storage artifact's bytes and checksum",
    )
    ctx.register_tool(
        "emperor_add_task_note",
        TOOLSET,
        _schema(
            "Add a progress, blocker, observation, or handoff note to an Emperor task. Counts as visible progress (resets the loop guard and the stall sweep).",
            {
                "taskId": {"type": "string"},
                "note": {"type": "string"},
                "kind": {"type": "string", "enum": ["progress", "handoff", "blocker"]},
                "agentId": {"type": "string"},
                "handoff": {"type": "object"},
            },
            ["taskId", "note"],
        ),
        emperor_add_task_note,
        check_fn=_available,
        requires_env=requires,
        description="Add Emperor task note",
    )
    ctx.register_tool(
        "emperor_send_message",
        TOOLSET,
        _schema(
            "Send a message into an Emperor thread OTHER than the one you are answering. Your reply to the current message is delivered automatically by the runtime — do NOT call this tool to answer it, or the thread gets a duplicate. One exception: before long work on a human's request, set acknowledge=true (no threadId) to post ONE short acknowledgement in the current thread. To message a sibling: pass targetAgentId; Emperor posts in the work-team chat you both share and @mentions them (only they are woken). If you share several team chats you must pass threadId (or private=true). Set private=true only when the message must not be seen by the team. If you share no team, it falls back to a private two-agent thread.",
            {
                "text": {"type": "string"},
                "agentId": {"type": "string", "description": "Optional sender Emperor agent id/name. Defaults to this Hermes profile's configured agent."},
                "threadId": {"type": "string", "description": "Explicit thread to post in; takes precedence over team selection."},
                "threadType": {"type": "string", "enum": ["direct", "team", "group"]},
                "chatId": {"type": "string"},
                "targetAgentId": {"type": "string", "description": "Recipient Emperor agent id/name. With no threadId, the shared team chat is preferred."},
                "private": {"type": "boolean", "description": "Force a private two-agent thread instead of the shared team chat."},
                "acknowledge": {"type": "boolean", "description": "Post a short acknowledgement in the thread you are answering (once per request, before long work)."},
            },
            ["text"],
        ),
        emperor_send_message,
        check_fn=_available,
        requires_env=requires,
        description="Send Emperor message",
    )
    ctx.register_tool(
        "emperor_list_objectives",
        TOOLSET,
        _schema("List your persistent objectives (most recent first). An objective is the durable outcome you were asked to pursue; Emperor sends you a private check-in on a fixed cadence until you complete, block, pause or cancel it.", {}),
        emperor_list_objectives,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor objectives",
    )
    ctx.register_tool(
        "emperor_update_objective",
        TOOLSET,
        _schema(
            "Report on or change YOUR OWN objective (you cannot touch another agent's). Actions: 'update' with a short summary of progress; 'block' with a blockerReason when you are stuck on a person or event (pauses check-ins); 'resume'; 'pause'; 'complete' with a completionSummary when finished; 'cancel' to drop it.",
            {
                "objectiveId": {"type": "string"},
                "action": {"type": "string", "enum": ["update", "pause", "resume", "block", "complete", "cancel"]},
                "summary": {"type": "string", "description": "One-line progress note for action 'update'"},
                "blockerReason": {"type": "string", "description": "What you are waiting on (required for action 'block')"},
                "completionSummary": {"type": "string", "description": "What was delivered (for action 'complete')"},
                "objective": {"type": "string", "description": "Replace the objective text (action 'update')"},
                "cadenceMinutes": {"type": "integer", "description": "Change the check-in cadence in minutes (action 'update')"},
            },
            ["objectiveId", "action"],
        ),
        emperor_update_objective,
        check_fn=_available,
        requires_env=requires,
        description="Update Emperor objective",
    )
    ctx.register_tool(
        "emperor_request_approval",
        TOOLSET,
        _schema(
            "Ask a person to sign off before you act: spending money, sending anything outside the company (emails, posts, customer messages), publishing, deleting, or closing a task that requires approval. Moves the task to review and notifies owners and admins; the decision and note arrive in your direct chat. Approved task_done closes the task; any other approved action comes back in_progress for you to do and then close; rejected comes back in_progress with the reason. Do not ask in chat instead, and do not act until it is approved.",
            {
                "taskId": {"type": "string"},
                "rationale": {"type": "string", "description": "What exactly needs approval and why, with the evidence needed to decide"},
                "actionType": {"type": "string", "description": "task_done (default), send_email, spend, publish, delete"},
            },
            ["taskId", "rationale"],
        ),
        emperor_request_approval,
        check_fn=_available,
        requires_env=requires,
        description="Request Emperor approval",
    )
    ctx.register_tool(
        "emperor_check_action",
        TOOLSET,
        _schema(
            "Call this BEFORE you send email, post on social media, spend money, delete data, deploy, browse the web, or run shell commands with your own tools. Pass exactly what you will do in details (recipients and subject, amount and vendor, target, command...). mayProceed true = go ahead once, exactly as described. decision approval_pending = a person must approve first; do nothing yet; when told it is approved, call again with the same details and act only if mayProceed is true. off or refused = do NOT do it and don't work around it.",
            {
                "action": {"type": "string", "enum": list(CHECK_ACTIONS)},
                "details": {"type": "object", "description": "What you are about to do. Use the same details when you check again after approval."},
            },
            ["action", "details"],
        ),
        emperor_check_action,
        check_fn=_available,
        requires_env=requires,
        description="Check an action permission",
    )
    ctx.register_tool(
        "emperor_remember",
        TOOLSET,
        _schema(
            "Save something to your own durable memory in Emperor: a person's preference or correction about how you should work, or a lesson you'll need again. Your memories are shown to you at the start of every turn, survive restarts, and people can see and edit them in the app. Keep each one short and specific. Company facts belong in Knowledge & Rules and task progress in task notes, not here.",
            {
                "content": {"type": "string", "description": "The thing to remember, one or two sentences"},
                "kind": {"type": "string", "enum": ["preference", "lesson", "fact", "context"]},
                "summary": {"type": "string", "description": "Optional short label"},
            },
            ["content"],
        ),
        emperor_remember,
        check_fn=_available,
        requires_env=requires,
        description="Save to Emperor memory",
    )
    ctx.register_tool(
        "emperor_list_groups",
        TOOLSET,
        _schema(
            "List Emperor group chats: members-only team channels (e.g. a development team) with their purpose and members. By default only the groups you belong to; mine=false lists all.",
            {"mine": {"type": "boolean"}},
        ),
        emperor_list_groups,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor groups",
    )
    ctx.register_tool(
        "emperor_create_group",
        TOOLSET,
        _schema(
            "Create an Emperor group chat for a set of agents (and optionally humans), e.g. 'Development team' with the devs and the tester. You join it automatically. Only members receive it and they answer when @mentioned. Post into it with emperor_send_message using the returned group id as threadId.",
            {
                "title": {"type": "string"},
                "description": {"type": "string", "description": "The group's purpose, shown to every member"},
                "agentIds": {"type": "array", "items": {"type": "string"}, "description": "Agent ids or exact names"},
                "humanUserIds": {"type": "array", "items": {"type": "string"}},
            },
            ["title"],
        ),
        emperor_create_group,
        check_fn=_available,
        requires_env=requires,
        description="Create Emperor group",
    )
    ctx.register_tool(
        "emperor_add_group_members",
        TOOLSET,
        _schema(
            "Add agents and/or humans to an Emperor group chat you belong to.",
            {
                "groupId": {"type": "string"},
                "agentIds": {"type": "array", "items": {"type": "string"}},
                "humanUserIds": {"type": "array", "items": {"type": "string"}},
            },
            ["groupId"],
        ),
        emperor_add_group_members,
        check_fn=_available,
        requires_env=requires,
        description="Add Emperor group members",
    )
    ctx.register_tool(
        "emperor_remove_group_member",
        TOOLSET,
        _schema(
            "Remove one agent or human from an Emperor group chat you belong to.",
            {
                "groupId": {"type": "string"},
                "kind": {"type": "string", "enum": ["agent", "human"]},
                "memberId": {"type": "string", "description": "Agent id/name or human user id"},
            },
            ["groupId", "memberId"],
        ),
        emperor_remove_group_member,
        check_fn=_available,
        requires_env=requires,
        description="Remove Emperor group member",
    )
    ctx.register_tool(
        "emperor_create_agent",
        TOOLSET,
        _schema(
            "Hire a running local Hermes worker with its own container and token. Reuses your stored LLM configuration and access scope. Requires Docker provisioning.",
            {
                "name": {"type": "string"},
                "role": {"type": "string"},
                "doctrineJson": {"type": "object", "additionalProperties": {"type": "string"}},
            },
            ["name"],
        ),
        emperor_create_agent,
        check_fn=_available,
        requires_env=requires,
        description="Create local Hermes agent",
    )
    ctx.register_tool(
        "emperor_get_manual",
        TOOLSET,
        _schema(
            "Read the single, versioned Emperor operating manual. Call with no section for the whole manual (and the section list), or pass a section id for just that part. Use this instead of guessing how Emperor works. Section ids: overview, chat-and-mentions, tasks-and-projects, approvals, team-handoffs, knowledge, storage, reply-formatting, where-to-look.",
            {"section": {"type": "string", "description": "Optional manual section id. Omit for the whole manual plus the section list."}},
        ),
        emperor_get_manual,
        check_fn=_available,
        requires_env=requires,
        description="Read the Emperor operating manual",
    )
    ctx.register_tool(
        "emperor_get_knowledge_note",
        TOOLSET,
        _schema(
            "Load the full body of one Knowledge & Rules note by id (from the knowledge index or a search). Scope-checked and stripped of secret material. Same contract as GET /api/mcp/resources/{id}.",
            {"id": {"type": "string", "description": "Knowledge note / resource id."}},
            ["id"],
        ),
        emperor_get_knowledge_note,
        check_fn=_available,
        requires_env=requires,
        description="Load one Emperor knowledge note",
    )
    ctx.register_tool(
        "emperor_search_knowledge",
        TOOLSET,
        _schema(
            "Search Knowledge & Rules by name and content. Returns compact index lines (title, summary, id), never bodies; load one with emperor_get_knowledge_note.",
            {
                "query": {"type": "string", "description": "Search text."},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 20},
            },
            ["query"],
        ),
        emperor_search_knowledge,
        check_fn=_available,
        requires_env=requires,
        description="Search Emperor knowledge notes",
    )
    ctx.register_tool(
        "emperor_list_knowledge_folders",
        TOOLSET,
        _schema(
            "The Knowledge & Rules folder tree you can see, with note counts per folder (directCount) and per subtree (totalCount). Call it before filing a note when unsure where it belongs, then pass that path as folder to POST /resources (or PATCH /resources/{id} to move a note). Follow the existing convention (Company, Agents, Projects/<project>, Customers/<customer>); missing folders are created.",
            {},
            [],
        ),
        emperor_list_knowledge_folders,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor knowledge folders",
    )

    view_panels_doc = (
        "Panels in reading order on a 12-column grid (max 40): {id?, type, title, subtitle?, w? 1-12, h? 1-8, data?}. "
        "Reuse each id with emperor_update_panel. data by type (plain text, no HTML): "
        "metric {value, unit?, delta?, deltaLabel?, trend?: up|down|flat or number[]}; "
        "line|bar {series: [{name, points: [{x, y}]}], xLabel?, yLabel?, unit?, stacked?}; "
        "table {columns: [{key, label, align?, format?: text|number|integer|percent|currency|date, currency?}], rows: [{key: value}] (max 500)}; "
        "list {items: [{title, subtitle?, value?, href? (https URL or /app/path)}] (max 200)}; "
        "markdown {text} (max 20,000 chars; no images; links only to https URLs or /app/paths); progress {value, max, label?, unit?}."
    )
    ctx.register_tool(
        "emperor_list_views",
        TOOLSET,
        _schema(
            "List the Emperor views (dashboards) you can see, with scope, panel count, who built each and when their values were last updated. Check before creating one so you update one of yours instead of building a duplicate (you can only change views you built).",
            {
                "scopeType": {"type": "string", "enum": ["company", "customer", "project"]},
                "scopeId": {"type": "string"},
                "includeArchived": {"type": "boolean"},
            },
        ),
        emperor_list_views,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor views",
    )
    ctx.register_tool(
        "emperor_get_view",
        TOOLSET,
        _schema(
            "Load one Emperor view: its panels (ids and types), their current values, and when and by whom each was last updated. Read it before refreshing.",
            {"viewId": {"type": "string"}},
            ["viewId"],
        ),
        emperor_get_view,
        check_fn=_available,
        requires_env=requires,
        description="Load an Emperor view",
    )
    ctx.register_tool(
        "emperor_create_view",
        TOOLSET,
        _schema(
            "Build an Emperor view: a dashboard page of typed panels (metrics, line/bar charts, tables, lists, markdown, progress) people open from Views or pin to Home. "
            "Use it when asked for a dashboard or 'a view of ...'. You fetch the numbers with your own tools and credentials; Emperor stores only the values (never put secrets in a view). "
            "Pick the smallest scope (company, or a customer/project id). You own it: only you (and people) can change it. Then keep it fresh: refresh every panel with emperor_update_panel on a schedule with your own cron, and whenever someone asks.",
            {
                "title": {"type": "string"},
                "description": {"type": "string", "description": "What it shows, the source, how often you refresh it"},
                "scopeType": {"type": "string", "enum": ["company", "customer", "project"]},
                "scopeId": {"type": "string", "description": "Customer or project id for a customer/project view"},
                "panels": {"type": "array", "items": {"type": "object"}, "description": view_panels_doc},
            },
            ["title", "panels"],
        ),
        emperor_create_view,
        check_fn=_available,
        requires_env=requires,
        description="Create an Emperor view",
    )
    ctx.register_tool(
        "emperor_update_view",
        TOOLSET,
        _schema(
            "Change an Emperor view you built: title, description or layout (another agent's view is refused). panels replaces the whole layout (send every panel to keep, with its id). Each title or layout change is a new version people can revert. For new numbers only, use emperor_update_panel.",
            {
                "viewId": {"type": "string"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "panels": {"type": "array", "items": {"type": "object"}, "description": view_panels_doc},
            },
            ["viewId"],
        ),
        emperor_update_view,
        check_fn=_available,
        requires_env=requires,
        description="Update an Emperor view",
    )
    ctx.register_tool(
        "emperor_update_panel",
        TOOLSET,
        _schema(
            "Replace one panel's values in an Emperor view you built with a fresh snapshot (layout untouched, no new version). Call it once per panel on your refresh schedule and when asked to refresh (max 60 per view per minute). data must match the panel's type (see emperor_create_view).",
            {
                "viewId": {"type": "string"},
                "panelId": {"type": "string"},
                "data": {"type": "object", "description": "The panel's full new values"},
            },
            ["viewId", "panelId", "data"],
        ),
        emperor_update_panel,
        check_fn=_available,
        requires_env=requires,
        description="Refresh an Emperor view panel",
    )
    ctx.register_tool(
        "emperor_archive_view",
        TOOLSET,
        _schema(
            "Archive an Emperor view that is no longer needed (people can restore it). Stop your refresh schedule for it too.",
            {"viewId": {"type": "string"}},
            ["viewId"],
        ),
        emperor_archive_view,
        check_fn=_available,
        requires_env=requires,
        description="Archive an Emperor view",
    )
