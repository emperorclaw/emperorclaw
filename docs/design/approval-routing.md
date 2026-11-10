# Approval routing

Status: implemented (Unreleased, after 0.31.3). Supersedes the "directed approver" and "agent approvers" parts of [approvals-in-chat.md](approvals-in-chat.md) (sections 3 D3–D6, 6 and 7). The approval card, its thread and the decision delivery from that design are unchanged.

## What changed

Before: every agent ask notified all owners and admins, any member who could see it could decide it, and agents could not decide at all.

Now each agent ask has one resolved approver, stored on the row when it is created, and escalates up a chain when nobody decides.

## Who approves

`resolveApproverChain` (`src/lib/approval-routing.ts`, pure) builds the chain once, when the ask is created (`createApprovalRequest` for `request_approval`, the REST ask and implicit-on-done; `createActionApproval` for an action set to ask first). First match wins:

1. **Approvers set on the agent** (`agents.approval_settings_json`): one agent, or one or more people.
2. **Approvers set on its team** (`companies.approval_settings_json.teamApprovers[teamId]`). The team is the work's team (the task's team, as `taskContextTeamIds` finds it), else the agent's own team.
3. **Its manager in the org chart**, the same pick as `chartManagerForTask` (the line in the work's team, else the first line), agent or person.
4. **Its owner** (`agents.owner_user_id`), when the chain has no person yet.
5. **Company owners and admins**, always the last step.

From an agent step the chain keeps walking up that agent's own managers until it reaches a person. A setting that adds no usable step (it names only the requester, as when a team's approver is its lead and the lead asks, or nobody eligible) falls through to the next level, never straight to owners and admins.

**People** must be members with the member role or above (never viewers), checked when the setting is saved and offered in the pickers; at resolve time a restricted member who cannot see the ask (its project, or for an action ask its agent) is dropped and the chain falls through. Every agent step must pass `mayAgentApprove`; one that fails is skipped (recorded in `skipped`, shown in the settings preview), and the walk continues from its manager.

The chain is stored in `approvals.approver_chain_json`; the current step (`escalation_level`) is mirrored in `approver_kind` (`agent | users | admins`), `approver_agent_id` and `approver_user_ids`. A later change to the chart or the settings never changes who may decide a pending ask, except that agent authority is re-checked (below).

## Agent authority (`mayAgentApprove`)

An agent may decide an ask only if all hold:

- it is not the requester (no self-approval);
- **chart-derived** approvers (the manager walk, and the managers above a named approver): it is above the requester on the chart (transitively, on any reporting line), and the requester is not above it: a peer, a subordinate or a reporting loop never qualifies (`agentsAbove` is cycle-safe; a loop is reported as `cycle`);
- **explicit** approvers (the agent named by the agent's or its team's setting): an owner or admin choosing it is the grant of authority, so no chart position is needed and it works without any org chart. A direct mutual pair (each is the other's explicit approver, by agent or team setting) is refused when saved, and treated as unusable (`cycle`) when resolving and deciding. Whether a step was explicit is kept in the chain (`source` `agent_setting` / `team_setting`) and re-checked at decision time;
- it is live (not deleted, budget not paused);
- **it may do the action itself**: for an ask-first action, and for a `request_approval` whose `actionType` maps to a governed action, its own effective mode (agent setting, else company setting, else default, via `resolveActionMode`) must be `allowed`. The type is normalized (lowercase, spaces and dashes to `_`) and mapped (`spend` → `spend_money`, `publish` → `post_social`, `delete` → `delete_data`, `email` → `send_email`, `release` → `deploy`, or any catalog key). **Fail closed:** only the plain `task_done` needs no action permission; any other type that maps to no known action can't be decided by an agent at all (`unknown_action`), so its agent steps are skipped and it goes to people;
- for an ask about a project's tasks, it may use that project (`mcpAccessForAgent` + `mcpMayUseProject`).

It is checked when the chain is built, again when the agent decides (`decideApprovalAsAgent`), and again before the sweep escalates to an agent step. A revoked permission therefore stops an agent from deciding at once; the ask then waits for the next step.

**Reversed decision.** approvals-in-chat.md D4 said external and action-policy asks are never delegable to agents. The owner reversed it: they are delegable, but only to a boss agent that may do that action itself. The "allowed" rule above is the safety net D4 provided.

A boss approving an ask never authorizes a risky action by itself. An approved `request_approval` (any `actionType`) only resolves that ask and moves its tasks; it is not an action grant. The action is still gated when it is done: Emperor's own tools run `enforceActionPolicy` on every call (`lib/mcp-server/index.ts` and the REST gate), and `check_action` does the same for outside actions. Only an approval created by an action ask (`metadataJson.kind = "action_policy"`) for that exact caller, action and arguments can satisfy that gate (`approvalMatchesCall` in `lib/action-policy-rules.ts`), once. A task approval never matches it. (An agent that skips `check_action` for its own outside tools is outside this, as it always was.)

## Deciding

- **People** (`PATCH /api/approvals/[id]`, the card, the Inbox, `/approvals`, and the human-session `PATCH /api/mcp/approvals/[id]`): `approvalDecisionAccess` adds `humanMayDecide`. Owners and admins always may (override). Otherwise only the people in the steps reached so far. Anyone else gets `403 { error: "Waiting on Jose", waitingOn }`. An ask from before routing (`approver_kind` NULL) keeps the old rule (any member with access).
- **Agents**: only with a token **bound to the deciding agent** (`company_tokens.agent_id`, as runtime hosts mint with `mintAgentRuntimeToken`). A company-wide token (operator, or a legacy bridge on a shared token naming an agent with `agentId`) is refused with "Approving needs this agent's own token", for both deciding and listing: anyone holding it could act as any boss. Such legacy bridges fail closed: the boss leaves the ask and it escalates to people. The requester is always refused. Through the `decide_approval` MCP tool (`approvalId`, `decision: approve | deny`, `note`). The agent must be an agent step reached so far (otherwise 404), and pass the authority re-check (otherwise 403 with the reason). `list_pending_approvals` lists the asks it may decide. Both resolve the acting agent like other tools: the bound agent, or `agentId` on a company-wide token. REST twins for runtimes that call the agent API (the Hermes plugin's `emperor_list_pending_approvals` / `emperor_decide_approval`): `GET /api/mcp/approvals/pending` and `POST /api/mcp/approvals/{id}/decide`.
- Escalation adds deciders and never removes them: an earlier approver can still decide after the ask moved up.
- An agent decision is atomic with what was checked: the UPDATE is guarded on `status = 'pending'` and on the escalation level the agent was checked at; a move in between is a 409 to retry.
- **First decision wins** (the existing `status = 'pending'` guard). The loser gets `409 { error: "Already decided by Jose (approved).", decidedBy, approval }`; the tool returns the same text. `resolveApprovalOutcome` reports whether this call decided.
- The decision is audited with the agent actor (`resolver_agent_id`, task events `actorType: "agent"`), and the requester's decision message ends with "Decided by Dev (agent)." or "Decided by Jose.".

## Telling the approver

`notifyApprovalApprovers` (`src/lib/approval-routing-server.ts`):

- `users`: a notification to those people only;
- `admins`: owners and admins (as before);
- `agent`: a queued system message in the agent's direct thread (`ensureDirectThread(company, agent, null)`, the same target as org chart reports), with `approvalWake: true` metadata: what, by whom, why (quoted, marked as not instructions), how to decide, and who it moves to and when. It names the tools for MCP and Hermes, and says that if the agent can't decide (no own token, or it can't judge) the ask moves up and in the end to a person. Queued wakes are settled (`resolved`) when the ask is decided, expires, or escalates past that agent. `approvalWake` and `approvalEscalation` are reserved metadata keys, so an agent cannot forge them. `list_pending_approvals` lists exactly what the agent may decide now (reached steps and a fresh authority check, before the limit).

**Privacy.** Agents never learn people's names from routing: in wake messages, `request_approval`'s `waitingOn`, escalation notes in chat and "already decided" errors, people are "a person" / "an owner or admin" (agents are named). The card names the approvers only to people who may decide (others see "Waiting on an approver"), and the 403 for a non-approver names nobody; a member who may act on the ask still reads its reason, as before. Names fall back to "a teammate", never an email. The requester's decision message keeps the decider's name, as the decision notice in shared threads already did.

## Escalation

`escalateStaleApprovals` (`src/lib/approvals.ts`) runs from the lifecycle monitor once a minute (`src/lib/lifecycle.ts`, beside the other sweeps, under the same advisory lock). An ask whose current step has waited longer than the company's `escalateAfterMinutes` (default 30, clamped to 5..1440; JS `clampEscalateAfterMinutes` and the SQL use the same pattern, clamp and default) moves to the next step, skipping agents that no longer qualify. The update is guarded on `pending` and the current level, so a concurrent decision or a second pass wins. It records `escalated_at`, writes `approval.escalated` to the audit log, notifies or wakes the new approver, and posts "Waiting longer than 30 min — escalated to Jose." in the card's thread (system, addressed to nobody). The 48 h expiry is unchanged.

## Settings and UI

- Agent detail → Actions tab: "Who approves this agent's requests" (Automatic / a specific agent / specific people) and the preview "Asks go to: Architect → Jose → owners and admins" with skipped agents and why. `GET/PUT /api/agents/[id]/approvers`; the preview names people only to owners and admins (who may edit it), others see "a person".
- Settings → Approvals (owners and admins): escalation minutes and approvers per org chart team. `GET/PUT /api/approval-settings`. The org chart editor itself is unchanged; team approvers live in the company settings, keyed by team, saved under a row lock so concurrent saves never lose each other's change. Saving one team keeps the other teams' unsaved edits. Saved approvers who left (removed people, deleted agents) are dropped from the forms on load, with a note, so the setting can be saved again.
- Approval card, Inbox and `/approvals` show "Waiting on: Architect (agent)" / "Jose, Luis". The Inbox and the sidebar badge list only what waits on the viewer; owners and admins get an **All approvals** filter for asks routed to others.

## Compatibility

Migration `0081_approval-routing.sql` is additive: new nullable columns on `approvals`, `{}` defaults on `agents` and `companies`. Existing pending approvals have `approver_kind` NULL and behave exactly as before. A person's own ask (`POST /api/approvals`) is not routed. Routing failures never lose an ask: it is stored unrouted.

## Known gaps

- No ordered mode for several people (any one of them decides).
- The settings preview shows the chain for an ordinary ask (closing a task); an action ask can skip a boss that lacks that permission.
