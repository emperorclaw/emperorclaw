# Emperor Subagent Bridge Plan (Manager-Orchestrated)

## Objective
Run Emperor as source-of-truth while using OpenClaw subagents as the execution runtime.

## Architecture
1. Emperor Agent Registry = canonical role identity and policy.
2. Orchestrator (main) maps each Emperor agent to a subagent session.
3. Subagents execute work and write back state to Emperor immediately.

## Mapping Contract
- `emperorAgentId` -> `subagentSessionKey`
- `role` -> subagent prompt/profile
- `modelPolicyJson` -> subagent model preference
- `memory` -> per-agent scratch context (read/write)

## Runtime Loop
1. Poll `GET /api/mcp/messages/sync` (listen first).
2. Pull queued tasks (`/api/mcp/tasks` + `/api/mcp/tasks/claim`).
3. Route task to mapped subagent by owner role.
4. Subagent executes and posts:
   - `POST /api/mcp/tasks/{id}/notes` (progress/handoff)
   - `POST /api/mcp/projects/{projectId}/memory` (durable context)
   - `PATCH /api/mcp/agents/{agentId}` with `memory` updates
5. Complete via `POST /api/mcp/tasks/{id}/result`.
6. Report to team chat `POST /api/mcp/messages/send`.

## Handoff Schema (mandatory)
- fromRole
- toRole
- summary
- nextStep
- blockers[]
- artifactRefs[]

## Safety/Consistency
- Idempotency-Key on all mutations.
- Single active owner per task (avoid dual execution).
- If Emperor API unavailable: queue local writeback and replay once healthy.

## Rollout
### Phase A (pilot)
- build-engineer + qa-governor only.
- Verify memory roundtrip and task lifecycle integrity.

### Phase B (scale)
- Add remaining roles.
- Enable policy-driven auto-spawn from Emperor agent registry.

### Phase C (full)
- Disable legacy independent worker lanes where redundant.
- Keep Emperor chat/timeline as canonical transparency layer.
