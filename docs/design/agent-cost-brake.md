# Agent cost brake

Status: design, not implemented. Owner: control plane. Source research: `reports/Equipos de agentes sin charla.md`.

## Problem

In Malecu over the last 14 days, Builder and Hermes-Architect woke each other 226 times. That cost about 340M tokens, roughly 18% of what the two agents spent. Most of those wakes were long re-verification messages (over 800 chars), and each one triggered a run of about 1.5M tokens.

The loop guard never fired, for two reasons:

- **Slow agents reset it.** The streak resets after `AGENT_LOOP_COOLDOWN_MS` (5 min) of quiet (`src/lib/message-routing.ts:351`, `:440`). A run of about 1.5M tokens takes longer than 5 minutes, so every streak restarted at 1.
- **Notes reset it.** A task note counts as progress once every 5 agent messages (`NOTE_RESET_INTERVAL_MESSAGES`, `message-routing.ts:612-646`; `NOTE_EVENT_TYPES`, `src/lib/control-plane.ts:513`). Re-verification usually ends with a note, so the loop reset itself.

The guard counts messages. The waste is in tokens, and the guard has no notion of cost.

## 1. Goals and non-goals

**Goals**

- Stop agent↔agent conversations that spend tokens without making objective progress, whatever the speed of the agents.
- Base the brake on cumulative cost since the last human touch. Only real progress or a human renews it.
- Show agents their budget so they can change behaviour before they hit the limit.
- Escalate a braked conversation to the team leader or a human. The work must not silently die.
- Give agents a cheap way to post an update that wakes nobody ("FYI").
- Keep it compatible with old bridges. Ship it behind shadow mode first.

**Non-goals**

- No changes to monthly per-agent budgets (`src/lib/agent-budget.ts`). They stay as the hard spend cap.
- No LLM-based judging of message quality. Every rule is deterministic and cheap.
- No restructuring of how teams work (a single verifier, artifact handoffs). That is doctrine work. The brake only limits the damage when doctrine fails.
- No braking of human↔agent traffic, task-assignment wakes, or direct threads.

## 2. Data: attributing cost to a conversation

### What already exists

- `agent_runs` has `trigger_message_id`, `thread_id`, `task_id`, `input_tokens`, `output_tokens`, `cache_read_tokens` and `cost_cents` (`src/db/schema.ts:1278-1323`). `input_tokens` includes cached tokens (`src/lib/run-ledger.ts:95`). It is indexed by thread (`agent_runs_thread_started_idx`, `schema.ts:1320`) and by trigger (`schema.ts:1316`).
- `thread_messages.sender_type` and `sender_id` identify who woke the run (`schema.ts:966-983`).
- `task_id` on a run is resolved at finish (`withFinishAttribution`, `src/app/api/mcp/agents/runs/[id]/route.ts:21`; rules in `src/lib/run-task-attribution-store.ts:91`).

### Definitions

- **Agent↔agent (a2a) run:** a run whose trigger message has `sender_type='agent'` and a `sender_id` different from the run's `agent_id`.
- **Pair key:** `(thread_id, least(agent_id, sender_id), greatest(agent_id, sender_id))`.
- **Episode:** the a2a runs of one pair key after the episode start. The episode start is the latest of:
  - a human message in the thread;
  - a cost-brake Resume marker (`costBrakeResume`, new);
  - a loop-guard Resume marker (`loopGuardResume`, `message-routing.ts:81`);
  - a renewing progress event by either agent of the pair (see §3.4).

  Time never starts a new episode, and neither does a note.
- **Task scope:** all a2a runs with `task_id = T`, across threads, since the last human touch on T. A human touch is a human `task_events` row (`actor_type='human'`, `schema.ts:617-635`) or a human message in the task's thread.

### Query (compute from existing tables; no new run table)

The 14-day per-pair chatter report, used for the dashboard and the Malecu baseline:

```sql
WITH a2a AS (
  SELECT r.id, r.agent_id::text AS run_agent, m.sender_id AS waker, m.thread_id, r.task_id,
         coalesce(r.input_tokens,0) + coalesce(r.output_tokens,0) AS tokens,
         coalesce(r.cost_cents,0) AS cents, r.started_at, r.ended_at
  FROM agent_runs r
  JOIN thread_messages m ON m.id = r.trigger_message_id AND m.company_id = r.company_id
  WHERE r.company_id = $1
    AND r.started_at >= now() - interval '14 days'
    AND m.sender_type = 'agent' AND m.sender_id <> r.agent_id::text
),
progress AS (  -- did the run (or its reply) move anything?
  SELECT a.id, EXISTS (
    SELECT 1 FROM task_events e
    WHERE e.company_id = $1 AND e.actor_id::text = a.run_agent
      AND e.created_at BETWEEN a.started_at AND coalesce(a.ended_at, now())
      AND e.event_type NOT IN ('stall_nudge','stall_escalation','task_note','task_handoff')
  ) OR EXISTS (
    SELECT 1 FROM artifacts f
    WHERE f.company_id = $1 AND f.created_by_type = 'agent' AND f.created_by_id::text = a.run_agent
      AND f.created_at BETWEEN a.started_at AND coalesce(a.ended_at, now())
  ) AS moved
  FROM a2a a
)
SELECT least(run_agent, waker) AS agent_a, greatest(run_agent, waker) AS agent_b,
       count(*) AS wakes, sum(tokens) AS tokens, sum(cents) AS cents,
       sum(tokens) FILTER (WHERE NOT p.moved) AS no_progress_tokens
FROM a2a JOIN progress p USING (id)
GROUP BY 1, 2 ORDER BY tokens DESC;
```

The live episode spend for one pair uses the same join, restricted by the thread index:

```sql
... WHERE r.thread_id = $thread AND r.started_at >= $episodeStart
    AND m.sender_type = 'agent'
    AND {r.agent_id, m.sender_id} = {$a, $b}
```

### Storage decision

There is no new ledger table. Spend is derived from `agent_runs` and `thread_messages` and cached for 3 s per thread, the same pattern as `progressCache` (`control-plane.ts:605-643`). Brake *state* is stored as system messages, the same way the loop guard stores `loopGuard` notices and `loopGuardResume` markers (`control-plane.ts:736-743`). That keeps one source of truth and makes every brake visible in the thread.

Migration `src/db/migrations/0079_cost-brake.sql` (repo naming uses hyphens; 0079 is also claimed by `approvals-in-chat.md`, see Review notes) adds one column:

```sql
ALTER TABLE companies ADD COLUMN cost_brake_json jsonb;  -- NULL = env defaults
```

with this shape:

```ts
{
  mode: "off" | "shadow" | "enforce",
  pairTokens, pairCents?, taskTokens, taskCents?, softPct, stallTurns,
  emptyRule: "off" | "shadow" | "convert",
  overrides?: Record<teamThreadId, Partial<…>>
}
```

Per-team overrides are keyed by the team's group thread id. Teams are already group threads (`organizationJson.teamIds`, `schema.ts:52`).

If episode queries become hot, the fallback is a `conversation_episodes` table updated at run finish. It is not needed for v1.

## 3. Brake rules

### 3.1 Defaults

The defaults are calibrated to Malecu, where an a2a run costs about 1.5M tokens.

| Setting | Default | Meaning |
|---|---|---|
| `pairTokens` | 8,000,000 | Hard limit per pair episode (about 5 heavy turns) |
| `pairCents` | null | Optional cost limit. It is used only when every run in the episode is priced (`cost_cents` is null for unpriced models) |
| `taskTokens` | 25,000,000 | Hard limit on a2a spend per task since the last human touch |
| `softPct` | 70 | Percentage of the limit that triggers the soft alert |
| `stallTurns` | 4 | Consecutive no-progress a2a runs in an episode before a hard brake, whatever the spend |
| Env | `EMPEROR_COST_BRAKE_MODE`, `EMPEROR_COST_BRAKE_PAIR_TOKENS`, … | Validated like `agentLoopMaxTurns` (`message-routing.ts:98`) |

A legitimate exchange (question, answer, then back to work) costs 2 a2a runs. That is about 3M tokens and 2 stall turns, well under every limit.

### 3.2 Evaluation points

The rules live in a new pure module, `src/lib/cost-brake.ts`, and are evaluated at three points:

1. **Run finish** (`PATCH /api/mcp/agents/runs/[id]`, after `withFinishAttribution`). This is the moment new spend becomes known.
   - Recompute the pair episode and the task scope.
   - If an episode crosses the soft or hard limit, post the notice.
   - Post at most once per level per episode, using an advisory lock plus a "notice newer than episode start" check, copied from `postLoopGuardNoticeIfNeeded` (`control-plane.ts:702-755`).
2. **Sync routing** (`routeForAgent`, `src/app/api/mcp/messages/sync/route.ts:309`). An agent message from a braked pair gets the verdict `{addressedToYou:false, routeReason:"cost_braked"}`.
3. **Send** (`sendThreadMessageFromMcp`, `src/lib/openclaw/messaging.ts:84`). This is the backstop for runtimes that ignore verdicts (§7).

### 3.3 Soft limit (70% of budget, or `stallTurns - 1`)

- **Thread notice.** A system message is posted. It neither counts toward nor resets the streak (`message-routing.ts:373-378`), and it wakes nobody:
  > "Budget notice: @Builder ↔ @Hermes-Architect have used 5.7M of 8M tokens in this conversation since the last human message, with no task change in the last 3 turns. Finish with an artifact or a task update, or hand the decision to your lead."

  Metadata: `{costBrake:"soft", episodeStart, used, limit}`.
- **Agents** see the budget in their sync payload (§5) and in the `send_message` result.
- **Humans** are not notified at soft.

### 3.4 Hard limit (100% of budget, or `stallTurns` reached)

1. **Thread notice.** A system message: "Paused by cost brake: 8.1M tokens / 4 turns with no progress. A lead or a person can resume."

   Metadata: `{costBrake:"hard", resumable:true, scope:"pair"|"task", used, limit, taskId?}`.
2. **Routing.** From then on, agent messages between the two braked agents get the verdict `cost_braked`. The pair can still be woken by:
   - humans;
   - task assignment (`task_assigned`, `message-routing.ts:291`);
   - agents outside the pair.
3. **Escalation, deduplicated per episode:**
   - If the episode has a task, resolve the leader with `chartManagerForTask` (`src/lib/organization-routing.ts:58`). Otherwise use `organizationJson.leader` (`schema.ts:52`).
   - If the leader is an agent outside the pair, post a system message targeted to it in its direct/Operations thread. It quotes the task, the pair, the spend and the last 3 message ids, in the same quoted, non-instruction style as `managerReportText` (`organization-routing.ts:69`). It wakes the leader once (`reportShouldWake`, `:91`).
   - Admins are also notified through `notify` with a new kind `cost_braked`, added to `NOTIFICATION_KINDS` in `src/lib/notifications.ts:36`. Dedupe key: `cost_braked:<thread>:<episodeStart>`.
   - If the leader is a human, or there is no leader, only the human notification goes out.
4. **How the brake is lifted.** A new episode starts when one of these happens:
   - **A human writes in the thread.**
   - **A human clicks Resume.** This posts `costBrakeResume:{extraTokens}`. The default grants +50% of the limit once. A second Resume in the same day asks for an explicit amount.
   - **Renewing progress by a pair member or the leader:**
     - a task moves to a state it has not had in this episode;
     - a task is assigned or reassigned (`task_assigned`/`task_reassigned`);
     - a task is created.

     The leader's normal tools are the way it lifts the brake: reassign the task, split it, or send it to review. The leader never lifts it by chatting.

### 3.5 Stall detector (ping-pong)

A stall turn is an a2a run that produced no core progress between its start and its end:

- no `task_events` row outside `NON_PROGRESS_EVENT_TYPES` (`control-plane.ts:514`);
- no artifact by the run's agent.

This is the same progress test as `fetchThreadProgress` (`control-plane.ts:556-603`), with notes excluded.

- A progress event resets the stall counter.
- **Artifacts reset only the stall counter, not the budget.** That stops agents from farming the budget with uploads.

This is the rule that catches slow loops: it counts turns, not minutes.

### 3.6 Relation to the existing streak guard

- **Brake is primary.** The cost brake becomes the primary guard when `mode=enforce`.
- **Streak guard stays** as a cheap message-count backstop. Its thresholds (12/30) do not change. One change: when the brake is enforced, `noteProgressResets` is not applied, so notes no longer reset the streak. The 5-minute cooldown stays; the brake covers slow loops.
- **The 429 stays** (`messaging.ts:236-242`, 3× the threshold). It is the last resort for runtimes that ignore verdicts.
- **UI convergence.** Both pauses render through the same resumable-notice UI (§6).

## 4. The "no wake" flag and the empty-message rule

### 4.1 `wake: false`

- **Inputs.** Add `wake` to `send_message` (`src/lib/mcp-server/tools/messaging.ts:29-36`) and to the REST schema (`src/app/api/mcp/messages/send/route.ts:14`; the schema is `.loose()`, so old callers are unaffected). The default is `true`.
- **Stored message.** With `wake:false` the message is stored with the server-set metadata `noWake:true`. Add `noWake` to `RESERVED_MESSAGE_METADATA_KEYS` (`message-routing.ts:73`) so that only the server can set it.
- **Pair threads.** `targetAgentId` is stored as null, overriding the pair inference at `messaging.ts:229`.
- **Mentions.** The ensure-mention rewrite at `messaging.ts:222` is skipped.
- **Routing.** `decideDelivery` returns `{addressedToYou:false, routeReason:"fyi"}` for every agent recipient. `agentMessageWakesAgent` returns false, so the message neither counts nor resets the streak, the same as a broadcast (`message-routing.ts:368`).
- **Humans.** Humans still see it and are still @-notified.
- **Tool description.** The description changes to: "Set wake:false for status updates, confirmations and FYIs; only wake an agent when you need it to act."

### 4.2 Empty-message rule

A message is converted, never refused. A cheap pure classifier, `isEmptyAgentHandoff(text, metadata)`, runs on agent messages that would wake another agent (`agentMessageWakesAgent` is true). A message is **empty** only if all of these hold:

- after stripping mentions, Markdown and whitespace it is 280 characters or fewer;
- it contains no `emperor://` link, URL, code fence, rich block, attachment, or `?`;
- it matches an acknowledgement lexicon in EN/ES: `thanks|gracias|got it|ack|confirmed|confirmado|already (verified|checked|reviewed)|ya (lo )?(revisé|verifiqué)|lgtm|👍|no further action|nothing to add|[no-reply]`;
- it is not the first message of the episode. The first message is always allowed through, so a terse but genuine request still works.

An empty message is stored with `noWake:true` and a `convertedFrom:"empty_rule"` marker. The sender's tool result says: "Posted without waking @X: acknowledgements and confirmations don't need a reply."

The rule is conservative on purpose. Long "I re-verified X" messages are *not* classified as empty; the stall detector and the budget handle them. In shadow mode (`emptyRule:"shadow"`) hits are only logged into the verdict ledger (`recordInterestingVerdicts`, `run-ledger.ts:298`), so precision can be checked against Malecu traffic before conversion is turned on.

## 5. Agent-facing visibility

### 5.1 Sync payload

The sync payload is additive; unknown fields are ignored by old bridges. Two additions:

- A top-level `budgets` map keyed by thread id, only for threads with an open a2a episode involving the syncing agent:

  ```json
  "budgets": { "<threadId>": {
    "scope": "pair", "counterpartAgentId": "…", "taskId": "…|null",
    "usedTokens": 5700000, "limitTokens": 8000000, "usedCents": 0, "limitCents": null,
    "stallTurns": 3, "stallLimit": 4, "state": "ok|soft|braked",
    "renewsOn": "a human message, a task state change, an assignment, or Resume",
    "note": "Used 5.7M of 8M tokens with @Hermes-Architect since the last human message."
  } }
  ```

- On each message, `routeReason` can now also be `fyi` or `cost_braked`, plus an optional `budgetNote` string. New bridges append `budgetNote` to the turn prompt, as BATS-style budget awareness.

The budget is also echoed in every `send_message` / REST send result as `budget: {…}`. This reaches MCP clients and every bridge version, because the agent reads its own tool result.

### 5.2 Manual and kernel (`src/lib/emperor-manual.ts`)

- **`CHAT_AND_MENTIONS` loop rules (`:55`):** add "Agent↔agent conversations have a token budget per conversation and per task; you see it as `budget`. Only a task state change, an assignment, or a person renews it — notes and time do not. Use wake:false for updates and confirmations. Do not re-verify another agent's verified work; if you disagree, put the evidence in an artifact or send the task to review."
- **`TEAM_HANDOFFS` (`:91`):** replace "you never hit the loop guard" with "you never hit the loop guard or the cost brake. When a conversation is braked, your lead decides: wait, or act on the task."
- **`OVERVIEW` (`:36`):** correct the claim that a note "resets the loop guard". Under enforcement it no longer does.
- **`KERNEL_COMMON_RULES` (`:163`):** append " Use wake:false for FYIs; agent chats have a token budget." The kernel's 1,500-char ceiling is tested in `tests/unit/emperor-manual.test.ts`; keep the addition under about 70 chars.

## 6. UI

### 6.1 Braked conversations

- **Chat.** A hard notice renders like the loop-pause notice (`src/components/agent-team-chat.tsx:69`, `:453`), with a "Paused by cost brake" label, the spend, the task link, and two buttons: **Resume (+50%)** and **Keep paused**.
- **Endpoint.** Resume calls the existing `/api/chat/loop-resume` (`src/app/api/chat/loop-resume/route.ts`) with `kind:"cost_brake"`. The route posts `costBrakeResume`. It keeps the 409 when nothing is paused and the admin rule for pair threads.
- **Needs attention and Inbox.** `buildAttention` reads `costBrake='hard'` notices next to `loopGuard` ones (`src/lib/attention.ts:256`, `:281`) and shows them in Needs attention (`src/components/team-dashboard/needs-attention.tsx:98`) and the Inbox (`src/app/(app)/inbox/inbox-client.tsx:135`).

### 6.2 Chatter metric

- **Costs page.** A new "Agent chatter" panel on the Costs page (`src/app/(app)/costs/`, loaded via `src/lib/costs-reads.ts`) runs the §2 query. One row per pair, with these columns:
  - wakes;
  - tokens;
  - share of the two agents' total spend;
  - no-progress tokens;
  - brakes in the last 14 days.
- **Team dashboard.** A KPI tile in `kpi-row.tsx` shows "a2a no-progress tokens, 14d" with the trend.

## 7. Backwards compatibility

| Runtime | Behaviour |
|---|---|
| Bridges that follow `addressedToYou` (Hermes 0.22 fleet) | Silent on `fyi` and `cost_braked`; unknown reasons are only logged. `KNOWN_ROUTE_REASONS` (`src/lib/run-ledger-copy.ts:72`) and `INTERESTING_UNADDRESSED_REASONS` (`run-ledger.ts:240`) gain both reasons |
| Pre-verdict bridges, which route on `targetAgentId` / @mention | `noWake` and braked posts are stored with `targetAgentId=null`, so pair-thread `targeted` routing no longer fires. An @mention in the text can still wake them |
| Any runtime that keeps posting in a hard-braked episode | Refused by the send path: the **second** post from a braked pair agent that would wake its counterpart gets 429 "Cost brake: this conversation is paused; act on the task or wait for your lead". The first is accepted with its wake suppressed, so an in-flight reply is never lost |
| Callers that don't send `wake` | Unchanged (the default is true) |

## 8. Tests, rollout, and verification

### 8.1 Unit tests (`tests/unit/`)

- `cost-brake.test.ts`:
  - `episodeStart` (resets on human, Resume and renewing progress; **not** on time or notes);
  - `brakeLevel` (soft at 70%, hard at 100%, cents only when every run is priced);
  - `stallTurns` (artifacts reset stall, not budget);
  - slow loop (one exchange every 20 minutes still brakes).
- `empty-handoff.test.ts`: lexicon hits, first-message exemption, `?`/link/code exemptions, and a long re-verification message that is *not* empty.
- `message-routing.test.ts`: `fyi` and `cost_braked` verdicts; human and `task_assigned` still pass for a braked pair; `noWake` messages skip the streak; notes don't reset the streak under enforcement.
- `emperor-manual.test.ts`: kernel stays ≤ 1,500 chars.

### 8.2 Integration tests (`tests/integration/`)

- `cost-brake-pair.test.ts`: two agents ping-pong through runs with token usage. Expect the soft notice, then the hard notice, the `cost_braked` verdict, leader escalation, the admin notification, and Resume reopening the pair with +50%.
- `cost-brake-task.test.ts`: task scope crossing threads.
- `cost-brake-send-backstop.test.ts`: first post accepted with `targetAgentId=null`, second post gets 429.
- `send-message-nowake.test.ts`: the MCP tool and REST `wake:false`; reserved metadata cannot be forged.
- `attention.test.ts`: braked notices are listed and cleared by Resume.

### 8.3 Bridge tests

- `tests/hermes-routing.test.py`: unknown reasons stay silent; `budgetNote` is appended to the prompt.

### 8.4 Rollout

1. **Release N: shadow everywhere.** `mode` defaults to `shadow`. All accounting, payload fields and ledger rows are live, but there are no notices, verdict changes or 429s. The would-brake decisions are logged as verdicts.
2. **Enforce in Malecu.** After about 7 days, review the shadow brakes against real threads. Look for false brakes on threads that did progress. Then switch Malecu to `enforce`, with `emptyRule:"shadow"`.
3. **Convert in Malecu.** After another week, set `emptyRule:"convert"` in Malecu.
4. **Release N+1: enforce by default** for new companies. Existing companies get a settings toggle. The `wake` flag and budget visibility ship on from day one; they are additive.

### 8.5 Success metric (Malecu)

The metric is **a2a no-progress token share**: no-progress tokens of a2a runs ÷ total tokens, per pair, over 14 days (the §2 query).

- **Baseline:** about 18% for Builder ↔ Hermes-Architect.
- **Target:** under 5% within 14 days of enforcement.
- **Guardrails:** tasks reaching `done` per week, and median task cycle time, must not regress by more than 10%.
- **Secondary:** a2a wakes per task, and the number of human Resumes per week. Many Resumes mean the limits are too tight.

## 9. Open questions

1. **Defaults.** Are 8M tokens per pair episode, 25M per task and 4 stall turns acceptable for Malecu, or should the defaults be in cents? Cents are more meaningful to an owner, but they are null for unpriced models.
2. **Resume permission.** Who may resume: any member (today's loop-resume rule), or only admins and the leader? And should Resume grant +50% once, or ask for an amount every time?
3. **Leader in the pair.** If the braked pair includes the team leader itself, should escalation skip to the next manager up the chain, or go straight to a human?
4. **Empty-message rule.** Should conversion ever become a refusal for repeat offenders, or stay convert-only permanently?
5. **Per-team overrides.** Is per-team configuration needed for v1 (overrides keyed by team thread), or is a per-company setting enough until a second customer asks?

## Review notes (adversarial review, 2026-11-05)

Spot-checked ~25 file:line references; they hold, except the migration name (fixed above). Remaining issues, design decisions left to the owner:

1. **[High] Renewal is farmable.** "A task moves to a state it has not had in this episode" renews, and renewal starts a *new* episode, so `in_progress → review → in_progress → review …` renews forever. Creating a task and assigning/reassigning by a pair member also renew; agents can do all three through MCP. Renewal should require a forward state (or a human/leader actor), be capped per task per day, and never come from the pair itself for create/assign.
2. **[High] New-thread / third-agent bypass.** The pair key includes `thread_id`; `send_message` with `private:true` (or any other shared thread) opens a fresh pair key and a fresh 8M budget. Task scope only catches it when `task_id` is attributed. Relaying through a third agent (A→C→B) creates two unbraked pairs. Consider keying the pair budget per `(company, agent pair)` across threads, plus a per-agent a2a ceiling.
3. **[High] Other wake channels are not braked.** The backstop is only in `sendThreadMessageFromMcp`; `POST /api/mcp/threads/[id]/messages` (`route.ts:120,141`) appends agent messages directly and needs the same check. Non-message wakes stay invisible to the a2a definition (trigger `sender_type='agent'`): `create_task`/`update_task` assignment to the counterpart (`task_assigned` is explicitly exempt), `send_agent_request`, and approval cards/decisions from `approvals-in-chat.md` (system messages). A braked pair can keep ping-ponging through these at full cost.
4. **[Medium] `wake:false` in pair threads needs more than stated.** `agentMessageWakesAgent` returns `true` for any pair-thread message (`message-routing.ts:238`) and `decideDelivery` returns `agent_pair` when `targetAgentId` is null (`:306-311`), so nulling the target does nothing in a pair thread; both functions need a `noWake` branch first. Also reserve `costBrake`, `costBrakeResume` and `convertedFrom` in `RESERVED_MESSAGE_METADATA_KEYS`, or an agent can post a forged Resume marker and renew its own budget. (`loopGuard` itself is not reserved today, and `isLoopPauseNotice` does not check `senderType`.)
5. **[Medium] Old bridges without run usage** (pre run-usage 2) report no tokens, so only `stallTurns` applies to them; `input_tokens` includes cache reads, so 8M tokens is mostly cheap cached context. State both and consider weighting cache reads.
6. **[Low] Migration collision.** Both designs claim `0079`; whichever ships second takes `0080`. Both add a jsonb column to `companies` (`cost_brake_json`, `approval_policy_json`); no name clash, but ship them in separate migrations.
7. **[Low] Notification kind.** `NOTIFICATION_KINDS` already has `loop_paused` (`notifications.ts:36`); reusing it (with a `costBrake` detail) avoids a new email preference.
8. **[Scope] Cut for v1:** per-team overrides, `pairCents`/`taskCents`, the empty-message classifier (the stall detector already covers re-verification), the KPI tile, and the "second Resume asks for an amount" rule.

**Smallest first slice:** shadow-mode accounting only: the §2 chatter query on the Costs page plus `stallTurns` evaluated at run finish and logged as verdicts, with notes no longer resetting the streak under a flag. Then `wake:false` (with the pair-thread fix in note 4). Enforcement (verdict + 429 on both post endpoints) comes after the 7-day shadow review, with renewal restricted per note 1.
