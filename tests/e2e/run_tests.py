#!/usr/bin/env python3
"""EmperorClaw E2E v2 — 12 comprehensive tests."""
import json, time, urllib.request, uuid, sys, os

BASE = os.environ.get("EC_URL", "http://localhost:3001")
TOKEN = os.environ.get("EC_TOKEN", "ec_72a35087b809fb4e852dc73d72dd89b492b28d7814e833d0")
P, F = "\u2705", "\u274c"

def api(method, path, body=None, hdrs=None):
    url = f"{BASE}/api/mcp{path}"
    data = json.dumps(body).encode() if body else None
    h = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())}
    if hdrs: h.update(hdrs)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except: return e.code, e.read().decode()

def ok(label, cond, detail=""):
    print(f"  {P if cond else F} {label}{' — '+str(detail) if detail else ''}")
    return cond

results = []
def case(name, fn):
    print(f"\n{'='*50}\n{name}\n{'='*50}")
    try:
        r = fn(); results.append((name, r))
        print(f"  -> {P if r else F}")
    except Exception as e:
        print(f"  {F} {e}"); results.append((name, False))

# ======================== CORE 1-7 ========================

def tc01():
    r = api("POST","/agents",{"name":"E2E Agent","role":"e2e","provider":"hermes","deploymentMode":"local","llmProvider":"deepseek","llmModel":"deepseek-v4-flash"})
    aid = (r[1].get("agent") or {}).get("id","")
    o = ok("Created", bool(aid), aid[:12])
    return o and ok("In list", any(a.get("id")==aid for a in api("GET","/agents")[1].get("agents",[])))

def tc02():
    agents = api("GET","/agents")[1].get("agents",[])
    a = next((x for x in agents if x.get("provider")=="hermes" and x.get("status")=="online"), None)
    if not a: print("  No online Hermes agent"); return False
    aid = a["id"]
    print(f"  {a['name']} ({aid[:8]})")
    tid = (api("POST","/threads",{"type":"direct","agentId":aid})[1].get("thread") or {}).get("id","")
    o = ok("Thread", bool(tid), tid[:8])
    o &= ok("Sent", api("POST","/messages/send",{"thread_id":tid,"thread_type":"direct","agentId":aid,"text":f"E2E {time.strftime('%H:%M:%S')}: Reply PONG"})[0] in (200,201))
    print("  Waiting 15s...", end=" ", flush=True); time.sleep(15); print("done")
    msgs = api("GET",f"/threads/{tid}/messages")[1].get("messages",[])
    return o and ok("Replied PONG", any("PONG" in str(m.get("text","")).upper() for m in msgs), f"{len(msgs)} msgs")

def tc03():
    name = f"e2e-pipe-{uuid.uuid4().hex[:6]}"
    pid = (api("POST","/pipelines",{"name":name,"purpose":"E2E","docMarkdown":"E2E.","trigger":"manual","steps":[{"name":"s1"}],"status":"active"})[1].get("pipeline") or {}).get("id","")
    o = ok("Created", bool(pid), name)
    return o and ok("In list", any(p.get("name")==name for p in api("GET","/pipelines")[1].get("pipelines",[])))

def tc04():
    name = f"e2e-kb-{uuid.uuid4().hex[:6]}"; content = f"E2E KB {time.strftime('%H:%M:%S')}"
    rid = (api("POST","/resources",{"name":name,"resourceType":"knowledge_base","provider":"ec","scopeType":"company","configText":content,"isShared":True,"status":"active"})[1].get("resource") or {}).get("id","")
    o = ok("Created", bool(rid), name)
    if rid:
        res = (api("GET",f"/resources/{rid}")[1].get("resource") or {})
        o &= ok("Readable", content in str(res.get("configText","")), res.get("configText","")[:50])
    return o

def tc05():
    pid = api("GET","/projects")[1].get("projects",[{}])[0].get("id","")
    fid = (api("POST","/folders",{"name":f"e2e-f-{uuid.uuid4().hex[:6]}"})[1].get("folder") or {}).get("id","")
    o = ok("Folder", bool(fid), fid[:8] if fid else "no")
    if fid and pid:
        boundary = "----E2E"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nE2E OK\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{fid}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"projectId\"\r\n\r\n{pid}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\ndocument\r\n"
                f"--{boundary}--\r\n").encode()
        req = urllib.request.Request(f"{BASE}/api/mcp/artifacts/upload", data=body,
            headers={"Authorization":f"Bearer {TOKEN}","Content-Type":f"multipart/form-data; boundary={boundary}","Idempotency-Key":str(uuid.uuid4())}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                j = json.loads(resp.read().decode())
                o &= ok("Uploaded", bool((j.get("artifact") or j).get("id")))
        except urllib.error.HTTPError as e: o &= ok("Uploaded", False, f"HTTP {e.code}")
        items = api("GET",f"/folders/{fid}/contents")[1].get("artifacts",[])
        o &= ok("Items in folder", len(items)>0, len(items))
    return o

def tc06():
    pid = api("GET","/projects")[1].get("projects",[{}])[0].get("id","")
    aid = api("GET","/agents")[1].get("agents",[{}])[0].get("id","")
    o = ok("Setup", bool(pid) and bool(aid))
    tid = (api("POST","/tasks",{"projectId":pid,"taskType":"ops","title":f"E2E {uuid.uuid4().hex[:4]}","description":"E2E","acceptanceCriteria":["OK"],"deliverables":["Rpt"],"priority":50})[1].get("task") or {}).get("id","")
    o &= ok("Task created", bool(tid), tid[:8])
    if tid:
        api("POST",f"/tasks/{tid}/assign",{"agentId":aid})
        o &= ok("Note", api("POST",f"/tasks/{tid}/notes",{"agentId":aid,"note":"E2E"})[0] in (200,201))
        o &= ok("Complete", api("POST",f"/tasks/{tid}/result",{"agentId":aid,"state":"done","summary":"Done"})[0] in (200,201))
        st = (api("GET",f"/tasks/{tid}")[1].get("task") or {}).get("state","")
        o &= ok("State=done", st in ("done","review"), st)
    return o

def tc07():
    o = ok("Pricing API", len(api("GET","/pricing")[1].get("pricing",[]))>0)
    aid = api("GET","/agents")[1].get("agents",[{}])[0].get("id","")
    if aid:
        api("PATCH",f"/agents/{aid}",{"llmModel":"deepseek-v4-flash"})
        r = api("POST","/agents/report-usage",{"agentId":aid,"inputTokens":500000,"outputTokens":100000})
        cc = r[1].get("costCents",0) if isinstance(r[1],dict) else 0
        o &= ok("report-usage OK", r[1].get("ok")==True)
        o &= ok(f"Cost > 0", cc > 0, f"{cc}\u00a2")
        o &= ok("Cost ~10\u00a2", 7 <= cc <= 13, f"{cc}\u00a2")
    return o

# ======================== EXTENDED 8-12 ========================

def tc08():
    """Customers CRUD"""
    name = f"E2E Customer {uuid.uuid4().hex[:6]}"
    r = api("POST","/customers",{"name":name,"notes":"E2E notes"})
    cid = (r[1].get("customer") or r[1]).get("id","")
    o = ok("Created", bool(cid), name)
    o &= ok("In list", any(c.get("id")==cid for c in api("GET","/customers")[1].get("customers",[])))
    r = api("PATCH",f"/customers/{cid}",{"notes":"Updated"})
    o &= ok("Updated", r[0] in (200,201))
    found = next((x for x in api("GET","/customers")[1].get("customers",[]) if x.get("id")==cid), {})
    o &= ok("Notes updated", "Updated" in str(found.get("notes","")))
    return o and ok("Deleted", api("DELETE",f"/customers/{cid}")[0] in (200,201,204))

def tc09():
    """Incidents"""
    pid = api("GET","/projects")[1].get("projects",[{}])[0].get("id","")
    if not pid: return False
    r = api("POST","/incidents",{"summary":"E2E Test Incident","severity":"low","reasonCode":"test","projectId":pid})
    iid = (r[1].get("incident") or r[1]).get("id","")
    o = ok("Created", bool(iid), iid[:8] if iid else "no")
    r = api("PATCH",f"/incidents/{iid}",{"status":"resolved"})
    return o and ok("Resolved", r[0] in (200,201))

def tc10():
    """Heartbeat + agent memory"""
    aid = api("GET","/agents")[1].get("agents",[{}])[0].get("id","")
    o = ok("Agent exists", bool(aid), aid[:8] if aid else "no")
    if aid:
        r = api("POST","/agents/heartbeat",{"agentId":aid,"currentLoad":0})
        o &= ok("Heartbeat", r[0] in (200,201))
        r = api("POST",f"/agents/{aid}/memory",{"kind":"e2e","content":"E2E memory","summary":"Test"})
        o &= ok("Memory write", r[0] in (200,201,204))
    return o

def tc11():
    """Budget enforcement: set 1¢ budget, exceed it, verify paused, reactivate"""
    aid = api("GET","/agents")[1].get("agents",[{}])[0].get("id","")
    if not aid: return False
    # Reset cost & tokens, set 1¢ budget
    api("PATCH",f"/agents/{aid}",{"monthlyBudgetCents":1,"monthlyCostCents":0,"monthlyTokenUsage":0,"budgetStatus":"active"})
    r = api("POST","/agents/report-usage",{"agentId":aid,"inputTokens":200000,"outputTokens":50000})
    bs = r[1].get("budgetStatus","") if isinstance(r[1],dict) else ""
    cc = r[1].get("costCents",0) if isinstance(r[1],dict) else 0
    o = ok(f"Reported {cc}¢", cc > 0, f"{cc}¢")
    o &= ok("Paused on over-budget", bs == "paused", bs)
    # Reactivate
    r2 = api("PATCH",f"/agents/{aid}",{"budgetStatus":"active","monthlyBudgetCents":0})
    return o and ok("Reactivated", r2[0] in (200,201))

def tc12():
    """Team threads"""
    tid = (api("POST","/threads",{"type":"team"})[1].get("thread") or {}).get("id","")
    o = ok("Team thread created", bool(tid), tid[:8] if tid else "no")
    if tid:
        r = api("POST",f"/threads/{tid}/messages",{"text":"E2E team msg","agentId":"test"})
        o &= ok("Message sent", r[0] in (200,201))
        msgs = api("GET",f"/threads/{tid}/messages")[1].get("messages",[])
        o &= ok("Message visible", len(msgs)>0, f"{len(msgs)} msgs")
    return o

# ============================================================
print(f"EmperorClaw E2E v2 — {BASE}")
print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

for name, fn in [
    ("TC-01 Agent Creation", tc01), ("TC-02 Messaging (PONG)", tc02),
    ("TC-03 Pipeline", tc03), ("TC-04 Knowledge Base", tc04),
    ("TC-05 Storage", tc05), ("TC-06 Task Lifecycle", tc06),
    ("TC-07 Budget & Cost", tc07), ("TC-08 Customers CRUD", tc08),
    ("TC-09 Incidents", tc09), ("TC-10 Heartbeat+Memory", tc10),
    ("TC-11 Budget Enforcement", tc11), ("TC-12 Team Threads", tc12),
]:
    case(name, fn)

ps = sum(1 for _,r in results if r)
fs = sum(1 for _,r in results if not r)
print(f"\n{'='*50}\n{ps}/{ps+fs} passed")
for n,r in results: print(f"  {P if r else F} {n}")
sys.exit(0 if fs==0 else 1)
