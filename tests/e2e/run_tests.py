#!/usr/bin/env python3
"""EmperorClaw E2E Test Suite v3"""
import json, time, urllib.request, urllib.error, uuid, sys, os

BASE = os.environ.get("EC_URL", "http://localhost:3001")
TOKEN = os.environ.get("EC_TOKEN", "ec_72a35087b809fb4e852dc73d72dd89b492b28d7814e833d0")
P, F, S = "\u2705", "\u274c", "\u23ed\ufe0f"

def api(method, path, body=None):
    url = f"{BASE}/api/mcp{path}"
    data = json.dumps(body).encode() if body else None
    h = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())}
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
        print(f"  -> {P if r else (S if r is None else F)}")
    except Exception as e:
        print(f"  {F} {e}"); results.append((name, False))

def tc01():
    r = api("POST","/agents",{"name":"E2E Runner v3","role":"e2e-tester","provider":"hermes","deploymentMode":"local","llmProvider":"deepseek","llmModel":"deepseek-v4-flash"})
    aid = (r[1].get("agent") or {}).get("id","")
    o = ok("Agent created", bool(aid), aid[:12])
    r2 = api("GET","/agents")
    return o and ok("In list", any(a.get("id")==aid for a in r2[1].get("agents",[])))

def tc02():
    r = api("GET","/agents")
    agent = next((a for a in r[1].get("agents",[]) if a.get("provider")=="hermes" and a.get("status")=="online"), None)
    if not agent: print("  No online Hermes agent"); return None
    aid = agent["id"]
    print(f"  Agent: {agent['name']} ({aid[:8]})")
    r = api("POST","/threads",{"type":"direct","agentId":aid})
    tid = (r[1].get("thread") or {}).get("id","")
    o = ok("Thread", bool(tid), tid[:8])
    r = api("POST","/messages/send",{"thread_id":tid,"thread_type":"direct","agentId":aid,"text":f"E2E {time.strftime('%H:%M:%S')}: Reply PONG"})
    o &= ok("Sent", r[0] in (200,201))
    print("  Waiting 15s...", end=" ", flush=True); time.sleep(15); print("done")
    r = api("GET", f"/threads/{tid}/messages")
    has = any("PONG" in str(m.get("text","")).upper() for m in r[1].get("messages",[]))
    return o and ok("Replied PONG", has, f"{len(r[1].get('messages',[]))} msgs")

def tc03():
    name = f"e2e-pipe-{uuid.uuid4().hex[:6]}"
    r = api("POST","/pipelines",{"name":name,"purpose":"E2E test","docMarkdown":"E2E test pipeline.","trigger":"manual","steps":[{"name":"analyze","taskType":"analysis"},{"name":"report","taskType":"content"}],"status":"active"})
    pid = (r[1].get("pipeline") or r[1]).get("id","")
    o = ok("Created", bool(pid), name)
    r2 = api("GET","/pipelines")
    found = any(p.get("name")==name for p in r2[1].get("pipelines",[]))
    return o and ok("In list", found)

def tc04():
    name = f"e2e-kb-{uuid.uuid4().hex[:6]}"; content = f"E2E KB {time.strftime('%H:%M:%S')}"
    r = api("POST","/resources",{"displayName":name,"resourceType":"knowledge_base","provider":"emperor-claw-plugin","scopeType":"company","configText":content,"isShared":True,"status":"active"})
    rid = (r[1].get("resource") or r[1]).get("id","")
    o = ok("Created", bool(rid), name)
    if rid:
        r2 = api("GET",f"/resources/{rid}")
        res = r2[1].get("resource") or r2[1]
        txt = res.get("configText","") if isinstance(res,dict) else str(res)
        return o and ok("Readable", content in txt)

def tc05():
    fname = f"e2e-f-{uuid.uuid4().hex[:6]}"
    r = api("POST","/folders",{"name":fname})
    fid = (r[1].get("folder") or r[1]).get("id","")
    o = ok("Folder", bool(fid), fname)
    data = f"folderId={fid}&kind=document&displayName=test-output.txt".encode()
    req = urllib.request.Request(f"{BASE}/api/mcp/artifacts", data=data,
        headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            j = json.loads(resp.read().decode())
            o &= ok("Uploaded", bool((j.get("artifact") or j).get("id")), "test-output.txt")
    except Exception as e: o &= ok("Uploaded", False, str(e)[:80])
    r2 = api("GET",f"/folders/{fid}/contents")
    items = r2[1].get("artifacts") or r2[1].get("contents") or []
    return o and ok("Items in folder", len(items)>0, len(items))

def tc06():
    r = api("GET","/projects"); projs = r[1].get("projects",[])
    proj = projs[0] if projs else api("POST","/projects",{"goal":"E2E Project"})[1].get("project",{})
    pid = proj.get("id","")
    o = ok("Project", bool(pid), proj.get("goal","")[:30])
    r = api("POST","/tasks",{"projectId":pid,"taskType":"ops","title":f"E2E Task {uuid.uuid4().hex[:4]}","description":"E2E test","acceptanceCriteria":["Passes"],"deliverables":["Report"],"priority":50})
    tid = (r[1].get("task") or r[1]).get("id","")
    o &= ok("Task created", bool(tid), tid[:8])
    if tid:
        r = api("POST",f"/tasks/{tid}/notes",{"content":"E2E note"}); o &= ok("Note added", r[0] in (200,201))
        r = api("POST",f"/tasks/{tid}/result",{"state":"done","summary":"Done"}); o &= ok("Completed", r[0] in (200,201))
        r = api("GET",f"/tasks/{tid}"); st = (r[1].get("task") or r[1]).get("state",""); o &= ok("State=done", st in ("done","review"), st)
    return o

def tc07():
    r = api("GET","/pricing")
    o = ok("Pricing API", len(r[1].get("pricing",[]))>0, f"{len(r[1].get('pricing',[]))} models")
    r = api("GET","/agents"); agents = r[1].get("agents",[])
    aid = agents[0].get("id","") if agents else ""
    if aid:
        api("PATCH",f"/agents/{aid}",{"llmModel":"deepseek-v4-flash"})
        # 500K input + 100K output @ $0.14/$0.28 per 1M = ~$0.098 = ~10 cents
        r = api("POST","/agents/report-usage",{"agentId":aid,"inputTokens":500000,"outputTokens":100000})
        cc = r[1].get("costCents",0) if isinstance(r[1],dict) else 0
        o &= ok("report-usage OK", r[1].get("ok")==True if isinstance(r[1],dict) else False)
        o &= ok(f"Cost={cc}\u00a2", cc > 0, f"${cc/100:.4f}")
        o &= ok("Cost ~$0.10", 7 <= cc <= 13, f"{cc}\u00a2")  # ~10 cents +/- 3
    return o

# ============================================================
print(f"EmperorClaw E2E — {BASE}\nTime: {time.strftime('%Y-%m-%d %H:%M:%S')}")
case("TC-01 Agent Creation", tc01)
case("TC-02 Messaging (PONG)", tc02)
case("TC-03 Pipeline", tc03)
case("TC-04 Knowledge Base", tc04)
case("TC-05 Storage", tc05)
case("TC-06 Task Lifecycle", tc06)
case("TC-07 Budget & Cost", tc07)

print(f"\n{'='*50}\nRESULTS\n{'='*50}")
ps = fs = ss = 0
for name, r in results:
    if r is None: print(f"  {S} {name}"); ss+=1
    elif r: print(f"  {P} {name}"); ps+=1
    else: print(f"  {F} {name}"); fs+=1
print(f"\n{ps}/{ps+fs+ss} passed")
sys.exit(0 if fs==0 else 1)
