import os
import json
import uuid
import time
import asyncio
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
        self.session_id = f"openclaw-py-{int(time.time())}"

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
        res = await self._http("POST", "/api/mcp/runtime/register", {
            "runtimeId": RUNTIME_ID,
            "name": f"OpenClaw Py ({os.uname().nodename})",
            "hostname": os.uname().nodename,
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
        print(f"[bridge] bootstrap complete. session_id={self.session['id']}")

    async def heartbeat_loop(self):
        while True:
            try:
                await self._http("POST", "/api/mcp/agents/heartbeat", {
                    "agentId": self.agent["id"],
                    "currentLoad": 0
                })
            except Exception as e:
                print(f"[bridge] heartbeat failed: {e}")
            await asyncio.sleep(HEARTBEAT_SEC)

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
            # Ignore our own messages.
            if msg.get("senderId") == self.agent.get("id"):
                return
            
            print(f"[event] {etype} in thread {thread.get('id')}: {msg.get('text')}")
            
            # The runtime decides how to respond.
            if hasattr(self, 'on_message'):
                await self.on_message(msg, thread)
        else:
            print(f"[event] {etype}")

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
        
        # Example handler. Replace this stub with your runtime's real agent logic.
        async def my_brain(msg, thread):
            # 1. Start typing.
            await self.update_status(thread["id"], typing=True, mark_read=True)
            
            # 2. Replace this delay with real model inference / tool use.
            await asyncio.sleep(2)
            
            # 3. Respond in the same thread.
            await self.send_message(
                f"Acknowledged {msg.get('senderType')}, Python bridge is processing in this thread.", 
                thread_id=thread["id"], 
                thread_type=thread.get("type", "team")
            )
            
            # 4. Stop typing.
            await self.update_status(thread["id"], typing=False)

        self.on_message = my_brain
        
        # Start background loops
        asyncio.create_task(self.heartbeat_loop())
        asyncio.create_task(self.ws_loop())
        
        await self.send_message(f"Python bridge online. Agent: {self.agent['name']}")
        
        # Keep alive
        while True:
            await asyncio.sleep(3600)

if __name__ == "__main__":
    bridge = EmperorBridge()
    try:
        asyncio.run(bridge.start())
    except KeyboardInterrupt:
        print("\n[bridge] exiting...")
