from __future__ import annotations

import json
import os
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict


TOOLSET = "emperor-claw"
DEFAULT_API_URL = "https://emperorclaw.malecu.eu"


def _api_url() -> str:
    return os.environ.get("EMPEROR_CLAW_API_URL", DEFAULT_API_URL).rstrip("/")


def _token() -> str:
    return os.environ.get("EMPEROR_CLAW_API_TOKEN", "").strip()


def _available() -> bool:
    return bool(_token())


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _request(method: str, path: str, body: Dict[str, Any] | None = None, query: Dict[str, Any] | None = None) -> Dict[str, Any]:
    token = _token()
    if not token:
        return {"error": "EMPEROR_CLAW_API_TOKEN is not set"}

    clean_path = "/" + str(path or "").lstrip("/")
    if not clean_path.startswith("/api/"):
        clean_path = "/api/mcp" + clean_path

    url = _api_url() + clean_path
    if query:
        pairs = {k: v for k, v in query.items() if v is not None and v != ""}
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)

    payload = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "hermes-emperor-claw-plugin/0.1.0",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        headers["Idempotency-Key"] = str(uuid.uuid4())

    req = urllib.request.Request(url, data=payload, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
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
    return _json(_request(method, path, body=body, query=query))


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


def emperor_list_tasks(args: Dict[str, Any], **_: Any) -> str:
    query = {
        "projectId": args.get("projectId"),
        "state": args.get("state"),
        "limit": args.get("limit") or 20,
    }
    return _json(_request("GET", "/tasks", query=query))


def emperor_add_task_note(args: Dict[str, Any], **_: Any) -> str:
    task_id = str(args.get("taskId") or "").strip()
    note = str(args.get("note") or "").strip()
    if not task_id or not note:
        return _json({"error": "taskId and note are required"})
    body: Dict[str, Any] = {"note": note}
    if isinstance(args.get("handoff"), dict):
        body["handoff"] = args["handoff"]
    if args.get("agentId"):
        body["agentId"] = args.get("agentId")
    return _json(_request("POST", f"/tasks/{urllib.parse.quote(task_id)}/notes", body=body))


def emperor_send_message(args: Dict[str, Any], **_: Any) -> str:
    text = str(args.get("text") or "").strip()
    if not text:
        return _json({"error": "text is required"})
    body = {
        "text": text,
        "thread_id": args.get("threadId") or args.get("thread_id"),
        "thread_type": args.get("threadType") or args.get("thread_type") or "team",
        "chat_id": args.get("chatId") or args.get("chat_id"),
        "target_agent_id": args.get("targetAgentId") or args.get("target_agent_id"),
    }
    body = {k: v for k, v in body.items() if v not in (None, "")}
    return _json(_request("POST", "/messages/send", body=body))


def emperor_context_hook(**_: Any) -> Dict[str, str]:
    return {
        "context": (
            "Emperor Claw is the durable control plane for projects, tasks, messages, Knowledge & Rules, and Storage. "
            "In Emperor API terms, Knowledge & Rules are resources; Storage files are artifacts. "
            "Do not preload or summarize all projects/tasks by default. Fetch state lazily only when the user request needs it. "
            "For project state use emperor_list_projects or emperor_request GET /projects/{id}; for work items use emperor_list_tasks "
            "with projectId/state filters or emperor_request GET /tasks/{id}; for durable instructions use GET /resources; "
            "for deliverables/files use GET /artifacts. Prefer small scoped reads over broad account scans. "
            "Use resources only for reusable business rules, SOPs, customer facts, templates, and durable instructions. "
            "Use artifacts/Storage for deliverables, exported files, evidence, working documents, uploads, and reports. "
            "Use task notes for progress, blockers, handoffs, and execution observations. "
            "When changing Emperor state, call the Emperor tools first and only then say the change happened."
        )
    }


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
            "Call an Emperor MCP REST endpoint. Paths may be full /api/mcp paths or short MCP paths such as /projects.",
            {
                "method": {"type": "string", "enum": ["GET", "POST", "PATCH", "PUT", "DELETE"]},
                "path": {"type": "string"},
                "query": {"type": "object"},
                "body": {"type": "object"},
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
                "goal": {"type": "string"},
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
            "List Emperor tasks, optionally filtered by project or state.",
            {
                "projectId": {"type": "string"},
                "state": {"type": "string"},
                "limit": {"type": "integer", "default": 50},
            },
        ),
        emperor_list_tasks,
        check_fn=_available,
        requires_env=requires,
        description="List Emperor tasks",
    )
    ctx.register_tool(
        "emperor_add_task_note",
        TOOLSET,
        _schema(
            "Add a progress, blocker, observation, or handoff note to an Emperor task.",
            {
                "taskId": {"type": "string"},
                "note": {"type": "string"},
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
            "Send a message into an Emperor direct or team thread.",
            {
                "text": {"type": "string"},
                "threadId": {"type": "string"},
                "threadType": {"type": "string", "enum": ["direct", "team"]},
                "chatId": {"type": "string"},
                "targetAgentId": {"type": "string"},
            },
            ["text"],
        ),
        emperor_send_message,
        check_fn=_available,
        requires_env=requires,
        description="Send Emperor message",
    )
    ctx.register_hook("pre_llm_call", emperor_context_hook)
