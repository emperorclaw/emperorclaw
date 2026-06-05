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
AGENT_ID = os.environ.get("EMPEROR_CLAW_AGENT_ID", "").strip()
RUNTIME_ID = os.environ.get("EMPEROR_CLAW_RUNTIME_ID", f"hermes-{socket.gethostname()}-{uuid.uuid4().hex[:8]}")
HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
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


def is_for_agent(message: Dict[str, Any], agent_id: str) -> bool:
    sender_type = str(message.get("senderType") or "").lower()
    if sender_type == "agent":
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


def run_hermes(message: Dict[str, Any]) -> str:
    thread_id = str(message.get("threadId") or message.get("thread_id") or "team")
    text = str(message.get("text") or "")
    prompt = (
        "You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
        "Use Emperor tools for real state changes. Reply only to the latest message.\n\n"
        f"Thread: {thread_id}\n"
        f"Latest message: {text}"
    )
    cmd = [
        HERMES_BIN,
        "chat",
        "-Q",
        "--source",
        "emperor",
        "--resume",
        f"emperor:{AGENT_NAME}:{thread_id}",
        "--toolsets",
        "emperor-claw",
        "--skills",
        "emperor-claw:emperor-claw",
        "-q",
        prompt,
    ]
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=HERMES_TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Hermes failed").strip())
    return result.stdout.strip()


def send_reply(message: Dict[str, Any], text: str) -> None:
    if not text:
        return
    api("POST", "/messages/send", body={
        "thread_id": message.get("threadId") or message.get("thread_id"),
        "thread_type": message.get("threadType") or message.get("thread_type") or "direct",
        "text": text,
        "target_agent_id": None,
    })


def main() -> int:
    ensure_runtime()
    agent_id = ensure_agent()
    state = load_state()
    log(f"started runtime={RUNTIME_ID} agent={AGENT_NAME} agentId={agent_id}")
    while True:
        try:
            for message in sync_messages(state):
                message_id = str(message.get("id") or "")
                if not message_id or not remember_seen(state, message_id):
                    continue
                ts = message.get("createdAt")
                if ts:
                    state["lastSeenAt"] = ts
                if not is_for_agent(message, agent_id):
                    continue
                log(f"dispatching message {message_id}")
                reply = run_hermes(message)
                send_reply(message, reply)
            save_state(state)
        except Exception as exc:
            log(f"error: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
