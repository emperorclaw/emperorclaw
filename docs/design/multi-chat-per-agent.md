# Multiple chats per agent

Status: **implemented on branch feat/multi-chat-per-agent (not released)** (2026-11-13). See "Implementation notes" at the end. Owner: product owner. Target: next minor after 0.32.0, shipped in four phases (§10).
Scope: private direct chats between one person and one Hermes agent. Code references were mapped on `main` at `9ea211b2`; re-check each one before editing.

A person can keep several separate chats with the same agent, each with its own context, and the agent can work in more than one of them at a time. Every person keeps exactly one **main chat** per agent, and everything that works today keeps pointing at it, so a company that never clicks "New chat" sees no change at all.

## Quick path (what ships)

1. A **New chat** button and a chat switcher in the chat header. The sidebar stays one row per agent.
2. One **main chat** per (person, agent), permanent. Extra chats can be renamed, archived and restored.
3. **Limits**: 20 open chats per person per agent (admin can change it), idle extra chats archive themselves after 30 days.
4. **Stop** in a chat stops that chat only.
5. **On by default**, with an admin switch and cap in Settings → Direct chats.

---

## 1. Problem

| Today | Cost |
|---|---|
| One endless private chat per (person, agent) | Context grows without bound; unrelated topics share one session |
| A long turn occupies the only chat | A quick unrelated question interrupts it or queues behind it |
| No "New chat" | People arriving from other AI tools expect one; its absence reads as unfinished |

The bridge already supports this: sessions are keyed per thread and turns in different threads run in parallel. The limit is in the control plane.

## 2. Current state (grounding)

| Layer | Fact | Reference |
|---|---|---|
| DB | Unique index: one live private direct thread per (company, owner, agent) | `src/db/schema.ts:977-980`, migration `0062_direct-chat-mode.sql:17` |
| DB | `message_threads` has `title`, `archivedAt`, `ownerUserId`, `isPrivate`; no `lastMessageAt`, no pin | `src/db/schema.ts:949-981` |
| API | `ensurePrivateDirectThread` returns the oldest live thread, creates only if none | `src/lib/control-plane.ts:199-293` |
| API | `/api/chat` already accepts a `directThreadId` the caller takes part in | `src/app/api/chat/route.ts:47-57`, `control-plane.ts:322-339` |
| API | Privacy rule: only the owner may use a private thread; admins cannot read it | `userMayUseThread`, `src/lib/direct-chat-mode.ts:72-75` |
| UI | Listing keeps one primary thread per agent in a Map | `src/lib/messages-listing.ts:102-120`, `messages/page.tsx:62` |
| UI | Hub selects a chat by agent id | `src/components/messaging-hub.tsx:239-322` |
| Bridge | Session key `emperor/{agentId}/{threadId}/g{generation}` | `bridge/emperor_bridge/gateway/sessions.py:35-74` |
| Bridge | One turn per thread; threads run in parallel up to `max_parallel_turns` (default 3, some agents 1) | `scheduler.py:207-225`, `config.py:158,243` |
| Bridge | Idle thread records become stubs after 30 days; no per-agent session cap | `state.py:189-210`, `main.py:435-438` |
| Control | Kill is agent-wide: it clears every queue and resets every thread, for all users | `src/lib/agent-control.ts:15-50`, `controls.py:80-108` |
| Control | Replace in a private thread is already thread-scoped | `controls.py:110-125` |
| Settings | `companies.directChatMode` (`private` / `shared`), admin-only PUT, audited | `src/app/api/settings/direct-chats/route.ts` |
| Audit | No `thread` target type; thread create/archive is not audited | `src/lib/audit-format.ts:18-21` |
| Plans | No plan, tier or entitlement mechanism exists | not found |

## 3. Decisions summary

| # | Topic | Decision |
|---|---|---|
| D1 | Model | N private direct threads per (company, person, agent). Exactly one has `is_main = true`. |
| D2 | Default resolution | Every caller that asks for "the chat with agent X" without a thread id gets the **main chat**. No caller changes behaviour. |
| D3 | Activation | On by default for every company in `private` mode. Admin switch to disable. No separate module, no plan gate. |
| D4 | Shared mode | Out of scope for v1. In `shared` mode the button is hidden and nothing changes. |
| D5 | Creation | Lazy: the thread row is created with the first message, never before. Humans only; agents cannot create chats. |
| D6 | Sidebar | Stays one row per agent, with unread aggregated across that person's chats. Chats are switched inside the chat header. |
| D7 | Titles | Main chat keeps its fixed title. Extra chats are titled from the first message (first 60 characters, no model call) and can be renamed. |
| D8 | Too many chats | Cap of 20 open chats per (person, agent), admin range 1–50. Idle extra chats auto-archive after 30 days (admin range 7–90, or off). |
| D9 | Archive | Archived chats are read-only and restorable. No user-facing hard delete in v1. The main chat cannot be archived by its owner. |
| D10 | Stop | Stop in a private chat is thread-scoped. Agent-wide stop stays on the agent page. |
| D11 | Parallel work | The bridge cap is unchanged. The bridge reports its real cap to the server; the UI shows honest queue state. |
| D12 | Objectives | Still one per agent. It runs in the chat it was started from; other chats show where it is running. |
| D13 | System traffic | Task wakes, onboarding and goal messages go to the main chat. Approvals and agent requests keep using the Operations thread. |
| D14 | Privacy | Unchanged: owner only. Audit rows carry ids, never titles or content. |
| D15 | Context | A new chat starts with a fresh Hermes session. It does not inherit the main chat's history. |
| D16 | Working directory | Unchanged and shared per agent. Agents capped at 1 parallel turn queue instead of running side by side. |

### Why "on by default" and not a separate feature

- It is additive. With D1 and D2 the only visible change for a person who ignores it is one button.
- A module or plan gate would have to hide nav, pages and MCP tools (`src/lib/modules.ts`); this feature has none of those.
- Enterprise control comes from the admin switch, the cap, the audit trail and the unchanged privacy rule, not from hiding the feature.

## 4. Data model

One migration (next free number after the latest in `src/db/migrations/`).

```sql
ALTER TABLE message_threads ADD COLUMN is_main boolean NOT NULL DEFAULT false;

UPDATE message_threads SET is_main = true
 WHERE type = 'direct' AND owner_user_id IS NOT NULL;

DROP INDEX message_threads_private_direct_unique;

CREATE UNIQUE INDEX message_threads_private_main_unique
  ON message_threads (company_id, owner_user_id, direct_agent_id)
  WHERE type = 'direct' AND owner_user_id IS NOT NULL
    AND archived_at IS NULL AND is_main;

CREATE INDEX message_threads_private_owner_agent_idx
  ON message_threads (company_id, owner_user_id, direct_agent_id)
  WHERE type = 'direct' AND owner_user_id IS NOT NULL AND archived_at IS NULL;

ALTER TABLE companies
  ADD COLUMN multi_chat_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN multi_chat_max_open integer NOT NULL DEFAULT 20,
  ADD COLUMN multi_chat_idle_archive_days integer DEFAULT 30; -- NULL = never
```

| Rule | Detail |
|---|---|
| Main is unique | Enforced by the partial unique index, so the existing advisory-lock get-or-create stays correct. |
| Archive reason | Add `archive_reason text` (`manual`, `idle`, `member_left`, `agent_sealed`) so the UI can explain why a chat is archived. |
| No `lastMessageAt` column | Last activity keeps being computed from `messages` (as `messages-listing.ts:94-100` does). Add the column only if the listing query shows up in profiling. |
| Restore | Restoring a thread with `is_main = true` while another live main exists restores it as a normal chat (`is_main = false`). |
| Rollback | The old unique index cannot be recreated while extra chats exist. Rollback = archive all live non-main private threads, then recreate it. |

## 5. Server behaviour

### 5.1 Resolution

| Function | Change |
|---|---|
| `ensurePrivateDirectThread` | Select `is_main` instead of "oldest". Insert sets `is_main = true`. Same lock. |
| new `createPrivateChat(company, user, agent, firstMessage, clientKey)` | Under the same advisory lock: check setting, mode, agent access and the open-chat count, then insert with `is_main = false` and the derived title. Idempotent on `clientKey`. |
| `getDirectThreadForUser` | Unchanged. It already accepts any thread the person owns. |

Callers that keep resolving to the main chat with no code change: task wake (`task-wake.ts:215`), objectives fallback (`agent-objective.ts:250,297,492`), goals (`agent-goal.ts:38,54`), onboarding (`onboarding.ts:186`), agent control without a thread id (`agent-control.ts:36`), `/api/chat` without `directThreadId`.

### 5.2 API

| Route | Purpose | Errors |
|---|---|---|
| `GET /api/chat/threads?agentId=&archived=` | The caller's chats with that agent: `id`, `title`, `isMain`, `lastMessageAt`, `unread`, `running`, `queued`, `archivedAt`, `archiveReason` | — |
| `POST /api/chat` with `newChat: { clientKey }` | Creates the chat and sends the first message in one transaction | `403 multi_chat_disabled`, `409 chat_limit_reached {limit, open}`, `429` |
| `PATCH /api/chat/threads/[id]` | `{ title }`, `{ archived: true }`, `{ archived: false }` | `409 main_chat_cannot_be_archived`, `409 chat_limit_reached` on restore |
| `PUT /api/settings/direct-chats` | Extended with `multiChatEnabled`, `multiChatMaxOpen`, `multiChatIdleArchiveDays`; admin only | validation |

- Creation requires role `member` or above and `agentUse === 'full'` for that agent (`src/lib/agent-access.ts:55`).
- Creation is rate limited with `consumeRateLimit` (`src/lib/rate-limit.ts`): 10 per minute per person.
- Sending to an archived chat returns `409 chat_archived`, for people and for the agent's own `send_message`.

### 5.3 Limits and housekeeping

| Limit | Default | Behaviour at the limit |
|---|---|---|
| Open chats per (person, agent) | 20 | New chat is refused; the dialog lists the least recently used chats with an Archive action. |
| Idle auto-archive | 30 days without a message | Runs in the existing retention sweep (`src/lib/retention.ts`). Sets `archive_reason = 'idle'`. One click restores. |
| Parallel turns | bridge `max_parallel_turns` | Extra messages queue; see §7. |

Auto-archive never touches: the main chat, a chat with a running or queued turn, the chat holding the agent's active objective, or a chat with a pending approval card.

The 30-day default matches the bridge, which already turns idle thread records into stubs after 30 days. Worst-case live sessions per agent are therefore bounded by `people × cap`.

### 5.4 When the setting is turned off

- No new chats can be created.
- Existing extra chats stay usable and can be archived. Nothing is merged, split or deleted. This matches the existing rule for `directChatMode` changes.
- Restore of an archived extra chat is refused while the setting is off.

### 5.5 Lifecycle edge cases

| Event | Result |
|---|---|
| Member leaves | `archivePrivateThreadsOf` already archives all of their threads (`control-plane.ts:309`); set reason `member_left`. |
| Agent access sealed for a person | All of that person's chats with the agent become inaccessible, as today. Verify the new listing route applies `agentsNotUsableBy`. |
| Agent deleted | All chats are hard-deleted, as today (`src/lib/agent-deletion.ts:70-102`). Add the deleted thread count to the existing `agent.deleted` audit row. |
| Company switches `private` → `shared` | Existing private chats stay as "private" secondary entries, as today. No new ones. |

## 6. Interface

Reuse the existing motion system, the drop-in `Select` and the context menus. Do not introduce new primitives.

| Element | Behaviour |
|---|---|
| Sidebar row | One row per agent. Unread = sum over that person's open chats. Clicking opens the last chat viewed with that agent (localStorage), else the main chat. |
| Chat switcher (header) | Shows the current chat title. Opens a list: main chat pinned first, then open chats by last activity, each with unread dot and a running or queued indicator. Shows the 8 most recent plus "All chats". |
| New chat | Opens an empty composer. Nothing is stored until the first message is sent (D5). Hidden when the setting is off, in shared mode, or when the person lacks full access. |
| All chats view | Title filter, groups "Today / Last 7 days / Older", and an Archived section with the archive reason and a Restore action. |
| Chat menu | Rename, Archive. Disabled with a reason on the main chat. |
| Count hint | From 15 open chats, the switcher shows "15 of 20". |
| Other-chat activity | The existing "Also working on…" row (`agent-direct-chat.tsx:748-755`) links to the exact chat. |
| Mobile | The switcher opens as a bottom sheet. |
| Empty state | A new chat says the agent starts without the earlier conversation (D15). |

Routing:

- URL is `/messages?agent=<id>&thread=<id>`. `?thread=` is always exact; `?agent=` alone opens last-viewed, else main.
- The hub must select by thread id, not agent id (`messaging-hub.tsx:244-256, 321`), and the stored last-open key becomes the thread id.
- Drafts are keyed by thread id. Hand-over drafts (`src/lib/chat-draft.ts:6`) land in the main chat.

Strings go in `messages/en.json` under `directChat`, `messagingHub` and `settings.directChats`; `messages/zh-CN.json` follows the glossary. `tests/architecture-i18n.test.cjs` must pass.

## 7. Runtime and controls

### 7.1 Stop

| Where | Scope after this change |
|---|---|
| Stop button inside a private chat | That thread: cancel its queue, interrupt its turn, keep every other chat untouched |
| Agent page "Stop" | Agent-wide, unchanged |
| Replace in a private chat | Thread, unchanged |

- Server: `controlScopeFor` (`src/lib/agent-control.ts:15-23`) returns thread scope for `kill` when the thread has an owner.
- Bridge: add a thread-scoped kill next to `_apply_thread_replace` (`controls.py:110-125`).
- Compatibility: the bridge advertises `thread-kill-v1` in `capabilitiesJson`. Without it the server sends the agent-wide kill and the UI says "This stops all of the agent's chats". This also fixes today's cross-user side effect.

### 7.2 Parallel turns and honest queue state

- The bridge sends its real `max_parallel_turns` at registration (`health.py:34`); the server stores it on the agent's runtime record.
- The UI replaces the hard-coded `>= 3` (`agent-direct-chat.tsx:755`) with that value. Unknown value → fall back to 1 for display.
- Queued copy names the cause: "Queued. The agent is working in 2 other chats."
- Scheduling is unchanged: one turn per thread, first come first served across threads. Per-person fairness is not added in v1.

### 7.3 Sessions and context

- A new chat is a new session; no bridge change is needed to create it.
- Archive does not need a bridge call: the server refuses new messages, and the bridge reclaims the idle record on its existing schedule.
- **Verify before P1**: that the message sync (`src/app/api/mcp/messages/sync/route.ts:116-125`) does not deliver archived direct threads.
- **Verify before P2**: the `parallel_threads` contract test from `hermes-persistent-runtime.md` passes on the pinned Hermes version.

### 7.4 Known limitation: shared working directory

All sessions of one agent share a working directory (`config.py:242`). Two turns that write files can collide. Agents with file-heavy work stay at `max_parallel_turns = 1`, so their chats queue. Per-chat working directories are a non-goal for v1.

### 7.5 Objectives, budgets, agent-facing API

| Area | Decision |
|---|---|
| Objectives | One per agent. The start call passes the current thread id; the fallback is the main chat. Other chats show a banner linking to it. |
| Budgets | Per-agent budgets stay agent-wide. More chats do not raise the ceiling. |
| `list_threads` | Returns all of the agent's chats; add `isMain` and `title` to the output. |
| Tool descriptions | Update the text in `mcp-server/tools/messaging.ts:28` that says a person has one direct thread. |
| `send_message` without `threadId` | Unchanged (shared thread). |

## 8. Governance and privacy

| Topic | Rule |
|---|---|
| Who can read a chat | Its owner and the agent. Admins and owners cannot. Unchanged. |
| Audit | New target type `thread`. Events: `thread.created`, `thread.archived` (with reason), `thread.restored`. Payload: thread id, agent id, actor. **Never the title or any content**, because titles come from the first message. |
| Idle archive audit | One summary row per sweep per company with a count, not one row per chat. |
| Settings changes | Audited through the existing `company.settings_changed` with `meta.setting`. |
| Display tokens | `includePrivateChats` shows the main chat only. Change the query in `live-feed.ts:508-517` from "oldest" to `is_main`. |
| Notifications | Stay per thread; links are already thread-exact. |
| Search | Unchanged: archived chats are excluded, hits link to the exact chat. |
| Retention and export | Unchanged: messages are never pruned and there is no export. Archived chats are kept. |

## 9. Backwards compatibility

- A company where nobody creates a second chat has the same rows, the same listing and the same links as before. This is an explicit test (§11).
- Old bridges keep working: they already key sessions per thread. Only thread-scoped Stop needs the new capability, with the fallback in §7.1.
- `?agent=` links across the app keep working and open the last-viewed or main chat. Links that know their thread become exact in P3:
  `run-ledger-copy.ts:328`, `task-story-reads.ts:276`, `work-timeline-reads.ts:142`, `agent-health.ts:256`.
- `agent-health.ts` has uncommitted local edits by the owner. Type-check against the committed copy and do not depend on the working-tree version.

## 10. Rollout

Each phase is its own PR, under 400 changed lines where possible, and is safe to release alone. The feature is invisible until P2.

| Phase | Contents | Visible to users |
|---|---|---|
| P0 Data and API | Migration, `is_main` resolution, `createPrivateChat`, routes in §5.2, cap, rate limit, settings columns, audit events, listing returns all chats and counts them in unread | No |
| P1 Runtime | Thread-scoped Stop (server + bridge + capability), real `max_parallel_turns` reporting, archived-thread sync check | Stop behaves better |
| P2 Interface | Switcher, New chat, All chats, rename/archive/restore, routing by thread id, drafts, settings tab, i18n | **Yes** |
| P3 Housekeeping | Idle auto-archive sweep, thread-exact links, live feed, MCP descriptions, user docs | Polish |

Release gates for every phase: lint, `tsc --noEmit`, `npm test`, integration tests, bridge tests, and a browser re-check of `/messages` after any `page.tsx` or SQL change.

## 11. Test plan

| Layer | Cases |
|---|---|
| Unit | Title derivation; `controlScopeFor` for kill; cap arithmetic; setting validation |
| Integration (Postgres) | Main uniqueness under concurrent create; cap enforced under concurrency; `clientKey` idempotency; another person and an admin get 404 on a chat they do not own; disabled setting; archive/restore rules; unread aggregates all chats; "mark all read" clears all; member leaves; agent deleted; **no-second-chat regression snapshot of the listing** |
| Bridge | Thread-scoped kill leaves other threads' queues and sessions intact; capability advertised; old-server fallback |
| Contract | `parallel_threads` on the pinned Hermes version |
| E2E (Playwright) | New chat → first message → switcher shows it; deep link survives reload; cap dialog; archive and restore; Stop in chat A leaves chat B running; mobile sheet |
| Extend | `tests/integration/direct-chat-mode.test.ts`, `private-thread-access.test.ts`, `messages-unread.test.ts`, `agent-control-scope.test.ts`, `live-feed.test.ts`, `activity-audit.test.ts`; `tests/bridge/test_scoped_replace.py` |

## 12. Non-goals (v1)

- Multiple chats in `shared` mode.
- Chats created by agents, or shared between colleagues.
- Per-chat working directories or per-chat objectives.
- Folders, pins, branching a chat, model-generated titles.
- Hard delete, retention policies and export.
- Per-person fairness in the bridge scheduler.

## 13. Open questions (product owner)

| # | Question | Default in this doc |
|---|---|---|
| Q1 | On upgrade, should existing companies get it on, or off until an admin enables it? | **Decided 2026-11-12: on.** The migration default `multi_chat_enabled = true` applies to existing companies too. |
| Q2 | When an admin turns it off, should existing extra chats stay usable or become read-only? | Stay usable |
| Q3 | Are 20 open chats and 30 idle days the right defaults? | 20 / 30 |
| Q4 | Should the main chat get a "start fresh" action that resets its context without creating a new chat? | Not in v1 |
| Q5 | Should archived chats be searchable? | No |
| Q6 | Is a per-person share of parallel turns needed for large teams on one agent? | Not in v1 |

## 14. Verified vs assumed

| Verified in code | Assumed, check during implementation |
|---|---|
| Unique index, get-or-create, listing Map, hub selection by agent id | Hermes runs several sessions on one gateway without interference at the configured cap |
| Bridge session key and per-thread scheduling | A new thread reaches the bridge with no bridge change |
| Agent-wide kill, thread-scoped replace | The message sync excludes archived direct threads |
| Privacy rule and its enforcement points | The retention sweep is the right host for the idle-archive job |
| No plan or entitlement mechanism | Per-agent budgets already cover turns from every thread |

## Implementation notes

Deviations accepted during P0–P3, against the design above.

| Phase | Note |
|---|---|
| P0 | New chat is one transaction under the per-(person, agent) advisory lock: `createPrivateChat` creates the main chat if missing (so the cap counts it), the extra chat, its first message and the `clientKey` row in `idempotency_keys` (endpoint `chat.new`, snapshot `{threadId, messageId}`). A retry returns the same chat and message; a failure leaves no empty chat. The new-chat rate limit is consumed only after the idempotent lookup, so a retry is never rate limited. |
| P0 | An extra chat started with only an attachment or a voice note is untitled (`title` NULL); the interface shows "Untitled chat" in the viewer's language. |
| P0 | Restoring a chat stamps `message_threads.restored_at` (migration 0082); idle auto-archive counts max(last message, creation, last restore) as last activity. |
| P0 | A person's message to their private chat re-checks `archived_at` under a share lock on the thread row in the insert transaction (archive locks the row `FOR UPDATE` first), so a send racing an archive answers `409 chat_archived` or is cancelled by the archive, never left queued in an archived chat. |
| P0 | Renames, archives and restores are rate limited: 30 per minute per person. |
| P0 | Manual archive of the chat that holds the agent's objective (active, blocked or paused) is refused with `409 objective_running`. |
| P0 | The main chat cannot be renamed (`409 main_chat_cannot_be_renamed`), not only not archived. |
| P0 | The open-chat cap counts the main chat. |
| P0 | `thread.archived` is audited for manual archives only; member-left archives are covered by the member audit, idle archives by one summary row. |
| P1 | The bridge reports `max_parallel_turns` as a `max-parallel-turns: N` entry in its capabilities, not a separate field. |
| P1 | A thread-scoped kill also resets that thread's session. |
| P1 | Message sync excludes archived direct threads. A bridge reply refused with `409 chat_archived` is final (not retried). |
| P2 | `scope: "agent"` (agent-wide Stop) is limited to company owners/admins and the agent's owner. |
| P2 | Archiving a chat cancels its open work (and sends a thread kill when the runtime supports it). |
| P2 | On runtimes without `thread-kill-v1`, Stop in a chat asks for confirmation: "stops all chats". |
| P2 | The agent-wide Stop gate (company owners/admins and the agent's owner) applies to the explicit `scope: "agent"` Stop only. Unchanged from before this feature: a Stop in a person's OWN private chat on a runtime without `thread-kill-v1` still widens to agent-wide after the confirmation, and a Stop in a shared-mode thread is agent-wide as before. |
| P1 | A pending Stop or Replace drops an agent's late reply only where it applies: an agent-wide command in every chat, a thread-scoped one only in its own chat. |
| P2 | `/goal` typed in one of the person's chats binds the objective (and its status replies) to that chat; without a thread id, or in a non-private thread, the main chat as before. |
| P2 | The chat list marks a chat running for a running run or an `acting` message; `queued` and `seen` both count as queued, as in the chat bubble. |
| P3 | Idle auto-archive is a `prepare` step of the hourly retention job (`private_chats_idle_archive`, `src/lib/idle-chat-archive.ts`). It only runs for companies with the setting on and private mode (restore is refused otherwise), keeps chats with a live objective in `active`, `blocked` or `paused` state, try-locks the per-(person, agent) advisory lock, and writes one `company.idle_chats_archived` audit row per company with a count. |
| P3 | Thread-exact links in run ledger, task story and work timeline only when the viewer may use the thread; `agent-health.ts` keeps `?agent=` (owner's local edits). |
| P3 | Bridge version bumped to 0.33.0, not 0.23.0: the release workflow publishes bridge assets only when the tag equals the bridge and installer version, so the bridge takes the version of the release that ships it. |
