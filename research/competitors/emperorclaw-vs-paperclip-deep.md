# EmperorClaw vs Paperclip — Agent Layer Deep Comparison
> July 2026 · Strategic analysis for product direction

## TL;DR

EmperorClaw is **multi-machine by design** (remote Hermes/OpenClaw agents anywhere). Paperclip is **local-first** (agents run on the same machine). This is our key architectural differentiator — and it matters for production deployments.

---

## 1. Architecture: Where Agents Run

| | EmperorClaw | Paperclip |
|---|---|---|
| **Remote agents** | ✅ Core design. Hermes on a Pi, OpenClaw on a VPS, MCP anywhere | ⚠️ Possible but not first-class |
| **Same-server agents** | 🚧 Planned. Hermes/OC on the EmperorClaw VPS | ✅ Default. All agents local |
| **Multi-machine** | ✅ Each agent on its own hardware | ❌ Single-machine model |
| **Runtime diversity** | ✅ Hermes, OpenClaw, MCP, Claude Code (planned), Codex (planned) | ✅ Claude Code, Codex, Cursor, Hermes, OpenClaw, bash, HTTP |

**Our edge**: Remote-first architecture. A company can have:
- SEO agent on a cheap VPS in Amsterdam
- Lead Gen agent on a Raspberry Pi in the office
- QA agent on a dedicated GPU machine
- All reporting to one EmperorClaw dashboard

**Paperclip's edge**: Same-server is trivial. `npx paperclipai onboard` and you're done.

**Opportunity**: Support BOTH. When creating an agent, ask: "Where will this run?" → "This server" | "Another machine". If same-server, auto-detect Hermes/OC, pre-fill paths, one-click connect. This combines our remote strength with Paperclip's simplicity.

---

## 2. Agent Creation UX

| | EmperorClaw | Paperclip |
|---|---|---|
| **Mental model** | "Hire Agent" (3-step wizard) | "Hire a team" (onboarding flow) |
| **Role templates** | ✅ 8 roles: SEO, Dev, QA, Growth, Content, Accountant, Support, Analyst | ✅ CEO, CTO, Coder, Designer, Marketer, etc. |
| **Doctrine files** | ✅ Pre-written SOUL, AGENTS, BOOTSTRAP, IDENTITY per role | ✅ Role config + prompts |
| **Provider selection** | ✅ Step 2: OpenClaw, Hermes, MCP | Implicit from adapter |
| **Setup guidance** | ✅ Banner with connect commands + LLM prompt + checklist | ✅ CLI walkthrough |

**Status**: We've closed 80% of this gap. The 3-step Hire dialog + SetupBanner + doctrine system is solid.

**Still missing vs Paperclip**:
- Auto-hire: "CEO hires a Coder. You approve it." Agents creating agents.
- Interactive onboarding CLI (`emperorclaw onboard` like `paperclipai onboard`)

---

## 3. Agent Hierarchy & Delegation

| | EmperorClaw | Paperclip |
|---|---|---|
| **Org chart** | ❌ Flat list | ✅ Visual org chart |
| **Manager → reports** | ❌ No parent/child | ✅ Agents have bosses |
| **Delegation** | ❌ Agents can't delegate to each other | ✅ Manager delegates to specialists |
| **Escalation** | ❌ No escalation path | ✅ "If QA can't fix, escalate to CTO" |

**This is our biggest UX gap.** Paperclip's org chart makes the "team" metaphor real. EmperorClaw feels like a list of independent contractors.

**What to build**:
1. `parent_agent_id` column on agents table
2. Visual org chart in the UI (simple tree)
3. Delegation: manager agent can assign tasks to reports
4. Escalation rules: if stuck → escalate to parent

---

## 4. Budgets & Cost Control

| | EmperorClaw | Paperclip |
|---|---|---|
| **Per-agent budget** | ❌ None | ✅ Monthly limit |
| **Warning threshold** | ❌ None | ✅ 80% warning |
| **Hard stop** | ❌ None | ✅ 100% auto-pause |
| **Cost tracking** | ❌ None | ✅ By agent, project, goal, provider, model |

**Why this matters**: Without budgets, a company can't trust agents with API keys. Budgets are the safety net that makes autonomy acceptable.

**What to build**:
1. `monthly_budget_cents` on agents table
2. Token/cost tracking per agent run
3. Warning at 80%, hard stop at 100%
4. Budget reset on billing cycle

---

## 5. Goal Alignment

| | EmperorClaw | Paperclip |
|---|---|---|
| **Mission → Goal → Task** | ❌ No hierarchy | ✅ Full ancestry |
| **Task context** | Task has description only | Task carries parent goal + mission |
| **"Why" awareness** | ❌ Agent doesn't know why | ✅ Every task traces to mission |

**What to build**:
1. `goals` table with parent-child (mission → project goal → task)
2. Tasks auto-inherit goal context
3. Agent prompt includes goal ancestry

---

## 6. Approval Gates & Governance

| | EmperorClaw | Paperclip |
|---|---|---|
| **Human approval** | ❌ No workflow | ✅ Board governance |
| **Agent hiring approval** | N/A | ✅ CEO proposes, human approves |
| **Spending approval** | ❌ None | ✅ Over-budget requires approval |
| **External comms** | ❌ Unrestricted | ✅ Requires approval |

**Our approach is different**: EmperorClaw is RBAC-based (owner/admin/member/viewer). Paperclip is board-based. Both are valid. We should add approval gates for high-risk actions without copying Paperclip's board model.

**What to build**:
1. `approval_required` flag on agent capabilities
2. Pending approval queue in dashboard
3. One-click approve/reject

---

## 7. Heartbeats & Work Discovery

| | EmperorClaw | Paperclip |
|---|---|---|
| **Heartbeat model** | Push (agent reports "I'm alive") | Schedule (wake up every N hours) |
| **Work discovery** | ❌ Passive | ✅ Agent wakes, checks tasks, acts |
| **Watchdog** | ✅ Detects stalled agents | ✅ Detects stalled agents |

**What to improve**: Scheduled heartbeats with work discovery. Agent wakes up → checks for assigned tasks → works on them → reports results. Not just "I'm alive" pings.

---

## 8. Setup Experience

| | EmperorClaw | Paperclip |
|---|---|---|
| **One-command** | ✅ `curl .../install.sh \| bash` (Docker) | ✅ `npx paperclipai onboard` (embedded DB) |
| **Zero-config** | ❌ Needs Docker | ✅ Embedded PostgreSQL |
| **Interactive onboarding** | ❌ Manual after install | ✅ CLI walkthrough |
| **Agent connection** | ✅ SetupBanner with commands + LLM prompt | ✅ CLI adapter config |

**Our differentiator**: The SetupBanner is unique. Paperclip doesn't give you a ready-to-paste LLM prompt with your agent's exact doctrine files. This is a genuinely better onboarding experience for the "connect an agent" step.

**Still missing**: Embedded DB option. Docker is a real barrier. SQLite or embedded Postgres (like Paperclip uses) would make `install.sh` truly zero-dependency.

---

## 9. The "Same Server" Opportunity (Our Unfair Advantage)

Paperclip is local-first by design. EmperorClaw is remote-first by design. But we can do BOTH.

**Scenario**: A small company runs EmperorClaw on one VPS. They want 3 agents: SEO, Content, Support.

**Paperclip way**: Agents run as separate processes on the same machine. Simple, but no isolation.

**EmperorClaw way (remote)**: Each agent on its own machine. Better isolation, but more infrastructure.

**EmperorClaw way (same-server, proposed)**: Agents run on the same VPS as EmperorClaw, each in its own Hermes profile. EmperorClaw manages them directly:
- Auto-detect Hermes/OC installation
- One-click "Connect on this server"
- EmperorClaw can start/stop/restart agent processes
- Shared filesystem → plugin files already present
- No SSH, no manual config, no LLM prompt needed

**This gives us BOTH modes**:
| Mode | Use case | Setup complexity |
|---|---|---|
| Same-server | Solo founder, small team, quick start | Trivial (auto-detect) |
| Remote | Production teams, dedicated hardware, isolation | Guided (SetupBanner) |
| Hybrid | Mix of local + remote agents | Both paths available |

---

## Priority Matrix: What to Build Next

| # | Feature | Impact | Effort | Paperclip gap |
|---|---|---|---|---|
| 1 | **Same-server agent mode** | 🔴 HIGH | 🟡 Medium | Leapfrog them |
| 2 | **Agent hierarchy (parent/child)** | 🔴 HIGH | 🟢 Low | Close gap |
| 3 | **Per-agent budgets** | 🟡 MEDIUM | 🟡 Medium | Close gap |
| 4 | **Goal alignment (mission → task)** | 🟡 MEDIUM | 🟡 Medium | Close gap |
| 5 | **Scheduled heartbeats + work discovery** | 🟡 MEDIUM | 🟡 Medium | Close gap |
| 6 | **Approval gates** | 🟢 LOW | 🟡 Medium | Different approach |
| 7 | **Embedded DB (no Docker)** | 🟢 LOW | 🔴 High | Close gap |
| 8 | **Agents hiring agents** | 🟢 LOW | 🔴 High | Close gap |
| 9 | **Interactive CLI onboarding** | 🟢 LOW | 🟡 Medium | Close gap |

---

## Bottom Line

EmperorClaw's remote-first architecture is a genuine differentiator. Paperclip can't easily match it because their model is local-first. But we're behind on the "team management" layer — org chart, budgets, delegation, goals.

**Winning strategy**: Own the multi-machine agent space (remote + same-server), borrow the best team-management ideas from Paperclip (hierarchy, budgets, goals), and keep our unique edge (doctrine system, SetupBanner, provider abstraction).
