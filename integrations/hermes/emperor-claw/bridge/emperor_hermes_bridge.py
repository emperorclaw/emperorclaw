from __future__ import annotations

import json
import os
import re
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
STATE_PATH = Path(os.environ.get("EMPEROR_CLAW_HERMES_STATE_PATH", Path.home() / ".hermes" / "emperor-bridge-state.json"))
DOCTRINE_RESOURCE_ID = os.environ.get("EMPEROR_CLAW_DOCTRINE_RESOURCE_ID", "").strip()
MAX_SHARED_RESOURCE_CHARS = int(os.environ.get("EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS", "12000"))
# Loop guard: the @mention convention (reply once, then go silent) is a prompt
# convention, not a hard rule — an LLM can still misjudge a "closing" reply as
# needing another response. This is a mechanical backstop: once this agent has
# been triggered by this many consecutive agent-authored messages in the same
# team thread with no human message in between, stop invoking Hermes and post
# one pause notice instead, until a human message resets the counter.
LOOP_GUARD_MAX_AGENT_TURNS = int(os.environ.get("EMPEROR_CLAW_LOOP_GUARD_MAX_TURNS", "3"))


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
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"seen": [], "lastSeenAt": None}


def save_state(state: Dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def remember_seen(state: Dict[str, Any], message_id: str) -> bool:
    seen = list(state.get("seen") or [])
    if message_id in seen:
        return False
    seen.append(message_id)
    state["seen"] = seen[-1000:]
    return True


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
    global AGENT_ID
    if AGENT_ID:
        return AGENT_ID
    payload = api("GET", "/agents", query={"limit": 200})
    agents = payload.get("agents") if isinstance(payload, dict) else []
    for agent in agents if isinstance(agents, list) else []:
        if str(agent.get("name") or "").lower() == AGENT_NAME.lower():
            AGENT_ID = str(agent.get("id"))
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
        alias = sorted(agent_name_aliases(name), key=len)[0] if agent_name_aliases(name) else name
        lines.append(f"- {name}{marker}: @{alias}")
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
            "Use emperor_request GET /resources/context or create/update a draft Knowledge & Rules note via POST /resources when durable doctrine matters."
        )
    return (
        "Company Brain context resolved by Emperor. Use these source ids when citing loaded doctrine; "
        "do not blindly assume every shared resource was injected.\n"
        + "\n\n".join(sections)
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
    query = {"mode": "all"}
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
    api("POST", "/chat/status", body=body)


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


def invoke_hermes(cmd: List[str], message: Dict[str, Any]) -> subprocess.CompletedProcess[str]:
    proc = subprocess.Popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    started = time.time()
    last_status = 0.0
    while proc.poll() is None:
        if time.time() - started > HERMES_TIMEOUT_SECONDS:
            proc.kill()
            stdout, stderr = proc.communicate()
            raise subprocess.TimeoutExpired(cmd, HERMES_TIMEOUT_SECONDS, output=stdout, stderr=stderr)
        if time.time() - last_status >= 3:
            update_chat_status(message, typing=True, execution_state="acting")
            last_status = time.time()
        time.sleep(0.5)
    stdout, stderr = proc.communicate()
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def run_hermes(message: Dict[str, Any], state: Dict[str, Any]) -> str:
    thread_id = str(message.get("threadId") or message.get("thread_id") or "team")
    text = str(message.get("text") or "")
    roster_context = format_agent_roster(AGENT_ID)
    shared_context = format_company_brain_context(message)
    prompt = (
        "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
        f"Agent name: {AGENT_NAME}\n"
        f"Agent role: {AGENT_ROLE}\n"
        + (f"Role instructions:\n{AGENT_INSTRUCTIONS}\n\n" if AGENT_INSTRUCTIONS else "")
        +
        "Reply to the latest message. Do not recap old context unless asked.\n"
        "Use Emperor tools only when the request needs durable state, exact chat history, or a real state change.\n"
        "For reusable knowledge, create or update a normal Company Brain note with frontmatter status: active by default; use status: draft only when explicitly uncertain.\n"
        "When writing Knowledge & Rules, use Obsidian-style markdown notes: frontmatter with scope/type/status/owner/tags, one reusable rule per note, explicit [[wikilinks]], and Evidence/Related sections when useful.\n"
        "Do not fake folders in note titles; Emperor places notes by company/customer/project/agent scope.\n"
        "Do not mention projects, tasks, resources, or Storage unless they are relevant to the user's request.\n"
        "Emperor is the source of truth. If local memory and Emperor disagree, prefer Emperor and surface the mismatch.\n\n"
        "Where to look in Emperor:\n"
        "- Past chat/history: emperor_list_threads, then emperor_get_thread_messages.\n"
        "- Team roster: emperor_request GET /agents.\n"
        "- Projects/tasks: emperor_list_projects, emperor_list_tasks, or scoped GET /projects/{id}, GET /tasks/{id}.\n"
        "- Task progress/history: emperor_request GET /tasks/{id}/notes.\n"
        "- Company Brain / Knowledge & Rules: emperor_request GET /resources/context for resolved context, POST /resources for draft knowledge notes, GET /resources for lookup.\n"
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
        f"{shared_context}\n\n"
        f"Thread: {thread_id}\n"
        f"Latest message: {text}"
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
    result = invoke_hermes(cmd, message)
    if result.returncode != 0 and resume_id and "Session not found" in (result.stderr or result.stdout):
        sessions.pop(session_key, None)
        cmd = [part for index, part in enumerate(cmd) if not (part == "--resume" or (index > 0 and cmd[index - 1] == "--resume"))]
        result = invoke_hermes(cmd, message)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Hermes failed").strip())
    # Hermes writes the final response to stdout, but the automation-friendly
    # `session_id: ...` footer is emitted on stderr so piped stdout stays clean.
    # Parse both streams; otherwise every Emperor message starts a fresh Hermes
    # conversation because the bridge never records the session to resume.
    new_session_id = extract_session_id("\n".join([result.stdout or "", result.stderr or ""]))
    if new_session_id:
        sessions[session_key] = new_session_id
    return clean_hermes_output(result.stdout)


def send_reply(message: Dict[str, Any], text: str) -> None:
    if not text:
        return
    api("POST", "/messages/send", body={
        "thread_id": message.get("threadId") or message.get("thread_id"),
        "thread_type": message.get("threadType") or message.get("thread_type") or "direct",
        "agentId": AGENT_ID,
        "text": text,
        "targetAgentId": None,
    })


def main() -> int:
    ensure_runtime()
    agent_id = ensure_agent()
    send_heartbeat(0)
    state = load_state()
    log(f"started runtime={RUNTIME_ID} agent={AGENT_NAME} agentId={agent_id}")
    last_heartbeat = time.time()
    while True:
        try:
            if time.time() - last_heartbeat >= 60:
                send_heartbeat(0)
                last_heartbeat = time.time()
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
                if not is_for_agent(message, agent_id, state):
                    remember_seen(state, message_id)
                    if ts:
                        state["lastSeenAt"] = ts
                    continue
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
                log(f"dispatching message {message_id}")
                update_chat_status(message, mark_read=True, execution_state="seen")
                update_chat_status(message, typing=True, execution_state="acting")
                send_heartbeat(1)
                try:
                    reply = run_hermes(message, state)
                    send_reply(message, reply)
                    update_chat_status(message, typing=False, execution_state="resolved")
                except Exception:
                    update_chat_status(message, typing=False, execution_state="seen")
                    raise
                finally:
                    send_heartbeat(0)
                remember_seen(state, message_id)
                if ts:
                    state["lastSeenAt"] = ts
            save_state(state)
        except Exception as exc:
            log(f"error: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
