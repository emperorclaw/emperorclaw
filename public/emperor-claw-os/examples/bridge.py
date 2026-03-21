import os
import json
import uuid
import time
import asyncio
import platform
import aiohttp
import websockets
from datetime import datetime

# Emperor Claw bridge example (Python/Asyncio).
API_URL = os.getenv("EMPEROR_CLAW_API_URL", "https://emperorclaw.malecu.eu")
API_TOKEN = os.getenv("EMPEROR_CLAW_API_TOKEN")
RUNTIME_ID = os.getenv("EMPEROR_CLAW_RUNTIME_ID", str(uuid.uuid4()))
AGENT_ID = os.getenv("EMPEROR_CLAW_AGENT_ID")
AGENT_NAME = os.getenv("EMPEROR_CLAW_AGENT_NAME", "Viktor")
AGENT_ROLE = os.getenv("EMPEROR_CLAW_AGENT_ROLE", "manager")
HEARTBEAT_SEC = int(os.getenv("EMPEROR_CLAW_HEARTBEAT_SEC", "30"))
SYNC_SEC = int(os.getenv("EMPEROR_CLAW_SYNC_SEC", "15"))
MAX_CONCURRENT_TASKS = int(os.getenv("EMPEROR_CLAW_MAX_CONCURRENT_TASKS", "1"))

if not API_TOKEN:
    raise ValueError("EMPEROR_CLAW_API_TOKEN is required")

class EmperorBridge:
    def __init__(self):
        self.agent = None
        self.runtime = None
        self.session = None
        self.memory = None
        self.company_context = None
        self.integrations = []
        self.socket = None
        self.last_seen_at = None
        self.last_sync_at = None
        self.sync_in_flight = False
        self.claim_in_flight = False
        self.active_tasks = {}
        self.session_id = f"openclaw-py-{int(time.time())}"
        self.on_message = None
        self.on_task = None

    async def _http(self, method, path, body=None, idempotent=False):
        headers = {
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json"
        }
        if idempotent:
            headers["Idempotency-Key"] = str(uuid.uuid4())
            
        url = f"{API_URL}{path}"
        async with aiohttp.ClientSession() as session:
            async with session.request(method, url, headers=headers, json=body) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    print(f"[bridge] error: {method} {path} -> {resp.status} {text}")
                    resp.raise_for_status()
                if resp.status == 204:
                    return None
                return await resp.json()

    async def register_runtime(self):
        print(f"[bridge] registering runtime node: {RUNTIME_ID}")
        hostname = platform.node() or os.getenv("COMPUTERNAME") or os.getenv("HOSTNAME") or "runtime"
        res = await self._http("POST", "/api/mcp/runtime/register", {
            "runtimeId": RUNTIME_ID,
            "name": f"OpenClaw Py ({hostname})",
            "hostname": hostname,
            "gatewayVersion": "py-bridge-1.0",
            "capabilitiesJson": ["bridge", "ws", "memory", "actions", "python"],
            "startedAt": datetime.utcnow().isoformat() + "Z"
        })
        self.runtime = res["runtimeNode"]
        return self.runtime

    async def resolve_agent(self):
        res = await self._http("GET", "/api/mcp/agents?limit=200")
        all_agents = res.get("agents", [])
        
        agent = None
        if AGENT_ID:
            agent = next((a for a in all_agents if a["id"] == AGENT_ID), None)
        if not agent:
            agent = next((a for a in all_agents if a["name"] == AGENT_NAME), None)
            
        if not agent:
            print(f"[bridge] agent {AGENT_NAME} not found, registering...")
            res = await self._http("POST", "/api/mcp/agents", {
                "name": AGENT_NAME,
                "role": AGENT_ROLE,
                "skillsJson": ["python", "bridge"],
                "memory": "## Lifecycle\nPython bridge initialized.\n"
            }, idempotent=True)
            agent = res["agent"]
        
        self.agent = agent
        return agent

    async def bootstrap(self):
        await self.register_runtime()
        await self.resolve_agent()
        
        print(f"[bridge] starting session for {self.agent['name']}")
        res = await self._http("POST", f"/api/mcp/agents/{self.agent['id']}/sessions/start", {
            "runtimeId": RUNTIME_ID,
            "openclawSessionId": self.session_id,
            "sessionType": "main",
            "channel": "python-bridge"
        })
        
        self.session = res["session"]
        self.memory = res["memory"]
        self.company_context = res.get("contextNotes")
        await self.refresh_integrations()
        print(f"[bridge] bootstrap complete. session_id={self.session['id']}")

    async def heartbeat_loop(self):
        while True:
            try:
                await self._http("POST", "/api/mcp/agents/heartbeat", {
                    "agentId": self.agent["id"],
                    "currentLoad": len(self.active_tasks)
                })
            except Exception as e:
                print(f"[bridge] heartbeat failed: {e}")
            await asyncio.sleep(HEARTBEAT_SEC)

    async def sync_loop(self):
        while True:
            try:
                await self.sync_messages()
                await self.sync_control_plane("timer")
            except Exception as e:
                print(f"[bridge] sync failed: {e}")
            await asyncio.sleep(SYNC_SEC)

    async def ws_loop(self):
        ws_url = API_URL.replace("http", "ws") + "/api/mcp/ws"
        headers = {"Authorization": f"Bearer {API_TOKEN}"}
        
        while True:
            try:
                print(f"[bridge] connecting websocket: {ws_url}")
                async with websockets.connect(ws_url, extra_headers=headers) as ws:
                    print("[bridge] websocket connected")
                    while True:
                        msg = await ws.recv()
                        payload = json.loads(msg)
                        await self.handle_event(payload)
            except Exception as e:
                print(f"[bridge] ws error/disconnect: {e}. reconnecting in 5s...")
                await asyncio.sleep(5)

    async def handle_event(self, payload):
        etype = payload.get("type")
        if etype == "thread_message":
            msg = payload.get("message", {})
            thread = payload.get("thread", {})
            if msg.get("senderId") == self.agent.get("id"):
                return
            print(f"[event] {etype} in thread {thread.get('id')}: {msg.get('text')}")
            await self.handle_thread_message(msg, thread)
        elif etype == "new_task":
            print(f"[event] new_task id={payload.get('task', {}).get('id', 'unknown')}")
            await self.sync_control_plane("new_task")
        elif etype == "task_updated":
            task = payload.get("task", {})
            print(f"[event] task_updated id={task.get('id', 'unknown')} state={task.get('state', 'unknown')}")
            await self.handle_task_update(task)
        elif etype == "company_context_updated":
            self.company_context = payload.get("company", {}).get("contextNotes")
            print("[event] company context updated")
        elif etype in ("agent_integration_created", "agent_integration_archived"):
            if payload.get("agentId") == self.agent.get("id"):
                await self.refresh_integrations()
                print(f"[event] integrations refreshed after {etype}")
        else:
            print(f"[event] {etype}")

    async def handle_thread_message(self, msg, thread):
        if self.on_message:
            await self.on_message(msg, thread)

    async def handle_task_update(self, task):
        task_id = task.get("id")
        if not task_id:
            return
        if task.get("assignedAgentId") == self.agent.get("id"):
            self.active_tasks[task_id] = task
        if task.get("state") in ("done", "failed"):
            self.active_tasks.pop(task_id, None)
            await self.checkpoint_memory({
                "reason": "task_updated",
                "lastTaskId": task_id,
                "lastTaskState": task.get("state"),
                "activeTaskCount": len(self.active_tasks),
            }, f"Task {task_id} {task.get('state')}")

    async def sync_messages(self):
        params = "?mode=all"
        if self.last_seen_at:
            params += f"&since={self.last_seen_at}"
        res = await self._http("GET", f"/api/mcp/messages/sync{params}")
        messages = res.get("messages", [])
        if not messages:
            return []
        self.last_seen_at = messages[-1].get("createdAt", self.last_seen_at)
        for msg in messages:
            if msg.get("senderId") == self.agent.get("id"):
                continue
            thread = {
                "id": msg.get("threadId") or msg.get("thread_id") or msg.get("chat_id") or "team",
                "type": msg.get("threadType") or msg.get("thread_type") or "team",
            }
            await self.handle_thread_message(msg, thread)
        return messages

    async def sync_control_plane(self, reason="manual"):
        if self.sync_in_flight:
            return None
        self.sync_in_flight = True
        try:
            health, tasks_res = await asyncio.gather(
                self._http("GET", "/api/mcp/runtime/health"),
                self._http("GET", "/api/mcp/tasks"),
            )
            self.last_sync_at = datetime.utcnow().isoformat() + "Z"
            if isinstance(tasks_res, list):
                tasks = tasks_res
            else:
                tasks = tasks_res.get("tasks", []) if isinstance(tasks_res, dict) else []
            print(f"[bridge] sync {reason}: tasks={len(tasks)} active={len(self.active_tasks)}")
            claimable = [
                task for task in tasks
                if str(task.get("state") or task.get("status") or "").lower() in ("inbox", "queued")
            ]
            if claimable and len(self.active_tasks) < MAX_CONCURRENT_TASKS:
                await self.claim_next_task(reason)
            return {"health": health, "tasks": tasks}
        finally:
            self.sync_in_flight = False

    async def refresh_integrations(self):
        if not self.agent:
            return []
        res = await self._http("GET", f"/api/mcp/agents/{self.agent['id']}/integrations")
        self.integrations = res.get("integrations", [])
        return self.integrations

    async def claim_next_task(self, reason="sync"):
        if self.claim_in_flight or len(self.active_tasks) >= MAX_CONCURRENT_TASKS:
            return None
        self.claim_in_flight = True
        try:
            res = await self._http("POST", "/api/mcp/tasks/claim", {
                "agentId": self.agent["id"],
                "strictOwnerRole": True,
                "allowedRoles": [self.agent.get("role")] if self.agent.get("role") else [],
            })
            task = res.get("task")
            if not task:
                print(f"[bridge] no tasks available during {reason}")
                return None
            self.active_tasks[task["id"]] = task
            print(f"[bridge] claimed task {task['id']} ({task.get('state', 'unknown')})")
            await self.write_task_note(
                task["id"],
                f"Bridge claimed this task during {reason}. This adapter is monitoring lease, thread updates, and checkpoints.",
                {
                    "fromRole": self.agent.get("role") or "agent",
                    "toRole": "executor",
                    "summary": "Bridge claim acknowledgement",
                    "nextStep": "Run local execution or hand off to a real executor.",
                },
            )
            await self.checkpoint_memory({
                "reason": reason,
                "activeTaskIds": list(self.active_tasks.keys()),
                "claimedTaskId": task["id"],
                "claimedTaskState": task.get("state"),
                "lastSyncAt": self.last_sync_at,
            }, f"Claimed task {task['id']}")
            if self.on_task:
                result = await self.on_task(task)
                if result and result.get("state"):
                    await self.report_task_result(task["id"], result)
                    self.active_tasks.pop(task["id"], None)
            return task
        except Exception as e:
            print(f"[bridge] task claim failed: {e}")
            return None
        finally:
            self.claim_in_flight = False

    async def write_task_note(self, task_id, note, handoff=None):
        return await self._http("POST", f"/api/mcp/tasks/{task_id}/notes", {
            "note": note,
            "agentId": self.agent["id"],
            "handoff": handoff,
        })

    async def report_task_result(self, task_id, result):
        return await self._http("POST", f"/api/mcp/tasks/{task_id}/result", {
            "state": result.get("state"),
            "agentId": self.agent["id"],
            "outputJson": result.get("outputJson"),
            "comment": result.get("comment"),
            "approvalRationale": result.get("approvalRationale"),
            "confidence": result.get("confidence", 0),
        })

    async def checkpoint_memory(self, checkpoint_json, summary=None):
        return await self._http("POST", f"/api/mcp/agents/{self.agent['id']}/sessions/{self.session['id']}/checkpoint", {
            "checkpointJson": checkpoint_json,
            "summary": summary,
            "status": "active",
        })

    async def default_message_handler(self, msg, thread):
        await self.update_status(thread["id"], typing=True, mark_read=True)
        await self.write_memory(
            f"Observed thread {thread['id']} message from {msg.get('senderType') or 'unknown'} at {datetime.utcnow().isoformat()}Z.",
            kind="thread_observation",
            task_id=msg.get("taskId"),
            summary=f"Observed thread {thread['id']}",
            metadata={"threadId": thread["id"], "threadType": thread["type"], "senderId": msg.get("senderId")},
        )
        await self.send_message(
            "Acknowledged. I recorded this thread and will keep the session alive.",
            thread_id=thread["id"],
            thread_type=thread["type"],
        )
        await self.update_status(thread["id"], typing=False)
        await self.checkpoint_memory({
            "reason": "thread_message",
            "threadId": thread["id"],
            "threadType": thread["type"],
            "lastSeenMessageId": msg.get("id"),
        }, f"Processed thread {thread['id']}")

    async def default_task_handler(self, task):
        print(f"[agent-brain] task {task['id']} claimed but no executor is attached")
        await self.write_memory(
            f"Claimed task {task['id']} without a local executor attached.",
            kind="task_claim",
            task_id=task["id"],
            project_id=task.get("projectId"),
            summary=f"Claimed task {task['id']}",
            metadata={"taskState": task.get("state"), "reason": "no_executor"},
        )
        return None

    async def write_memory(self, content, kind="context", task_id=None, project_id=None, summary=None, metadata=None, snapshot=None):
        res = await self._http("POST", f"/api/mcp/agents/{self.agent['id']}/memory", {
            "sessionId": self.session["id"],
            "kind": kind,
            "projectId": project_id,
            "taskId": task_id,
            "content": content,
            "summary": summary,
            "metadataJson": metadata or {},
            "snapshot": snapshot,
        })
        self.memory = res
        return res

    async def send_message(self, text, thread_id=None, thread_type="team", target_id=None):
        return await self._http("POST", "/api/mcp/messages/send", {
            "chat_id": "default",
            "text": text,
            "thread_id": thread_id,
            "thread_type": thread_type,
            "targetAgentId": target_id,
            "from_user_id": self.agent["id"]
        })

    async def update_status(self, thread_id, typing=None, mark_read=False):
        return await self._http("POST", "/api/mcp/chat/status/", {
            "threadId": thread_id,
            "agentId": self.agent["id"],
            "typing": typing,
            "markRead": mark_read
        })

    async def start(self):
        await self.bootstrap()
        self.on_message = self.on_message or self.default_message_handler
        self.on_task = self.on_task or self.default_task_handler

        asyncio.create_task(self.heartbeat_loop())
        asyncio.create_task(self.sync_loop())
        asyncio.create_task(self.ws_loop())

        await self.sync_control_plane("startup")
        await self.send_message(f"Python bridge online. Agent: {self.agent['name']}")

        while True:
            await asyncio.sleep(3600)

if __name__ == "__main__":
    bridge = EmperorBridge()
    try:
        asyncio.run(bridge.start())
    except KeyboardInterrupt:
        print("\n[bridge] exiting...")
