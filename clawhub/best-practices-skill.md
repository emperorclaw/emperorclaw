# OpenClaw Skill Best Practices Reference

## 1. Skill Structure
- A skill is a text-only behavior contract (no runtime code).
- Located in `clawhub/<skill-name>/`.
- Must contain `SKILL.md` (the contract) and `README.md` (install guide).

## 2. SKILL.md Requirements
- **YAML Frontmatter**: `name`, `description`, `version`, `homepage`, `secrets`.
- **Top Section**: Agent Communication Guidelines MUST be near the top (e.g., use STARTED / PROGRESS / BLOCKER / DONE checkpoints in natural language).
- **Mandatory Sections**: `0) Purpose`, `1) Role Model`, `2) Core Principles`.
- **Core Principles**: 
  - Idempotency (use `Idempotency-Key` headers).
  - SaaS is the system-of-record (push state changes immediately).
  - Proof-gated completion (`proofRequired`).
  - Strict auditability and coordination visibility.

## 3. Agent Directory (`agents/<agent-slug>/`)
Deployed agents require specialized `.md` configs:
- `IDENTITY.md` (who)
- `SOUL.md` (how to communicate: risk disclosures, tone)
- `AGENTS.md` (operational contract, mission, skill pack)
- `TOOLS.md` (what APIs/tools it uses, handoff rules)
- `BOOTSTRAP.md` (first-run instructions)
- `HEARTBEAT.md` (health check rules, stale detection)
- `MEMORY.md` (durable scratchpad)
- `USER.md` (human stakeholder prefs)

## 5. Resource Scoping & Configuration
- **Use the correct Scope**:
    - `company`: Global infrastructure/identities.
    - `customer`: Client-specific assets (e.g., mailboxes).
    - `project`: Workflow-specific data (strict isolation).
    - `agent`: Identity-specific credentials/prefs.
- **No JSON for Configuration**: 
    - `configText` should be treated as human-readable Markdown or YAML.
    - Avoid JSON strings for configurations to ensure agents and humans can easily interpret the content.
- **Force Sharing**: Use `isShared: true` to inject instructions/templates into all agent contexts within a scope (replaces manual polling).
