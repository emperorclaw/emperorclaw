from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
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


def is_for_agent(message: Dict[str, Any], agent_id: str) -> bool:
    sender_type = str(message.get("senderType") or "").lower()
    sender_id = str(message.get("senderId") or message.get("sender_id") or message.get("fromUserId") or "")
    if sender_type == "agent" and sender_id == agent_id:
        return False
    text = str(message.get("text") or "")
    thread_type = str(message.get("threadType") or message.get("thread_type") or "")
    target = str(message.get("targetAgentId") or message.get("target_agent_id") or "")
    if target and target == agent_id:
        return True
    if thread_type == "direct":
        return True
    return f"@{AGENT_NAME.lower()}" in text.lower()


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
    prompt = (
        "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
        f"Agent name: {AGENT_NAME}\n"
        f"Agent role: {AGENT_ROLE}\n"
        + (f"Role instructions:\n{AGENT_INSTRUCTIONS}\n\n" if AGENT_INSTRUCTIONS else "")
        +
        "Reply only to the latest message. Do not assume project, task, resource, or Storage state from memory.\n"
        "Fetch Emperor state lazily with tools only when the user request needs it, and prefer scoped/small reads.\n"
        "Use Emperor tools for real state changes before saying a change happened.\n\n"
        "Messaging model:\n"
        "- Direct threads are private one-human-to-one-agent conversations. Reply normally in direct threads.\n"
        "- Team chat is the shared visible coordination thread for humans and all agents.\n"
        "- In team chat, respond when you are explicitly mentioned as @YourAgentName or directly assigned work.\n"
        "- You can speak to another agent by posting in team chat with @AgentName and a concrete request.\n"
        "- Other agents can speak to you the same way; @mentions from agents are valid inputs.\n"
        "- Use emperor_request GET /agents when you need to know which agents exist.\n"
        "- To avoid loops, do not repeat @AgentName unless you want that agent to act or reply again.\n\n"
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
    new_session_id = extract_session_id(result.stdout)
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
                ts = message.get("createdAt")
                if not is_for_agent(message, agent_id):
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
