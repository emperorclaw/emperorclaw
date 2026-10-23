"""Loopback fake of the Emperor MCP REST API (``/api/mcp/*``) for the Hermes contract harness.

Two jobs, one process (design 0.9 §9.1):

1. **Echo** (the W0 behaviour, kept for ``gateway_probe.py``): every request is appended to
   ``$EMPEROR_ECHO_LOG`` with its bearer token, and any route the fake does not model answers
   ``{"ok": true, "echo": {"path", "authorization"}}``. Tool results then show which token the
   plugin actually read inside a gateway turn.
2. **Fake Emperor** (for ``bridge_contract.py``): an in-memory server for the routes bridge 0.9
   calls: register, heartbeat, sync, send, runs (+ events), control, lean context, goals,
   objectives and profile defaults. Shapes follow ``src/app/api/mcp/**/route.ts``.

Test control lives under ``/__fake/*`` (never under ``/api``), so a bridge can never hit it:

    POST /__fake/agents     {"agents": [{"token", "agentId", "name", "companyId"?}]}
    POST /__fake/messages   {"agentId", "threadId", "text", "senderType"?, "threadType"?, ...} -> {"id"}
    POST /__fake/control    {"agentId", "action": "stop"|"kill"|"replace", "messageId"?} -> {"id"}
    POST /__fake/outage     {"on": bool, "status"?: 503, "paths"?: ["/messages/send", ...]}
    POST /__fake/duplicate  {"agentId", "on": bool}       (register answers duplicateRuntime)
    POST /__fake/reset      {}
    GET  /__fake/state      replies, runs, events, registers, heartbeats, acks, counters

Stdlib only; runs on any Python >= 3.9. ``python emperor_echo.py [port]``.
"""
from __future__ import annotations

import calendar
import json
import os
import sys
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

LOG_PATH = os.environ.get("EMPEROR_ECHO_LOG", "/tmp/emperor_echo_requests.jsonl")
SYNC_WAIT_S = float(os.environ.get("FAKE_EMPEROR_SYNC_WAIT_S", "1.0"))
MAX_EVENTS_PER_BATCH = 200
MAX_EVENTS_BYTES = 128 * 1024

SERVER_CAPABILITIES = ["rich-blocks", "run-events: 1", "run-usage: 2", "coalesced-replies: 1", "runtime-control: 1"]
REPLY_FORMAT_GUIDE = "Reply in Markdown. (fake Emperor reply-format guide)"
PROFILE_DEFAULTS = (
    "compression.threshold_tokens=80000\n"
    "compression.proactive_prune_tokens=48000\n"
    "compression.idle_compact_after_seconds=0\n"
    "approvals.timeout=60\n"
    "agent.restart_drain_timeout=45\n"
    "tools.tool_search.enabled=off\n"
)


def iso(ts: Optional[float] = None) -> str:
    ts = time.time() if ts is None else ts
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + f".{int((ts % 1) * 1000):03d}Z"


def parse_iso(value: str) -> float:
    try:
        base, _, frac = value.rstrip("Z").partition(".")
        t = calendar.timegm(time.strptime(base, "%Y-%m-%dT%H:%M:%S"))
        return t + (float("0." + frac) if frac else 0.0)
    except (ValueError, TypeError):
        return 0.0


class Store:
    """All fake-server state behind one lock. Reads return deep-ish copies via json round trips."""

    def __init__(self) -> None:
        self.lock = threading.Condition()
        self.reset()

    def reset(self) -> None:
        self.agents: Dict[str, Dict[str, Any]] = {}        # token -> agent
        self.messages: List[Dict[str, Any]] = []           # inbound (human/agent -> our agents)
        self.replies: List[Dict[str, Any]] = []            # /messages/send bodies (+ headers)
        self.idempotency: Dict[str, Dict[str, Any]] = {}   # Idempotency-Key -> response
        self.runs: Dict[str, Dict[str, Any]] = {}
        self.run_patches: List[Dict[str, Any]] = []
        self.events: Dict[str, Dict[int, Dict[str, Any]]] = {}  # run id -> seq -> event
        self.event_posts: List[Dict[str, Any]] = []
        self.registers: List[Dict[str, Any]] = []
        self.heartbeats: List[Dict[str, Any]] = []
        self.controls: List[Dict[str, Any]] = []
        self.control_acks: List[str] = []
        self.chat_status: List[Dict[str, Any]] = []
        self.usage_reports: List[Dict[str, Any]] = []
        self.goals: List[Dict[str, Any]] = []
        self.outage: Dict[str, Any] = {"on": False, "status": 503, "paths": None}
        self.duplicate: Dict[str, bool] = {}
        self.counters: Dict[str, int] = {}

    def bump(self, key: str) -> None:
        self.counters[key] = self.counters.get(key, 0) + 1

    def agent_for(self, auth: str, query: Dict[str, str]) -> Dict[str, Any]:
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()
        agent = self.agents.get(token)
        if agent:
            return agent
        agent_id = query.get("agentId") or "unknown-agent"
        return {"token": token, "agentId": agent_id, "name": agent_id, "companyId": "company-unknown"}


STORE = Store()


def _thread_details(agent_id: str, msgs: List[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for m in msgs:
        out.setdefault(m["threadId"], {"id": m["threadId"], "type": m.get("threadType") or "direct",
                                       "title": m.get("threadTitle") or f"Thread {m['threadId'][:8]}",
                                       "members": [agent_id, m.get("senderId") or "human-1"]})
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a: Any) -> None:
        pass

    # ── plumbing ─────────────────────────────────────────────────────────────────────────────

    def _reply(self, payload: Any, status: int = 200, headers: Optional[Dict[str, str]] = None,
               text: Optional[str] = None) -> None:
        body = text.encode() if text is not None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8" if text is not None else "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _body(self) -> Tuple[bytes, Any]:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return raw, json.loads(raw) if raw else {}
        except ValueError:
            return raw, None

    def _log(self, raw: bytes, status: int) -> None:
        entry = {"t": time.time(), "method": self.command, "path": self.path,
                 "authorization": self.headers.get("Authorization", ""),
                 "idempotency_key": self.headers.get("Idempotency-Key"),
                 "status": status, "body": raw.decode("utf-8", "replace")[:2000]}
        with STORE.lock, open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def _handle(self) -> None:
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
        if path == "/healthz":
            self._reply({"ok": True})
            return
        raw, body = self._body()
        if path.startswith("/__fake/"):
            self._fake_control(path, body or {})
            return
        status, payload, headers, text = self._route(path, query, body, raw)
        self._log(raw, status)
        self._reply(payload, status, headers, text)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _handle

    # ── /__fake/* test control ───────────────────────────────────────────────────────────────

    def _fake_control(self, path: str, body: Dict[str, Any]) -> None:
        with STORE.lock:
            if path == "/__fake/reset":
                STORE.reset()
                self._reply({"ok": True})
            elif path == "/__fake/agents":
                for a in body.get("agents", []):
                    STORE.agents[a["token"]] = {"companyId": "company-1", "name": a.get("agentId"), **a}
                self._reply({"ok": True, "agents": list(STORE.agents.values())})
            elif path == "/__fake/messages":
                msg = {"id": body.get("id") or str(uuid.uuid4()), "threadId": body.get("threadId") or str(uuid.uuid4()),
                       "threadType": body.get("threadType", "direct"), "threadTitle": body.get("threadTitle"),
                       "targetAgentId": body["agentId"], "senderType": body.get("senderType", "human"),
                       "senderId": body.get("senderId", "human-1"), "senderName": body.get("senderName", "Jose"),
                       "text": body.get("text", ""), "createdAt": iso(), "deliveryState": "queued",
                       "addressedToYou": True, **{k: v for k, v in body.get("extra", {}).items()}}
                msg["_t"] = parse_iso(msg["createdAt"])
                STORE.messages.append(msg)
                STORE.lock.notify_all()
                self._reply({"ok": True, "id": msg["id"], "threadId": msg["threadId"], "createdAt": msg["createdAt"]})
            elif path == "/__fake/control":
                cmd = {"id": str(uuid.uuid4()), "agentId": body["agentId"], "action": body.get("action", "stop"),
                       "messageId": body.get("messageId"), "threadId": body.get("threadId"), "createdAt": iso()}
                STORE.controls.append(cmd)
                self._reply({"ok": True, "id": cmd["id"]})
            elif path == "/__fake/outage":
                STORE.outage = {"on": bool(body.get("on")), "status": int(body.get("status", 503)),
                                "paths": body.get("paths")}
                self._reply({"ok": True, "outage": STORE.outage})
            elif path == "/__fake/duplicate":
                STORE.duplicate[body["agentId"]] = bool(body.get("on"))
                self._reply({"ok": True})
            elif path == "/__fake/state":
                self._reply(json.loads(json.dumps({
                    "agents": list(STORE.agents.values()), "messages": STORE.messages, "replies": STORE.replies,
                    "runs": STORE.runs, "run_patches": STORE.run_patches,
                    "events": {r: [e for _, e in sorted(ev.items())] for r, ev in STORE.events.items()},
                    "event_posts": STORE.event_posts, "registers": STORE.registers,
                    "heartbeats": STORE.heartbeats[-50:], "controls": STORE.controls,
                    "control_acks": STORE.control_acks, "chat_status": STORE.chat_status[-200:],
                    "usage_reports": STORE.usage_reports, "goals": STORE.goals, "counters": STORE.counters,
                    "outage": STORE.outage}, default=str)))
            else:
                self._reply({"error": f"unknown fake control {path}"}, 404)

    # ── /api/mcp/* ───────────────────────────────────────────────────────────────────────────

    def _route(self, path: str, query: Dict[str, str], body: Any, raw: bytes):
        auth = self.headers.get("Authorization", "")
        sub = path[len("/api/mcp"):] if path.startswith("/api/mcp") else path
        method = self.command
        with STORE.lock:
            parts = sub.split("/")
            if len(parts) > 3 and parts[1:3] == ["agents", "runs"]:
                parts[3] = ":id"
            STORE.bump(f"{method} {'/'.join(parts)}")
            out = STORE.outage
            if out["on"] and sub.startswith("/") and (not out["paths"] or any(sub.startswith(p) for p in out["paths"])):
                STORE.bump("outage_refusals")
                return out["status"], {"error": "fake outage"}, None, None
            agent = STORE.agent_for(auth, query)
        if body is None:
            return 400, {"error": "Request body must be valid JSON"}, None, None
        if sub == "/runtime/register" and method == "POST":
            return self._register(agent, body)
        if sub == "/agents/heartbeat" and method == "POST":
            with STORE.lock:
                STORE.heartbeats.append({"t": iso(), "agentId": agent["agentId"], **body})
            return 200, {"ok": True}, None, None
        if sub == "/messages/sync" and method == "GET":
            return self._sync(agent, query)
        if sub == "/messages/send" and method == "POST":
            return self._send(agent, body)
        if sub == "/agents/runs" and method == "POST":
            return self._run_start(agent, body)
        if sub.startswith("/agents/runs/") and sub.endswith("/events") and method == "POST":
            return self._run_events(agent, sub.split("/")[3], body, raw)
        if sub.startswith("/agents/runs/") and method == "PATCH":
            return self._run_patch(agent, sub.split("/")[3], body)
        if sub == "/agents/control":
            return self._control(agent, method, body)
        if sub == "/context/lean" and method == "GET":
            return self._lean(agent)
        if sub == "/runtime/profile-defaults" and method == "GET":
            return 200, None, {"Cache-Control": "no-store"}, PROFILE_DEFAULTS
        if sub in ("/agents/goals", "/objectives"):
            with STORE.lock:
                if method != "GET":
                    STORE.goals.append({"t": iso(), "agentId": agent["agentId"], "path": sub, "body": body})
                return 200, {"ok": True, "goals": [], "objectives": [], "goal": None}, None, None
        if sub in ("/chat/status", "/chat/reasoning") and method == "POST":
            with STORE.lock:
                STORE.chat_status.append({"t": iso(), "path": sub, "agentId": agent["agentId"], **body})
            return 200, {"ok": True}, None, None
        if sub == "/agents/report-usage" and method == "POST":
            with STORE.lock:
                STORE.usage_reports.append({"agentId": agent["agentId"], **body})
            return 200, {"ok": True}, None, None
        if sub == f"/agents/{agent['agentId']}" and method == "GET":
            return 200, {"agent": {"id": agent["agentId"], "name": agent["name"], "companyId": agent["companyId"],
                                   "runtimeKind": "hermes"}}, None, None
        if sub in ("/organization", "/threads", "/tasks", "/agents", "/resources", "/resources/context") and method == "GET":
            return 200, {"ok": True, "items": [], "threads": [], "tasks": [], "agents": [], "resources": [],
                         "organization": {"name": "Fake Co", "agents": []}}, None, None
        # Everything else: the W0 echo, so plugin tool results reveal the bearer they used.
        return 200, {"ok": True, "echo": {"path": self.path, "authorization": auth}}, None, None

    def _register(self, agent: Dict[str, Any], body: Dict[str, Any]):
        with STORE.lock:
            reg = {"t": iso(), "agentId": agent["agentId"], "companyId": agent["companyId"], **body}
            STORE.registers.append(reg)
            host, topo = body.get("hostname"), body.get("gatewayTopology")
            shared_peers = [r for r in STORE.registers if r.get("hostname") == host and r.get("gatewayTopology") == "shared"]
            shared_ok = all(r["companyId"] == agent["companyId"] for r in shared_peers)
            dup = STORE.duplicate.get(agent["agentId"])
        node = {"runtimeId": body.get("runtimeId"), "name": body.get("name"), "hostname": host,
                "bridgeVersion": body.get("bridgeVersion"), "hermesVersion": body.get("hermesVersion"),
                "gatewayTopology": topo, "deployMode": body.get("deployMode"), "transport": body.get("transport")}
        return 200, {"runtimeNode": node, "serverCapabilities": SERVER_CAPABILITIES,
                     "replyFormatGuide": REPLY_FORMAT_GUIDE,
                     "bridge": {"latestVersion": "0.9.0", "updateState": "current"},
                     "duplicateRuntime": ({"runtimeId": "other-runtime", "hostname": "elsewhere"} if dup else None),
                     "sharedHostOk": shared_ok}, None, None

    def _sync(self, agent: Dict[str, Any], query: Dict[str, str]):
        since = parse_iso(query["since"]) if query.get("since") else 0.0
        retry = set(filter(None, (query.get("retryMessageIds") or "").split(",")))
        deadline = time.time() + SYNC_WAIT_S

        def pick() -> List[Dict[str, Any]]:
            return [m for m in STORE.messages if m["targetAgentId"] == agent["agentId"]
                    and (m["_t"] > since or m["id"] in retry)]

        with STORE.lock:
            msgs = pick()
            while not msgs and time.time() < deadline:
                STORE.lock.wait(max(0.01, deadline - time.time()))
                msgs = pick()
            out = [{k: v for k, v in m.items() if k != "_t"} for m in msgs]
            STORE.bump("sync_messages_returned")
        return 200, {"ok": True, "mode": query.get("mode", "all"), "contextNotes": None,
                     "threads": _thread_details(agent["agentId"], out), "messages": out}, None, None

    def _send(self, agent: Dict[str, Any], body: Dict[str, Any]):
        key = self.headers.get("Idempotency-Key")
        with STORE.lock:
            if key and key in STORE.idempotency:
                STORE.bump("send_replayed")
                return 200, {**STORE.idempotency[key], "replayed": True}, None, None
            mid = str(uuid.uuid4())
            also = [str(x) for x in body.get("alsoResolvesMessageIds") or []]
            reply = {"id": mid, "t": iso(), "agentId": agent["agentId"], "idempotencyKey": key, **body}
            STORE.replies.append(reply)
            for m in STORE.messages:
                if m["id"] in also or m["id"] == body.get("replyToMessageId"):
                    m["deliveryState"] = "resolved"
            resp: Dict[str, Any] = {"ok": True, "message_id": mid,
                                    "thread_id": body.get("threadId") or body.get("thread_id")}
            if also:
                resp["resolvedMessageIds"] = also
            if key:
                STORE.idempotency[key] = resp
        return 200, resp, None, None

    def _run_start(self, agent: Dict[str, Any], body: Dict[str, Any]):
        rid = body.get("id") or str(uuid.uuid4())
        with STORE.lock:
            if rid in STORE.runs:
                return 409, {"error": "Run id is already in use"}, None, None
            run = {"id": rid, "agentId": agent["agentId"], "status": "running", "createdAt": iso(), **body}
            STORE.runs[rid] = run
        return 200, {"run": run}, None, None

    def _run_patch(self, agent: Dict[str, Any], rid: str, body: Dict[str, Any]):
        with STORE.lock:
            STORE.run_patches.append({"t": iso(), "runId": rid, **body})
            run = STORE.runs.setdefault(rid, {"id": rid, "agentId": agent["agentId"], "createdAt": iso()})
            run.update(body)
            if body.get("status") in ("succeeded", "failed", "cancelled"):
                run["endedAt"] = iso()
        return 200, {"run": run}, None, None

    def _run_events(self, agent: Dict[str, Any], rid: str, body: Dict[str, Any], raw: bytes):
        if len(raw) > MAX_EVENTS_BYTES:
            return 413, {"error": "Payload too large"}, None, None
        events = body.get("events") or []
        if len(events) > MAX_EVENTS_PER_BATCH:
            return 413, {"error": f"At most {MAX_EVENTS_PER_BATCH} events per batch"}, None, None
        header = body.get("run")
        with STORE.lock:
            STORE.event_posts.append({"t": iso(), "runId": rid, "n": len(events), "withRunHeader": bool(header)})
            if rid not in STORE.runs:
                if not header:
                    return 409, {"error": "run_not_found"}, None, None
                if header.get("id") not in (None, rid):
                    return 400, {"error": "run.id must match the run id in the path"}, None, None
                STORE.runs[rid] = {"id": rid, "agentId": agent["agentId"], "status": "running", "createdAt": iso(),
                                   **header}
            bucket = STORE.events.setdefault(rid, {})
            accepted = duplicates = 0
            for ev in events:
                seq = int(ev.get("seq", -1))
                if seq in bucket:
                    duplicates += 1
                    continue
                bucket[seq] = {**ev, "receivedAt": iso()}
                accepted += 1
            run = STORE.runs[rid]
        return 200, {"accepted": accepted, "duplicates": duplicates, "lastSeq": max(bucket) if bucket else None,
                     "runStatus": run.get("status", "running")}, None, None

    def _control(self, agent: Dict[str, Any], method: str, body: Dict[str, Any]):
        with STORE.lock:
            if method == "POST":
                STORE.control_acks.append(str(body.get("commandId")))
                return 200, {"ok": True}, None, None
            pending = [c for c in STORE.controls if c["agentId"] == agent["agentId"] and c["id"] not in STORE.control_acks]
        return 200, {"commands": pending, "cancelled": []}, None, None

    def _lean(self, agent: Dict[str, Any]):
        payload = {"agent": {"id": agent["agentId"], "name": agent["name"],
                             "instructions": "You are a fake Emperor agent used by the contract suite."},
                   "doctrine": [], "roster": [], "operatingGuide": "Use Emperor tools to talk to Emperor."}
        etag = '"lean-' + str(abs(hash(json.dumps(payload, sort_keys=True))) % 10**8) + '"'
        if self.headers.get("If-None-Match") == etag:
            return 304, None, {"ETag": etag}, ""
        return 200, payload, {"ETag": etag}, None


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    agents = os.environ.get("FAKE_EMPEROR_AGENTS")
    if agents:
        for a in json.loads(agents):
            STORE.agents[a["token"]] = {"companyId": "company-1", "name": a.get("agentId"), **a}
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(f"fake emperor (echo) on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
