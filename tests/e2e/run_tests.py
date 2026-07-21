#!/usr/bin/env python3
"""EmperorClaw E2E Test Runner — uses MCP API directly (same as bridge does)."""
import json, time, urllib.request, urllib.error, uuid, sys, os

BASE = os.environ.get("EC_URL", "http://localhost:3001")
TOKEN = os.environ.get("EC_TOKEN", "ec_72a35087b809fb4e852dc73d72dd89b492b28d7814e833d0")
PASS, FAIL = "✅", "❌"

def api(method, path, body=None):
    url = f"{BASE}/api/mcp{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

def test(name, condition, detail=""):
    print(f"  {PASS if condition else FAIL} {name}{' — ' + detail if detail else ''}")
    return condition

results = []
def run(name, fn):
    print(f"\n{'='*60}\n{name}\n{'='*60}")
    try:
        ok = fn()
        results.append((name, ok))
        print(f"\n  Result: {PASS if ok else FAIL}")
    except Exception as e:
        print(f"  {FAIL} Error: {e}")
        results.append((name, False))

# ============================================================

def tc01_create_agent():
    """Create a test agent via API and verify it exists."""
    r = api("POST", "/agents", {"name": "E2E Runner", "role": "e2e-tester", "provider": "hermes", "deploymentMode": "local", "llmProvider": "deepseek", "llmModel": "deepseek-v4-flash"})
    agent = r[1].get("agent", {})
    agent_id = agent.get("id", "")
    ok = test("Agent created", bool(agent_id), agent_id[:8] if agent_id else "no id")
    
    # Verify in list
    r2 = api("GET", "/agents")
    agents = r2[1].get("agents", [])
    found = any(a.get("id") == agent_id for a in agents)
    ok &= test("Agent appears in list", found)
    return ok

def tc02_messaging():
    """Send message to an agent and verify reply."""
    # Find an available agent
    r = api("GET", "/agents")
    agents = r[1].get("agents", [])
    hermes_agent = next((a for a in agents if a.get("provider") == "hermes" and a.get("status") == "online"), None)
    if not hermes_agent:
        print("  ⚠️ No online Hermes agent found — skipping messaging test")
        return None  # skip
    
    agent_id = hermes_agent["id"]
    agent_name = hermes_agent["name"]
    print(f"  Using agent: {agent_name} ({agent_id[:8]})")
    
    # Create direct thread
    r = api("POST", "/threads", {"type": "direct", "agentId": agent_id})
    thread = r[1].get("thread", {})
    thread_id = thread.get("id", "")
    ok = test("Thread created", bool(thread_id), thread_id[:8] if thread_id else "")
    
    # Send message
    msg_text = f"E2E TEST [{time.strftime('%H:%M:%S')}]: Reply with just the word PONG"
    r = api("POST", "/messages/send", {"thread_id": thread_id, "text": msg_text, "agentId": agent_id, "thread_type": "direct"})
    ok &= test("Message sent", r[0] in (200, 201), str(r[0]))
    
    # Wait for reply
    print("  Waiting 15s for agent reply...")
    time.sleep(15)
    
    # Check messages in thread
    r = api("GET", f"/threads/{thread_id}/messages")
    msgs = r[1].get("messages", [])
    has_reply = any("PONG" in (m.get("text") or "").upper() for m in msgs)
    ok &= test("Agent replied with PONG", has_reply, f"{len(msgs)} messages in thread")
    return ok

def tc03_pipeline():
    """Create a pipeline and verify it appears."""
    name = f"e2e-test-pipeline-{uuid.uuid4().hex[:6]}"
    r = api("POST", "/pipelines", {
        "name": name, "purpose": "E2E test pipeline",
        "docMarkdown": "Automated test pipeline.",
        "trigger": "manual", "triggerConfig": {},
        "steps": [{"name": "analyze", "taskType": "analysis"}, {"name": "report", "taskType": "content"}],
        "status": "active"
    })
    pipeline = r[1].get("pipeline") or r[1]
    ok = test("Pipeline created", bool(pipeline.get("id")), name)
    
    # Verify in list
    r2 = api("GET", f"/pipelines?name={name}")
    found = len(r2[1].get("pipelines", [])) > 0
    ok &= test("Pipeline appears in list", found)
    return ok

def tc04_knowledge_base():
    """Create a KB entry and read it back."""
    name = f"e2e-test-kb-{uuid.uuid4().hex[:6]}"
    content = f"E2E test KB entry created at {time.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    
    r = api("POST", "/resources", {
        "displayName": name, "resourceType": "knowledge_base",
        "scopeType": "company", "configText": content,
        "isShared": True, "status": "active"
    })
    resource = r[1].get("resource") or r[1]
    res_id = resource.get("id", "")
    ok = test("KB entry created", bool(res_id), name)
    
    # Read it back
    r2 = api("GET", f"/resources/{res_id}")
    got = (r2[1].get("configText") or r2[1].get("resource", {}).get("configText") or "")
    ok &= test("KB content matches", content in got)
    return ok

def tc05_storage():
    """Create folder and upload artifact."""
    folder_name = f"e2e-tests-{uuid.uuid4().hex[:6]}"
    
    # Create folder
    r = api("POST", "/folders", {"name": folder_name})
    folder = r[1].get("folder") or r[1]
    folder_id = folder.get("id", "")
    ok = test("Folder created", bool(folder_id), folder_name)
    
    # Upload file — need multipart, use urllib directly
    boundary = "----E2ETestBoundary"
    body = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"test-output.txt\"\r\n"
        f"Content-Type: text/plain\r\n\r\n"
        f"E2E test successful at {time.strftime('%H:%M:%S')}\r\n"
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"folderId\"\r\n\r\n"
        f"{folder_id}\r\n"
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"kind\"\r\n\r\n"
        f"document\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    
    req = urllib.request.Request(
        f"{BASE}/api/mcp/artifacts/upload",
        data=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            artifact = result.get("artifact") or result
            ok &= test("File uploaded", bool(artifact.get("id")), "test-output.txt")
    except Exception as e:
        ok &= test("File uploaded", False, str(e)[:80])
    
    # Verify folder contents
    r2 = api("GET", f"/folders/{folder_id}/contents")
    contents = r2[1].get("artifacts") or r2[1].get("contents") or []
    ok &= test("File visible in folder", len(contents) > 0, f"{len(contents)} items")
    return ok

def tc06_task():
    """Create task, add note, complete it."""
    # Create or find a project
    r = api("GET", "/projects")
    projects = r[1].get("projects", [])
    proj = projects[0] if projects else None
    if not proj:
        r = api("POST", "/projects", {"goal": "E2E Test Project"})
        proj = r[1].get("project") or r[1]
    proj_id = proj.get("id", "")
    ok = test("Project available", bool(proj_id), proj.get("goal", "")[:30])
    
    # Create task
    r = api("POST", "/tasks", {
        "projectId": proj_id, "taskType": "ops",
        "title": "E2E Test Task", "description": "Automated E2E test",
        "deliverables": ["Test confirmation"], "priority": 50
    })
    task = r[1].get("task") or r[1]
    task_id = task.get("id", "")
    ok &= test("Task created", bool(task_id), f"TASK-{task_id[:8]}")
    
    # Add note
    r = api("POST", f"/tasks/{task_id}/notes", {"content": f"E2E test note at {time.strftime('%H:%M:%S')}"})
    ok &= test("Note added", r[0] in (200, 201), str(r[0]))
    
    # Complete task
    r = api("POST", f"/tasks/{task_id}/result", {"state": "done", "summary": "E2E test completed successfully"})
    ok &= test("Task completed", r[0] in (200, 201), str(r[0]))
    
    # Verify state
    r = api("GET", f"/tasks/{task_id}")
    state = r[1].get("state") or r[1].get("task", {}).get("state") or ""
    ok &= test("Task state is done", state == "done", state)
    return ok

def tc07_budget():
    """Verify budget page loads and shows agents."""
    # Check via web (not API — this page uses Next.js auth, not MCP token)
    req = urllib.request.Request(f"{BASE}/budgets")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode()
            ok = test("Budgets page loads", "Budget" in html)
            ok &= test("Shows agent table", "Agent Budgets" in html or "agent" in html.lower())
    except Exception as e:
        ok = test("Budgets page loads", False, str(e)[:80])
    
    # Check pricing API
    r = api("GET", "/pricing")
    pricing = r[1].get("pricing", [])
    ok &= test("Pricing API returns models", len(pricing) > 0, f"{len(pricing)} models")
    
    # Check report-usage endpoint
    agents_r = api("GET", "/agents")
    agent_id = (agents_r[1].get("agents") or [{}])[0].get("id", "")
    if agent_id:
        r = api("POST", "/agents/report-usage", {"agentId": agent_id, "model": "deepseek-v4-flash", "inputTokens": 100, "outputTokens": 50})
        ok &= test("report-usage works", r[0] == 200, str(r[1].get("ok", "")))
    return ok

# ============================================================

print("EmperorClaw E2E Test Suite")
print(f"Target: {BASE}")
print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

run("TC-01: Agent Creation", tc01_create_agent)
run("TC-02: Messaging", tc02_messaging)
run("TC-03: Pipeline", tc03_pipeline)
run("TC-04: Knowledge Base", tc04_knowledge_base)
run("TC-05: Storage (Folder + Upload)", tc05_storage)
run("TC-06: Task Lifecycle", tc06_task)
run("TC-07: Budget & Cost Tracking", tc07_budget)

# Summary
print(f"\n{'='*60}")
print("SUMMARY")
print(f"{'='*60}")
for name, ok in results:
    if ok is None:
        print(f"  ⏭️  {name} — SKIPPED")
    else:
        print(f"  {PASS if ok else FAIL} {name}")

passed = sum(1 for _, ok in results if ok)
failed = sum(1 for _, ok in results if ok is False)
skipped = sum(1 for _, ok in results if ok is None)
print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(0 if failed == 0 else 1)
