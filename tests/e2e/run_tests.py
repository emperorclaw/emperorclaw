#!/usr/bin/env python3
"""EmperorClaw E2E v7"""
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

# ============================================================
def tc01():
    r = api("POST","/agents",{"name":"E2E v7","role":"e2e","provider":"hermes","deploymentMode":"local","llmProvider":"deepseek","llmModel":"deepseek-v4-flash"})
    aid = (r[1].get("agent") or {}).get("id","")
    o = ok("Agent created", bool(aid), aid[:12])
    r2 = api("GET","/agents")
    return o and ok("In list", any(a.get("id")==aid for a in r2[1].get("agents",[])))

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
    r = api("POST","/pipelines",{"name":name,"purpose":"E2E","docMarkdown":"E2E.","trigger":"manual","steps":[{"name":"s1"}],"status":"active"})
    pid = (r[1].get("pipeline") or r[1]).get("id","")
    o = ok("Created", bool(pid), name)
    return o and ok("In list", any(p.get("name")==name for p in api("GET","/pipelines")[1].get("pipelines",[])))

def tc04():
    name = f"e2e-kb-{uuid.uuid4().hex[:6]}"; content = f"E2E KB {time.strftime('%H:%M:%S')}"
    rid = (api("POST","/resources",{"name":name,"resourceType":"knowledge_base","provider":"ec","scopeType":"company","configText":content,"isShared":True,"status":"active"})[1].get("resource") or {}).get("id","")
    o = ok("Created", bool(rid), name)
    if rid:
        res = (api("GET",f"/resources/{rid}")[1].get("resource") or {})
        o &= ok("Readable", content in str(res.get("configText","")), f"got: {res.get('configText','')[:50]}")
    return o

def tc05():
    pid = api("GET","/projects")[1].get("projects",[{}])[0].get("id","")
    fid = (api("POST","/folders",{"name":f"e2e-f-{uuid.uuid4().hex[:6]}"})[1].get("folder") or {}).get("id","")
    o = ok("Folder", bool(fid), fid[:8] if fid else "no")
    if fid and pid:
        # Multipart upload with required fields
        boundary = "----E2EFinal"
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nE2E OK\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{fid}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"projectId\"\r\n\r\n{pid}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\ndocument\r\n"
            f"--{boundary}--\r\n"
        ).encode()
        req = urllib.request.Request(f"{BASE}/api/mcp/artifacts/upload", data=body,
            headers={"Authorization":f"Bearer {TOKEN}","Content-Type":f"multipart/form-data; boundary={boundary}","Idempotency-Key":str(uuid.uuid4())}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                j = json.loads(resp.read().decode())
                o &= ok("Uploaded", bool((j.get("artifact") or j).get("id")))
        except urllib.error.HTTPError as e:
            o &= ok("Uploaded", False, f"HTTP {e.code}: {e.read().decode()[:120]}")
        except Exception as e:
            o &= ok("Uploaded", False, str(e)[:80])
        items = api("GET",f"/folders/{fid}/contents")[1].get("artifacts",[])
        o &= ok("Items in folder", len(items)>0, len(items))
    return o

def tc06():
    pid = api("GET","/projects")[1].get("projects",[{}])[0].get("id","")
    aid = api("GET","/agents")[1].get("agents",[{}])[0].get("id","")
    o = ok("Setup", bool(pid) and bool(aid), f"P:{pid[:6]} A:{aid[:6]}")
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

# Run
print(f"EmperorClaw E2E v7 — {BASE}")
for t in [(tc01,"TC-01 Agent Creation"),(tc02,"TC-02 Messaging"),(tc03,"TC-03 Pipeline"),
           (tc04,"TC-04 Knowledge Base"),(tc05,"TC-05 Storage"),(tc06,"TC-06 Task Lifecycle"),
           (tc07,"TC-07 Budget & Cost")]:
    case(t[1], t[0])

ps = sum(1 for _,r in results if r)
fs = sum(1 for _,r in results if not r)
print(f"\n{'='*50}\n{ps}/{ps+fs} passed")
for n,r in results: print(f"  {P if r else F} {n}")
sys.exit(0 if fs==0 else 1)
