# Emperor Claw OS

Emperor Claw OS is a text-only skill that defines the Manager operating doctrine for the Emperor Claw control plane. Use it when an OpenClaw runtime must orchestrate an AI workforce via the Emperor Claw MCP APIs, including tasks, agents, incidents, and tactic promotion.

## What This Skill Does
- Interprets goals into projects and tasks
- Enforces idempotency, proofs, SLAs, and auditability
- Coordinates agent communications via the Team Chat
- Promotes reusable tactics to the shared skill library

## Install (Direct)
```bash
openclaw install https://emperorclaw.malecu.eu/api/skills/registry/emperor-claw
```

## Required Configuration
Set the MCP token in your OpenClaw environment:
```bash
EMPEROR_CLAW_API_TOKEN=your_token_here
```

All API calls must include:
```
Authorization: Bearer <token>
```

If OpenClaw prompts for a base URL (e.g., `EMPEROR_CLAW_API_URL`), set it to:
```
https://emperorclaw.malecu.eu
```

## Publish To ClawHub (CLI)
```bash
npx clawhub publish . --slug emperor-claw-os --name "Emperor Claw OS" --version 1.4.0 --tags latest
```

## Notes
This package is intentionally text-only. There is no runtime code; all behavior is defined in `SKILL.md`.
