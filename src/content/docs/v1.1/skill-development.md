# Skill & Agent Development

A **skill** is a behavioral contract that teaches an OpenClaw runtime how to operate in a specific domain. Skills are text-only and defined entirely in Markdown.

## 1. Skill Directory Structure

Every skill lives in its own folder and contains two primary files:

```
clawhub/
└── your-skill-name/
    ├── SKILL.md      ← Behavioral contract (required)
    └── README.md     ← Human-facing guide (required)
```

### 1.1 SKILL.md — The Contract

This file governs everything the agent does. It must include YAML frontmatter for machine discovery:

```yaml
---
name: your-skill-slug
description: "Brief summary of the skill's purpose."
version: 1.0.0
secrets:
  - name: API_TOKEN
    description: "Token for authentication."
    required: true
---
```

### 1.2 Required Section Order

For optimal parsing by LLMs, follow this section hierarchy:
1. **Purpose**: 2-4 bullets on what the skill achieves.
2. **Role Model**: Define Owner, Manager (the skill), and Agents (workers).
3. **Core Principles**: Non-negotiable behavioral rules (Idempotency, OS mentality).
4. **API Integration**: Exact endpoints, payloads, and bootstrap sequences.
5. **Communication Guidelines**: Style rules (natural language, standard status patterns).

---

## 2. Agent Directory Structure

Beyond the skill, each deployed agent maintains a local state directory under `agents/`:

| File | Purpose |
|---|---|
| `IDENTITY.md` | Name, slug, domain, and primary objective. |
| `SOUL.md` | Personality, communication style, and behavioral constraints. |
| `AGENTS.md` | The full operational contract (mission, skill pack). |
| `TOOLS.md` | Detailed toolset, handoff rules, and communication protocols. |
| `MEMORY.md` | Persistent scratchpad for recurring patterns and blockers. |
| `USER.md` | Human stakeholder preferences (proactive vs concise). |

---

## 3. Core Principles for Every Skill

1. **Idempotency**: All mutations must send an `Idempotency-Key` header.
2. **SaaS System of Record**: Immediate API push for any local state changes.
3. **Proof-Gated Completion**: Tasks cannot move to `done` without validated proof.
4. **Coordination Visibility**: Every delegation or block must be posted to the Agent Team Chat.
5. **No Robotic Logs**: Speak naturally in chat, summarizing root causes and actions.

---

## 4. Publishing to ClawHub

Use the ClawHub CLI to register your skill for distribution:

```bash
npx clawhub publish . \
  --slug my-skill \
  --name "Display Name" \
  --version 1.0.0 \
  --tags latest
```
