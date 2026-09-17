from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List


API_URL = os.environ.get("EMPEROR_CLAW_API_URL", "https://emperorclaw.malecu.eu").rstrip("/")
API_TOKEN = os.environ.get("EMPEROR_CLAW_API_TOKEN", "").strip()
AGENT_NAME = os.environ.get("EMPEROR_CLAW_AGENT_NAME", "Hermes")
AGENT_ROLE = os.environ.get("EMPEROR_CLAW_AGENT_ROLE", "operator")
AGENT_INSTRUCTIONS = os.environ.get("EMPEROR_CLAW_AGENT_INSTRUCTIONS", "").strip()
AGENT_ID = os.environ.get("EMPEROR_CLAW_AGENT_ID", "").strip()
RUNTIME_ID = os.environ.get("EMPEROR_CLAW_RUNTIME_ID", f"hermes-{socket.gethostname()}-{uuid.uuid4().hex[:8]}")
HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
HERMES_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "emperor-claw,web,terminal,code_execution").strip()
POLL_SECONDS = float(os.environ.get("EMPEROR_CLAW_HERMES_POLL_SECONDS", "5"))
HERMES_TIMEOUT_SECONDS = int(os.environ.get("EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS", "300"))
# Grace window after SIGTERM before SIGKILL on a timed-out turn: lets Hermes
# checkpoint/save its session transcript so the next dispatch can --resume
# instead of restarting the whole slow turn from scratch.
HERMES_TIMEOUT_GRACE_SECONDS = float(os.environ.get("EMPEROR_CLAW_HERMES_TIMEOUT_GRACE_SECONDS", "10"))
STATE_PATH = Path(os.environ.get("EMPEROR_CLAW_HERMES_STATE_PATH", Path.home() / ".hermes" / "emperor-bridge-state.json"))
DOCTRINE_RESOURCE_ID = os.environ.get("EMPEROR_CLAW_DOCTRINE_RESOURCE_ID", "").strip()
MAX_SHARED_RESOURCE_CHARS = int(os.environ.get("EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS", "12000"))
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
MAIN_CHAT_CONTEXT_LIMIT = int(os.environ.get("EMPEROR_CLAW_MAIN_CHAT_CONTEXT_LIMIT", "20"))
MAIN_CHAT_CONTEXT_MAX_CHARS = int(os.environ.get("EMPEROR_CLAW_MAIN_CHAT_CONTEXT_MAX_CHARS", "6000"))
MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS = int(os.environ.get("EMPEROR_CLAW_MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS", "600"))
# Loop guard: the @mention convention (reply once, then go silent) is a prompt
# convention, not a hard rule — an LLM can still misjudge a "closing" reply as
# needing another response. This is a mechanical backstop: once this agent has
# been triggered by this many consecutive agent-authored messages in the same
# team thread with no human message in between, stop invoking Hermes and post
# one pause notice instead, until a human message resets the counter.
LOOP_GUARD_MAX_AGENT_TURNS = int(os.environ.get("EMPEROR_CLAW_LOOP_GUARD_MAX_TURNS", "3"))

# Cached agent LLM provider — read once at startup for documentation
_agent_llm_provider: str | None = None
_agent_llm_model: str | None = None
# Resolved once per process — the company's team thread is stable, and looking
# it up on every DM turn would add a needless round-trip.
_team_thread_id_cache: str | None = None


def log(message: str) -> None:
    print(f"[emperor-hermes] {message}", flush=True)


def api(method: str, path: str, body: Dict[str, Any] | None = None, query: Dict[str, Any] | None = None) -> Dict[str, Any]:
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
        "User-Agent": "emperor-hermes-bridge/0.1.0",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        headers["Idempotency-Key"] = str(uuid.uuid4())
    req = urllib.request.Request(url, data=payload, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode("utf-8", errors="replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Emperor API {method} {path} failed {exc.code}: {text[:500]}") from exc


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


def ensure_runtime() -> None:
    api("POST", "/runtime/register", body={
        "runtimeId": RUNTIME_ID,
        "name": f"Hermes on {socket.gethostname()}",
        "hostname": socket.gethostname(),
        "gatewayVersion": "hermes-agent",
        "capabilitiesJson": ["hermes-agent", "thread-reply", "emperor-tools"],
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })


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
        sibling_aliases = {
            normalize_mention(alias)
            for sibling in agents if str(sibling.get("id") or "") != str(agent.get("id") or "")
            for alias in agent_name_aliases(str(sibling.get("name") or ""))
        }
        unique_aliases = sorted((alias for alias in agent_name_aliases(name)
            if not re.search(r"\s", alias) and normalize_mention(alias) not in sibling_aliases), key=lambda alias: (len(alias), alias.lower()))
        if unique_aliases:
            lines.append(f"- {name}{marker}: @{unique_aliases[0]}")
        else:
            lines.append(f"- {name}{marker}: no unambiguous alias; use an explicitly assigned task or ask for distinct agent names")
    return "Team roster aliases:\n" + "\n".join(lines)


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
    if thread_type == "team":
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
        text = " ".join(str(entry.get("text") or "").split())
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


def normalize_mention(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", ascii_value.lower())


def agent_name_aliases(name: str) -> set[str]:
    clean = re.sub(r"\([^)]*\)", "", str(name or "")).strip()
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
    for match in re.finditer(r"@([^\s,.;:!?]+(?:\s+[^\s,.;:!?]+)?)", str(text or "")):
        raw = match.group(1).strip()
        if raw:
            refs.add(raw)
            refs.add(raw.split()[0])
    return refs


def mentions_agent(text: str, agent_name: str) -> bool:
    mention_keys = {normalize_mention(ref) for ref in mentioned_agent_refs(text)}
    alias_keys = {normalize_mention(alias) for alias in agent_name_aliases(agent_name)}
    return bool(mention_keys & alias_keys)


def is_for_agent(message: Dict[str, Any], agent_id: str, state: Dict[str, Any]) -> bool:
    sender_type = str(message.get("senderType") or "").lower()
    sender_id = str(message.get("senderId") or message.get("sender_id") or message.get("fromUserId") or "")
    if sender_type == "agent" and sender_id == agent_id:
        return False
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
    if thread_type != "team":
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
    entry["count"] = entry.get("count", 0) + 1
    return entry["count"] <= LOOP_GUARD_MAX_AGENT_TURNS


def sync_messages(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    query = {"mode": "all", "agentId": AGENT_ID}
    if state.get("lastSeenAt"):
        query["since"] = state["lastSeenAt"]
    payload = api("GET", "/messages/sync", query=query)
    messages = payload.get("messages") if isinstance(payload, dict) else []
    return messages if isinstance(messages, list) else []


def update_chat_status(
    message: Dict[str, Any],
    *,
    typing: bool | None = None,
    mark_read: bool = False,
    execution_state: str | None = None,
    activity: str | None = None,
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


def clean_hermes_output(output: str) -> str:
    lines = output.strip().splitlines()
    while lines and lines[-1].startswith("session_id:"):
        lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()
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
    env = os.environ.copy()
    # Provider hint: pass EMPEROR_CLAW_LLM_PROVIDER so Hermes skills can auto-detect.
    # The actual API key is configured by the user in ~/.hermes/.env or environment.
    if _agent_llm_provider:
        env["EMPEROR_CLAW_LLM_PROVIDER"] = _agent_llm_provider
    # start_new_session puts Hermes (and any browser/tool children it spawns)
    # in their own process group, so a timeout can signal the whole tree.
    proc = subprocess.Popen(cmd, text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    started = time.time()
    last_status = 0.0
    while proc.poll() is None:
        elapsed = time.time() - started
        if elapsed > HERMES_TIMEOUT_SECONDS:
            _terminate_turn(proc)
            stdout, stderr = proc.communicate()
            raise subprocess.TimeoutExpired(cmd, HERMES_TIMEOUT_SECONDS, output=stdout, stderr=stderr)
        if time.time() - last_status >= 3:
            try:
                control = fetch_runtime_control(message)
            except Exception as exc:
                # Temporary server failures do not abandon an otherwise healthy turn.
                log(f"runtime control polling failed: {exc}")
                control = {}
            if control.get("commands") or control.get("cancelled"):
                _terminate_turn(proc)
                proc.communicate()
                apply_runtime_controls(control, state if state is not None else {})
                raise TurnInterrupted("Stopped by operator")
            # Preference order, most to least specific: the model's real
            # reasoning, then a real tool call, then honest elapsed time.
            # Nothing here is inferred or invented.
            activity = (
                latest_reasoning_activity(session_id, started)
                or latest_tool_activity(started)
                or format_turn_activity(elapsed, resumed)
            )
            update_chat_status(message, typing=True, execution_state="acting", activity=activity)
            last_status = time.time()
        time.sleep(0.5)
    stdout, stderr = proc.communicate()
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


# Reasoning transcript of the most recent turn, or None.
#
# It lives here rather than in run_hermes's return value because the transcript
# cannot be posted until the reply has been sent and the control plane has
# handed back the id of the message it created. The bridge processes one message
# at a time in a single thread, so there is exactly one "most recent turn";
# run_hermes clears this at the start of every turn so a failed turn can never
# attach a previous turn's thinking to a new reply.
_last_turn_reasoning: str | None = None


def run_hermes(message: Dict[str, Any], state: Dict[str, Any]) -> str:
    thread_id = str(message.get("threadId") or message.get("thread_id") or "team")
    text = str(message.get("text") or "")
    roster_context = format_agent_roster(AGENT_ID)
    shared_context = format_company_brain_context(message)
    # A DM runs in its own session, so it needs the team channel read into the
    # turn explicitly; team turns already carry it in their own session.
    main_chat_context = format_main_chat_context(message) if is_direct_thread(message, state) else ""
    prompt = (
        "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
        f"Agent name: {AGENT_NAME}\n"
        f"Agent role: {AGENT_ROLE}\n"
        + (f"Role instructions:\n{AGENT_INSTRUCTIONS}\n\n" if AGENT_INSTRUCTIONS else "")
        +
        Path(__file__).resolve().parent.parent.joinpath("operating-guide.md").read_text(encoding="utf-8") + "\n\n"
        + "Reply to the latest message. Do not recap old context unless asked.\n"
        "Use Emperor tools only when the request needs durable state, exact chat history, or a real state change.\n"
        "For reusable knowledge, create or update a normal Company Brain note with top-level status: active for established knowledge; use status: draft only when explicitly uncertain.\n"
        "When writing Knowledge & Rules, use Obsidian-style markdown notes: frontmatter with scope/type/status/owner/tags, one reusable rule per note, explicit [[wikilinks]], and Evidence/Related sections when useful.\n"
        "Do not fake folders in note titles; Emperor places notes by company/customer/project/agent scope.\n"
        "Do not mention projects, tasks, resources, or Storage unless they are relevant to the user's request.\n"
        "Emperor is the source of truth. If local memory and Emperor disagree, prefer Emperor and surface the mismatch.\n\n"
        "Where to look in Emperor:\n"
        "- Past chat/history: emperor_list_threads, then emperor_get_thread_messages.\n"
        "- Team roster: emperor_request GET /agents.\n"
        "- Projects/tasks: emperor_list_projects, emperor_list_tasks, or scoped GET /projects/{id}, GET /tasks/{id}.\n"
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
        "- Team chat is the shared visible coordination thread for humans and all agents.\n"
        "- ONLY respond to a team chat message if your @name appears in it. If your name is absent, the message is for someone else — stay silent.\n"
        "- To ask a sibling to do something: post in team chat with @SiblingName and one concrete request (use the roster aliases below for the exact @name).\n"
        "- When a sibling @mentions you with a request, complete the work then reply with the answer and @mention them ONCE so it routes back: '@Viktor done, here are the results...'. That reply CLOSES the request.\n"
        "- If you receive a reply that answers a request YOU made, do not reply again — no 'thanks', no acknowledgment, no follow-up @mention. A closing reply ends the exchange; only reply if you have a genuinely new, different request.\n"
        "- Never @mention the same agent twice in a row without a new human message or a materially new question in between — that is what causes infinite back-and-forth.\n"
        "- Informational updates (status, FYI, task done with no one waiting) go to team chat with NO @mention.\n"
        "- Safety net: if you and a sibling exchange more than a few consecutive messages in team chat with no human input, the bridge will automatically pause your replies in that thread until a human sends a new message. Don't rely on this — follow the rules above so it never triggers.\n\n"
        f"{roster_context}\n\n"
        + f"{shared_context}\n\n"
        + (f"{main_chat_context}\n\n" if main_chat_context else "")
        + f"Thread: {thread_id}\n"
        + f"Latest message: {text}"
    )
    session_key = f"{AGENT_NAME}:{thread_id}"
    sessions = state.setdefault("sessions", {})
    resume_id = str(sessions.get(session_key) or "")
    cmd = [
        HERMES_BIN,
        "chat",
        "-Q",
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
    try:
        # resume_id is the only session id we know BEFORE the turn ends, and it
        # is what scopes the reasoning lookup. On a brand-new session it is
        # empty, so that first turn simply reports no reasoning rather than
        # risking a read of some other agent's session.
        result = invoke_hermes(cmd, message, resumed=bool(resume_id), session_id=resume_id, state=state)
    except subprocess.TimeoutExpired as exc:
        _persist_killed_session(sessions, session_key, exc)
        raise
    if result.returncode != 0 and resume_id and "Session not found" in (result.stderr or result.stdout):
        sessions.pop(session_key, None)
        cmd = [part for index, part in enumerate(cmd) if not (part == "--resume" or (index > 0 and cmd[index - 1] == "--resume"))]
        try:
            result = invoke_hermes(cmd, message, resumed=False, state=state)
        except subprocess.TimeoutExpired as exc:
            _persist_killed_session(sessions, session_key, exc)
            raise
    if result.returncode != 0:
        # stderr often contains *only* the `session_id: ...` footer Hermes
        # appends regardless of success/failure — preferring it blindly hides
        # the real error (e.g. an auth failure reported on stdout). Combine
        # both streams and strip the footer so the actual failure surfaces.
        combined = "\n".join(filter(None, [result.stdout, result.stderr]))
        raise RuntimeError(clean_hermes_output(combined) or combined.strip() or "Hermes failed")
    # Hermes writes the final response to stdout, but the automation-friendly
    # `session_id: ...` footer is emitted on stderr so piped stdout stays clean.
    # Parse both streams; otherwise every Emperor message starts a fresh Hermes
    # conversation because the bridge never records the session to resume.
    new_session_id = extract_session_id("\n".join([result.stdout or "", result.stderr or ""]))
    if new_session_id:
        sessions[session_key] = new_session_id
    # ONE read, at the end of the turn — history is not streamed. Reading it now
    # also means the FIRST turn of a session gets a transcript: the live status
    # line only ever knows `resume_id`, which is empty until a session exists,
    # but by here Hermes has printed the id it actually used.
    _last_turn_reasoning = turn_reasoning_history(new_session_id or resume_id, turn_started)
    return clean_hermes_output(result.stdout)


def send_reply(message: Dict[str, Any], text: str) -> str | None:
    """Post the reply and return the id of the stored message, if any.

    The id is what reasoning history is attached to. It can legitimately be
    None: the send route deduplicates identical text within a 2-minute window
    and returns no id in that case, and there is nothing to annotate then.
    """
    if not text:
        return None
    response = api("POST", "/messages/send", body={
        "thread_id": message.get("threadId") or message.get("thread_id"),
        "thread_type": message.get("threadType") or message.get("thread_type") or "direct",
        "agentId": AGENT_ID,
        "text": text,
        "targetAgentId": None,
        "replyToMessageId": message.get("id"),
    })
    message_id = response.get("message_id") if isinstance(response, dict) else None
    return str(message_id) if message_id else None


_pending_input_chars = 0
_pending_output_chars = 0

def report_token_usage(input_chars: int, output_chars: int) -> None:
    """Estimate tokens and report usage to EmperorClaw with model-aware cost tracking.
    Flush every turn; retain failed samples and block further dispatch until acknowledged.
    Counts remain estimates, excluding internal model/tool calls."""
    global _pending_input_chars, _pending_output_chars
    _pending_input_chars += input_chars
    _pending_output_chars += output_chars
    total_input = _pending_input_chars
    total_output = _pending_output_chars
    _pending_input_chars = 0
    _pending_output_chars = 0
    if total_input <= 0 and total_output <= 0:
        return
    try:
        # Estimate tokens: 4 chars ≈ 1 token
        est_input = max(1, total_input // 4)
        est_output = max(1, total_output // 4)
        model = _agent_llm_model or _agent_llm_provider or None
        body: dict = {
            "agentId": AGENT_ID,
            "inputTokens": est_input,
            "outputTokens": est_output,
        }
        if model:
            body["model"] = model
        api("POST", "/agents/report-usage", body=body)
    except Exception:
        # Retain the sample; preflight retries before permitting another turn.
        _pending_input_chars += total_input
        _pending_output_chars += total_output
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


def main() -> int:
    ensure_runtime()
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
    last_heartbeat = time.time()
    while True:
        try:
            if time.time() - last_heartbeat >= 60:
                send_heartbeat(0)
                last_heartbeat = time.time()
            apply_runtime_controls(fetch_runtime_control(), state)
            for message in sync_messages(state):
                message_id = str(message.get("id") or "")
                if not message_id or message_id in (state.get("seen") or []):
                    continue
                # Record DM thread ownership before any routing decision.
                # When a message carries targetAgentId we learn which agent owns that thread,
                # so future agent replies in that thread (which have no targetAgentId) are
                # not mistakenly claimed by @mention detection in other agents' bridges.
                m_target = str(message.get("targetAgentId") or message.get("target_agent_id") or "")
                m_thread = str(message.get("threadId") or message.get("thread_id") or "")
                if m_target and m_thread:
                    state.setdefault("direct_threads", {})[m_thread] = m_target
                ts = message.get("createdAt")
                # ── Cold-start guard (per-thread): after bridge restart, each ──
                #     team-chat thread is frozen until a human message appears in
                #     THAT specific thread. This prevents agent reply storms when
                #     bridges restart and loop-guard counters are fresh, without
                #     the risk of one human message unfreezing all threads globally.
                sender_type = str(message.get("senderType") or "").lower()
                thread_type = str(message.get("threadType") or message.get("thread_type") or "")
                thread_id = str(message.get("threadId") or message.get("thread_id") or "")
                if thread_type == "team" and thread_id:
                    cold_state = state.setdefault("cold_start_threads", {})
                    if sender_type == "human":
                        cold_state[thread_id] = False
                    elif cold_state.get(thread_id, True):
                        # Thread is still frozen — skip agent messages silently
                        remember_seen(state, message_id)
                        if ts:
                            state["lastSeenAt"] = ts
                        save_state(state)  # Persist cold_start_threads
                        continue
                if not is_for_agent(message, agent_id, state):
                    remember_seen(state, message_id)
                    if ts:
                        state["lastSeenAt"] = ts
                    continue
                if not check_budget():
                    # Preserve this message and everything after it for retry.
                    break
                if not check_loop_guard(message, state):
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
                control = fetch_runtime_control(message)
                apply_runtime_controls(control, state)
                if control.get("cancelled") or message.get("deliveryState") == "cancelled":
                    remember_seen(state, message_id)
                    continue
                log(f"dispatching message {message_id}")
                update_chat_status(message, mark_read=True, execution_state="seen")
                update_chat_status(message, typing=True, execution_state="acting")
                send_heartbeat(1)
                text = str(message.get("text") or "")
                try:
                    reply = run_hermes(message, state)
                    try:
                        report_token_usage(len(text), len(reply))
                    except Exception as exc:
                        log(f"usage report pending; future dispatch blocked: {exc}")
                    reply_message_id = send_reply(message, reply)
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
                    update_chat_status(message, typing=False, execution_state="resolved")
                except TurnInterrupted:
                    log(f"operator stopped message {message_id}")
                    try:
                        update_chat_status(message, typing=False)
                    except Exception as status_exc:
                        log(f"failed to clear stopped turn status: {status_exc}")
                except Exception as exc:
                    # Do NOT re-raise here: that used to skip remember_seen()
                    # below, so a message that failed once (bad key, Hermes
                    # crash) was never marked seen and got redispatched every
                    # poll cycle forever — a silent infinite retry loop with
                    # no visible failure and, on a real API key, unbounded
                    # cost. Log it, tell the human, and move on.
                    #
                    # Every recovery call below hits the same Emperor API that
                    # may have just failed (e.g. Emperor Claw mid-deploy) — if
                    # a recovery call itself throws uncaught, it re-escapes
                    # this except block and skips remember_seen() below just
                    # like the original bug, redispatching this message as a
                    # brand-new Hermes turn on the next poll cycle while the
                    # first one may still be running: two independent replies
                    # for the same message. Each call is isolated so one
                    # failure can't take down the rest.
                    try:
                        update_chat_status(message, typing=False, execution_state="seen")
                    except Exception as status_exc:
                        log(f"failed to update chat status for {message_id}: {status_exc}")
                    log(f"error processing message {message_id}: {exc}")
                    try:
                        send_reply(message, f"{AGENT_NAME}: I hit an error and couldn't reply — check the runtime logs.")
                    except Exception as reply_exc:
                        log(f"failed to send error notice for {message_id}: {reply_exc}")
                finally:
                    try:
                        send_heartbeat(0)
                    except Exception as heartbeat_exc:
                        log(f"failed to send heartbeat after {message_id}: {heartbeat_exc}")
                remember_seen(state, message_id)
                if ts:
                    state["lastSeenAt"] = ts
                save_state(state)  # Persist immediately after each dispatch
            save_state(state)
        except Exception as exc:
            log(f"error: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
