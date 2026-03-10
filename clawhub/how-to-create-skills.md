# How to Create Skills for OpenClaw (ClawHub)

Distilled from the `emperor-claw-os` skill and the Emperor Claw agent roster. This is the canonical reference for building new skills.

---

## 1. What Is a Skill?

A **skill** is a text-only directory that teaches an OpenClaw runtime *how to behave* in a specific domain. It contains no executable code — behavior is defined entirely in Markdown.

Skills are installed by OpenClaw via ClawHub:

```bash
openclaw install https://emperorclaw.malecu.eu/api/skills/registry/<skill-slug>
```

Once installed, the OpenClaw runtime reads the `SKILL.md` file and applies it as a behavioral contract.

---

## 2. Skill Directory Structure

Every skill lives in its own folder under `clawhub/` and contains exactly two files:

```
clawhub/
└── your-skill-name/
    ├── SKILL.md      ← Core behavioral contract (required)
    └── README.md     ← Human-facing installation guide (required)
```

### 2.1 SKILL.md — The Contract

This is the single most important file. Everything the agent does is governed by this document.

**Required YAML frontmatter:**

```yaml
---
name: your-skill-slug
description: "One-sentence summary of what this skill does and when to use it."
version: 1.0.0
homepage: https://your-product-url.com
secrets:
  - name: YOUR_API_TOKEN
    description: What this token authenticates.
    required: true
---
```

| Field | Purpose |
|---|---|
| `name` | Machine slug, must match the directory and ClawHub slug |
| `description` | Used by OpenClaw to select the skill |
| `version` | SemVer. Bump on every publish. Must match `## 0) Purpose` version note in the body. |
| `homepage` | Link to the human product/docs |
| `secrets` | Environment variables the runtime must provide (secrets are never in the file itself) |

---

### 2.2 Proven SKILL.md Section Order

Follow this section order. All sections are optional but the ones marked **mandatory** must be present for production skills.

```
## 0) Purpose               [MANDATORY] — What this skill does in 2–4 bullets
## 1) Role Model            [MANDATORY] — Who does what (Owner / Manager / Agents)
  1.1 Owner
  1.2 Manager (this skill)
  1.3 Agents (workers)
  1.4 Entity Hierarchy & Data Model
## 2) Core Principles       [MANDATORY] — Non-negotiable behavioral rules (numbered list)
## 3) Control Plane Integration Guide  — API base URL, auth, all endpoints with payloads
  3.1 Network Endpoint
  3.2 Authentication
  3.3 Target Endpoints & Payloads
  3.4 Status Codes & Error Format
  3.5 First-Time Synchronization (Bootstrap)
  3.6 Worked Examples
  3.7 Step-by-Step Operational Examples
## 4) Default Agents         — Baseline agent roster and model policy
## 5) Structural Mapping     — OpenClaw internal actions → API calls
## 6) Strategic Thinking Layer — Portfolio optimization rules
## 7) Autonomous Execution Loop — The two-loop heartbeat (Strategic + Tactical)
## 8) Skill Library           — Tactic promotion workflow
## 9) Error Handling          — Self-healing protocol
## 10) Model Selection Policy — Role → model priority profiles
## 12. Agent Communication Guidelines  — Writing style rules (ALWAYS put this near top)
```

> **Note on ordering:** The Agent Communication Guidelines (Section 12 in `emperor-claw-os`) are placed at the very top despite the number, because they are read first and most frequently skipped in a rushed parse. Put high-frequency behavioral rules early.

---

### 2.3 README.md — Installation Guide

Short, human-facing. Cover:
1. What the skill does (2–3 bullets)
2. Install command
3. Required environment variables
4. Publish command (ClawHub CLI)
5. Any notes (e.g., "text-only, no runtime code")

**Template:**

```markdown
# Skill Name

Brief one-liner.

## What This Skill Does
- Bullet 1
- Bullet 2

## Install (Direct)
```bash
openclaw install https://your-domain.com/api/skills/registry/your-skill-slug
```

## Required Configuration
```bash
YOUR_API_TOKEN=your_token_here
```

## Publish To ClawHub (CLI)
```bash
npx clawhub publish . --slug your-skill-slug --name "Display Name" --version 1.0.0 --tags latest
```

## Notes
Text-only skill. All behavior is defined in `SKILL.md`.
```

---

## 3. Agent Directory Structure

Beyond the skill itself, each **deployed agent** gets its own folder under `agents/`:

```
agents/
└── your-agent-name/
    ├── AGENTS.md     ← Mission, skill pack, daily execution standard
    ├── IDENTITY.md   ← Name, slug, domain, primary objective
    ├── SOUL.md       ← Personality, communication style, behavioral constraints
    ├── TOOLS.md      ← Toolset, communication protocol, handoff rules, channels
    ├── BOOTSTRAP.md  ← Initialization note, "call this on first run"
    ├── HEARTBEAT.md  ← Heartbeat behavior rules
    ├── MEMORY.md     ← Durable memory structure, current operational intent
    └── USER.md       ← Primary stakeholder name + preferences
```

### File-by-File Cheatsheet

| File | One-line purpose | Key fields |
|---|---|---|
| `IDENTITY.md` | Who is this agent? | Name, Slug, Domain, Primary objective |
| `SOUL.md` | How does it communicate? | Behavioral adjectives, risk disclosure rules |
| `AGENTS.md` | Full operational contract | Mission, Core Skill Pack, Daily Execution Standard, Quality Gate, Skill Runtime, Orchestrator Communication Contract |
| `TOOLS.md` | What APIs/tools it uses | Toolset list, Communication Protocol (STARTED/PROGRESS/BLOCKER/DONE), Handoff Rule, Channels |
| `BOOTSTRAP.md` | First-run init note | "Profile initialized. Update X if scope changes." |
| `HEARTBEAT.md` | Health check behavior | Meaningful progress → send update. Blocked → report. Stale >20m → stall alert. |
| `MEMORY.md` | Persistent scratchpad | Sections: recurring blockers, winning patterns, quality failures, current intent |
| `USER.md` | Human stakeholder prefs | Primary stakeholder name, preferences (proactive/concise/proof) |

---

## 4. Core Principles to Embed in Every Skill

Every skill MUST incorporate these behavioral invariants into its `## 2) Core Principles` section:

1. **Idempotency** — All mutating API calls must send an `Idempotency-Key: <uuid>` header. Retries reuse the same key.
2. **SaaS is system-of-record** — All state changes must be reflected in the control plane immediately.
3. **Proof-gated completion** — Tasks with `proofRequired: true` cannot transition to `done` without validated proof.
4. **Auditability** — Significant actions appear in task events/audit logs on the server AND summarized in the team chat.
5. **Soft delete default** — Use soft delete endpoints; bulk purge requires explicit confirmation.
6. **Coordination visibility** — Every delegation, handoff, block, or incident MUST be posted to the Agent Team Chat.
7. **Human-like communication** — Agents speak naturally in chat, not in raw JSON or log dumps.
8. **State synchronization** — Any local state change → immediate API push. The control plane is always leading.

---

## 5. Communication Guidelines (Non-Negotiable)

These rules must appear clearly in every skill, preferably near the top:

- **Write like a human operator** — No robotic logs in the team chat unless explicitly required by a payload.
- **Agent-to-agent communication** — Write as if passing a shift report to a colleague.
- **Summarize intelligently** — Report root cause and action taken. Don't dump raw logs.
- **Use the STARTED / PROGRESS / BLOCKER / DONE pattern** — Every task the agent touches gets these checkpoints posted to `/api/mcp/messages/send` and `/api/mcp/tasks/{id}/notes`.

---

## 6. Defining Agent Roles

Agents are registered in Emperor Claw via `POST /api/mcp/agents`. Each agent should be defined in the skill with the following standard roles:

| Role | concurrencyLimit | Model Priority |
|---|---|---|
| `operator` | 3 | best_general → strong_general → efficient_general |
| `analyst` | 2 | best_reasoning → strong_reasoning → best_general |
| `builder` | 2 | best_general → strong_general → efficient_general |
| `qa` | 2 | best_reasoning → strong_reasoning → strong_general |

You can define custom roles, but every agent MUST have a `modelPolicyJson` with `preferred_models` and `fallback_models` arrays.

---

## 7. Best Practices

### ✅ DO

- Pin the `version` in the frontmatter and echo it inside the `## 0) Purpose` section.
- Place the Agent Communication Guidelines near the **top** of the file — agents parse sequentially.
- Use numbered, hierarchical sections (`## 3)`, `### 3.1`, `#### 3.3.1`) to make the doc navigable by an LLM in a single context window.
- Include **exact worked examples** for every API endpoint the skill uses. Copy-paste-ready JSON wins.
- Define the **bootstrap sequence explicitly** (what to call, in what order, on first run).
- Define both a **Strategic Loop** (periodic, ~1h) and a **Tactical Loop** (continuous) if the skill is autonomous.
- Write `MEMORY.md` sections for what should be preserved across sessions (blockers, patterns, lessons).
- Treat `HEARTBEAT.md` seriously — define what "stale" means (e.g., >20 minutes with no progress signal).

### ❌ DON'T

- Don't put actual secrets or tokens in any `.md` file. Reference them as env var names only.
- Don't assume the agent will remember context between sessions — `MEMORY.md` and project memory via the API exist precisely to compensate for this.
- Don't create a skill without a clear `## 0) Purpose` and `## 2) Core Principles`. These are what the runtime uses to orient itself.
- Don't skip the `Idempotency-Key` requirement for mutations — duplicate state is your worst enemy.
- Don't silence failures. Agent communication must always include blockers and mitigations.
- Don't define skills with runtime code. Skills are **text-only behavioral contracts** by design.

---

## 8. Publishing a Skill to ClawHub

```bash
# From inside the skill directory (e.g., clawhub/my-skill/)
npx clawhub publish . \
  --slug my-skill \
  --name "My Skill Display Name" \
  --version 1.0.0 \
  --tags latest
```

A shortcut `skill:publish` script is defined in `package.json`:

```bash
npm run skill:publish
```

This copies the `SKILL.md` to both `openclaw-mission-control` and `public/` for web accessibility.

---

## 9. Quick Checklist for a New Skill

```
[ ] clawhub/my-skill/SKILL.md created with correct YAML frontmatter
[ ] version in frontmatter matches version echo in ## 0) Purpose
[ ] ## 2) Core Principles includes idempotency, soft delete, auditability, coordination visibility
[ ] Agent Communication Guidelines section present (natural language, STARTED/PROGRESS/BLOCKER/DONE)
[ ] All API endpoints documented with exact payloads and worked examples
[ ] Bootstrap sequence documented (what to call on first run, in order)
[ ] Default agent roster defined (operator, analyst, builder, qa) with modelPolicyJson
[ ] Two-loop execution model documented if autonomous (Strategic + Tactical)
[ ] clawhub/my-skill/README.md created with install command + required env vars
[ ] agents/<agent-slug>/ folder created with all 8 .md files
[ ] Skill published via `npx clawhub publish` or `npm run skill:publish`
```

---

*Reference implementation: [`clawhub/emperor-claw-os/SKILL.md`](./emperor-claw-os/SKILL.md) — v1.6.0*
