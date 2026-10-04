from __future__ import annotations

import json
import mimetypes
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


def _agent_ref() -> str:
    return (
        os.environ.get("EMPEROR_CLAW_AGENT_ID", "").strip()
        or os.environ.get("EMPEROR_CLAW_AGENT_NAME", "").strip()
    )


def _available() -> bool:
    return bool(_token())


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _request(method: str, path: str, body: Dict[str, Any] | None = None, query: Dict[str, Any] | None = None, timeout: int = 30) -> Dict[str, Any]:
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


def _multipart_upload(url: str, token: str, file_path: str, fields: Dict[str, str], method: str = "POST") -> Dict[str, Any]:
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
        "User-Agent": "hermes-emperor-claw-plugin/0.1.0",
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
    return _json(_request("POST", f"/agents/{urllib.parse.quote(agent)}/memory", body=body))


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
        "limit": args.get("limit") or 100,
        "since": args.get("since"),
    }
    return _json(_request("GET", f"/threads/{urllib.parse.quote(thread_id)}/messages", query=query))


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
    url = _api_url() + "/api/mcp/artifacts/upload"
    return _json(_multipart_upload(url, _token(), file_path, fields))


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
    url = _api_url() + "/api/mcp/artifacts/" + urllib.parse.quote(artifact_id) + "/replace"
    return _json(_multipart_upload(url, _token(), file_path, fields, method="PATCH"))


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
        "agentId": args.get("agentId") or args.get("agent_id") or _agent_ref(),
        "thread_id": args.get("threadId") or args.get("thread_id"),
        "thread_type": args.get("threadType") or args.get("thread_type") or "team",
        "chat_id": args.get("chatId") or args.get("chat_id"),
        "targetAgentId": args.get("targetAgentId") or args.get("target_agent_id"),
    }
    body = {k: v for k, v in body.items() if v not in (None, "")}
    return _json(_request("POST", "/messages/send", body=body))


def emperor_context_hook(**_: Any) -> Dict[str, str]:
    if os.environ.get("EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE") == "1":
        return {"context": "Emperor Claw tools are available for durable state and exact company data."}
    return {
        "context": Path(__file__).with_name("operating-guide.md").read_text(encoding="utf-8") + "\n\n" + (
            "Use Emperor only when the request needs durable state, exact message history, or a real state change; otherwise answer normally. "
            "Do not preload, summarize, or mention projects/tasks/resources/artifacts by default. "
            "Lookup map: past chat/history -> emperor_list_threads then emperor_get_thread_messages; team roster -> GET /agents; "
            "projects -> emperor_list_projects or GET /projects/{id}; task status -> emperor_get_task_overview first; selected task -> GET /tasks/{id}; "
            "task progress/history -> GET /tasks/{id}/notes; project memory -> GET /projects/{id}/memory; "
            "When proposing Knowledge & Rules, use Obsidian-style markdown: frontmatter scope/type/status/owner/tags, one reusable rule per note, explicit [[wikilinks]], Evidence, and Related sections. "
            "Do not fake folders in note titles; Emperor places notes by company/customer/project/agent scope. "
            "browse a folder's contents (subfolders + files) -> emperor_list_folder_contents; "
            "upload a local file to Storage -> emperor_upload_artifact (never emperor_request, never curl). "
            "verify an uploaded file without reading its bytes -> emperor_verify_artifact(artifactId). "
            "Storage is an Emperor abstraction: do not ask for or mention Bunny/backing blob-provider keys during normal uploads. "
            "If upload fails, report an Emperor Storage upload failure with the tool error. "
            "Storage folder workflow: (1) emperor_create_folder(name, projectId/customerId) -> returns folder.id; "
            "(2) for a subfolder: emperor_create_folder(name, projectId, parentFolderId=<id>); "
            "(3) emperor_upload_artifact(filePath, kind, projectId, folderId=<id>) for each file. "
            "Always pass folderId when uploading into a folder. Never upload without folderId and expect files to be grouped. "
            "Use customer/project/month/type folders when possible; search/list before creating duplicates; prefer move/replace over duplicate uploads. "
            "Thread history is REST-readable; do not call it unavailable or WebSocket-only. "
            "Team chat rules: (1) Only act on a team chat message if your @name is explicitly mentioned in it — if your name is absent, the message is for someone else. "
            "(2) To ask a sibling to do something: emperor_send_message(text='@SiblingName <request>', threadType='team'). Discover sibling names first with emperor_request GET /agents. "
            "(3) When responding to a sibling's request, @mention them once in your reply so the message routes back: '@Viktor here are the results...'. "
            "(4) A closing answer ends the exchange: do not send thanks or another acknowledgment; mention only for a new actionable request. "
            "(5) Informational updates (status, FYI, task done with no one waiting) go to team chat with NO @mention. "
            "Use emperor_send_message threadType=direct only when the message must be private. "
            "Never use emperor_send_message to deliver your own reply to the message you are answering: the runtime posts your answer to the current thread automatically, so calling the tool as well duplicates it. It is only for messaging a DIFFERENT thread. "
            "Call Emperor tools before claiming a state change. "
            "emperor_request is not a generic external HTTP client; use terminal/curl or a dedicated plugin for external APIs."
        )
    }


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
                "limit": {"type": "integer", "default": 100},
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
            "Send a message into an Emperor thread OTHER than the one you are answering. Your reply to the current message is delivered automatically by the runtime — do NOT call this tool to answer it, or the thread gets a duplicate. Use it for a sibling handoff in team chat (@Name) or to message a different agent privately.",
            {
                "text": {"type": "string"},
                "agentId": {"type": "string", "description": "Optional sender Emperor agent id/name. Defaults to this Hermes profile's configured agent."},
                "threadId": {"type": "string"},
                "threadType": {"type": "string", "enum": ["direct", "team", "group"]},
                "chatId": {"type": "string"},
                "targetAgentId": {"type": "string", "description": "Target Emperor agent id for direct private messages."},
            },
            ["text"],
        ),
        emperor_send_message,
        check_fn=_available,
        requires_env=requires,
        description="Send Emperor message",
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
    ctx.register_hook("pre_llm_call", emperor_context_hook)
