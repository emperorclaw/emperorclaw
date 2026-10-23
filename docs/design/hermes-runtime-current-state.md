# Hermes runtime: current state map

Status: read-only survey, written 2026-10-22 against `main` @ 305f7ff (v0.8.103).
Purpose: baseline for moving from "bridge spawns `hermes chat -q --resume` per message" to "persistent Hermes server per agent + streaming bridge client".

Paths below are relative to the repo root. `B:` = `integrations/hermes/emperor-claw/bridge/emperor_hermes_bridge.py` (4,967 lines, `BRIDGE_VERSION = "0.3.0"` at B:157).

---

## 1. Bridge (`emperor_hermes_bridge.py`)

### 1.1 Process shape

- Single-threaded serial dispatcher. One message at a time; a `ThreadPoolExecutor` (B:357-395, `PREDISPATCH_WORKERS`) is used only for parallel context fetches and fire-and-forget status/ledger calls.
- Entry: `__main__` (B:4940-4967). Any `--flag` argv switches to an operator CLI (`--outbox`, `--redeliver <id>`, `--profile`), which re-execs with the live bridge env read from `/proc` (B:4907-4937). No flags -> `main()`.
- Globals carry per-turn state: `_active_turn_proc` (B:2517), `_turn_timing` / `_turn_session_id` (B:3236-3243), `_last_turn_reasoning` (B:2774). This assumes exactly one turn in flight; parallel threads would need these moved into a per-turn object.

### 1.2 Main loop (`main`, B:4418-4807)

Boot: SIGTERM/SIGINT handler (`_handle_shutdown`, B:2520), `ensure_runtime_boot()` (B:954, retries `/runtime/register` up to 900 s), `ensure_agent()` (B:1227, resolves/creates agent by name when `EMPEROR_CLAW_AGENT_ID` is unset), heartbeat, `load_state()`, 2-minute cold-start lookback (B:4429-4433), `reap_orphan_turns()` (B:783).

Each iteration (then `time.sleep(POLL_SECONDS)`, B:4807):
1. Heartbeat every 60 s (B:4441), capability refresh every `CAPABILITY_REFRESH_SECONDS` (B:4451).
2. `retry_pending_run_finish()` (B:4203).
3. Runtime controls: `apply_runtime_controls(fetch_runtime_control())` (B:4460), then `emperor_goals.process_commands` (B:4463).
4. `flush_outbox(budget_seconds=60)` (B:4467) — parked replies go before new work.
5. `sync_messages(state)` (B:1640) -> `GET /api/mcp/messages/sync?mode=all&agentId&since&retryMessageIds` (server long-polls up to 25 s, see 3.1).
6. Per message filter chain (B:4476-4590): processed delivery state, parked reply, `seen` ledger with direct-thread recovery, `retry_due`, DM-ownership learning, cold-start backlog guard for shared threads, `is_for_agent` (B:1577), parallel `check_budget` + `fetch_runtime_control(message)` gate (B:4571), local loop guard (only when `server_routed` is false), control re-apply / cancelled check.
7. Dispatch (B:4600-4785): see 1.3.
8. After batch: `emperor_goals.process_commands` + `emperor_goals.run_next` (B:4795-4796), outbox flush, `save_state`.

### 1.3 Dispatch pipeline (one message)

1. `run_id = uuid4()`, `announce_dispatch(...)` (B:4336) fires in background: `/chat/status` seen -> acting+typing, busy heartbeat (`currentLoad=1`), and `POST /agents/runs` (only if server advertised `runs: 1`, B:1026).
2. `run_hermes(message, state)` (B:3246) -> builds prompt, invokes subprocess (1.4).
3. `join_dispatch` + `end_dispatch_status` (B:4373, B:4308) so "acting" can never land after "resolved" (generation counter B:4296-4310, `resend_final_status_after` B:4313).
4. `report_token_usage` (B:3756) -> `POST /agents/report-usage`.
5. `outbox_put` (B:3520) writes reply to disk, `deliver_reply` (B:3599) -> `POST /messages/send` with `replyToMessageId` + `Idempotency-Key`; server marks message resolved.
6. On POST failure: reply parked; ledger finish payload stored inside the outbox entry (`ledger_finish`, B:4667-4680) and posted when it lands (`_finish_deferred_run`, B:3576).
7. On success: `emperor_goals.record_external_turn`, `post_reasoning_history` (opt-in), `safe_finish_run(... "succeeded", reply_message_id, toolCalls ...)` (B:4221).
8. Exceptions: `TurnInterrupted` -> cancelled run, typing off (B:4720). Anything else -> billed usage if spawned, requeue `executionState=queued`, `schedule_retry` (B:454) with environment-vs-model classification (`is_environment_failure` B:590), give-up notice + `cancelled` after `MAX_RETRY_ATTEMPTS` or `MAX_ENVIRONMENT_WAIT_SECONDS` (B:4737-4783).

### 1.4 Subprocess invocation

`run_hermes` builds (B:3366-3380):

```
$HERMES_BIN chat [--resume <sid>] -Q --format stream-json --source emperor --toolsets $HERMES_TOOLSETS -q <prompt>
```

(`--resume` inserted at index 3 when resuming.) `invoke_hermes` (B:2609-2770):
- Env copy plus per-turn vars: `EMPEROR_CLAW_LLM_PROVIDER`, `EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE=1`, `EMPEROR_CLAW_CONTEXT_MODE=lean|full`, `EMPEROR_CLAW_TURN_MESSAGE_ID`, `EMPEROR_CLAW_TURN_THREAD_ID`, `EMPEROR_CLAW_TURN_THREAD_TYPE` (B:2618-2646). **This env is the only channel by which per-turn context reaches the plugin** (see 2.3).
- `Popen(start_new_session=True)` (B:2649), two drain threads (cap 8 MiB, B:2563), 0.5 s supervision loop:
  - wall-clock timeout `HERMES_TIMEOUT_SECONDS` and idle timeout `HERMES_IDLE_TIMEOUT_SECONDS` (progress = stdout/stderr bytes or mtime/size of state.db/agent.log via `_runtime_progress_marker`, B:2566).
  - every 3 s: `GET /agents/control?messageId` + goal command poll; stop -> `_terminate_turn` (SIGTERM group, grace, SIGKILL; B:2479) and `TurnInterrupted`.
  - every 3 s: status ping with activity = `latest_reasoning_activity` (state.db) or `latest_tool_activity` (agent.log tail) or `format_turn_activity` elapsed text (B:2734-2741).
- Output parsing: `extract_stream_json` (B:2413) keeps only `text`/`result` events and `session_id`; tool events are discarded. Fallbacks: `clean_hermes_output` (B:2455), `extract_session_id` footer (B:2472).
- Recovery inside `run_hermes` (B:3381-3437): "Session not found" -> fresh session w/ static block; session contention (`SESSION_NOT_OWNED`, parsed via `hermes-refusal-reason:` B:532) -> `SessionBusy` or fresh session only if lease has no live holder (`session_holder_pid` B:798, `reap_orphan_turn` B:757). `_persist_killed_session` (B:2534) keeps a timed-out session id for resume.

### 1.5 Session-per-thread mapping and rotation

- Key: `session_key = f"{AGENT_NAME}:{thread_id}"` (B:3248). State fields: `state["sessions"][key] = hermes_session_id`, `state["primed"][key] = {staticHash, turns, startedAt}` (B:3435-3436).
- Rotation (B:3260-3263, 3343-3351): team/group `SESSION_MAX_TURNS=40` / `SESSION_MAX_HOURS=24`; direct `DIRECT_SESSION_MAX_TURNS=400` / `DIRECT_SESSION_MAX_HOURS=168`. Rotation drops `--resume` and re-sends the static block.
- Stop/replace wipes all sessions: `state["sessions"] = {}` (B:2601).
- State file: `STATE_PATH` (default `~/.hermes/emperor-bridge-state.json`, B:56); atomic write + `.bak` + `.corrupt` (B:397-426). Also holds `seen`, `lastSeenAt`, `retries`, `direct_threads`, `loop_guard`, `objective`, `goalTransportReady`.

### 1.6 Prompt building

- Static block (sent once per session, hash-tracked): `build_static_block` (B:3072) -> `build_full_static_block` (B:2976: identity, instructions, memory, operating guide, rules, reply-format guide, roster, Company Brain) or `build_lean_static_block` (B:3034, from `GET /context/lean` with ETag, B:1060-1145). Cache/plan: `plan_static_block` (B:3172) returns build/changed/refresh/reuse; background refresh `schedule_static_refresh` (B:3212); `invalidate_static_block` (B:3160) on capability change.
- Dynamic block per turn: `build_dynamic_block` (B:3109): open tasks, main-chat digest (direct only), group context, org chart, team roles, ack reminder, `Thread:`, `Latest message:`.
- Ack reminder: `ACK_FIRST_REMINDER` (B:3088), only for human senders and never for `goalTurn` (B:3094).

### 1.7 Status / typing

`update_chat_status` (B:1841) -> `POST /api/mcp/chat/status` with `threadId, agentId, typing, markRead, executionState, messageId, activity, reason`. Activity sources:
- Reasoning: `ReasoningSource` / `SessionStoreReasoningSource` reads `$HERMES_HOME/state.db` (B:2044-2298), selected by `EMPEROR_CLAW_REASONING_SOURCE` (`auto|session-store|none`, B:2012, `_build_reasoning_source` B:2310). Condensed to <=160 chars (B:2075).
- Tool activity: regex over `$HERMES_HOME/logs/agent.log` `agent.tool_executor` lines (B:1897-2010).
- Full reasoning history (opt-in `EMPEROR_CLAW_REASONING_HISTORY=on`, B:2028) -> `POST /chat/reasoning` (B:2394).
- Usage and tool counts also come from agent.log regexes: `sum_api_usage` (B:4026), `count_tool_calls` (B:3988), `model_call_stats` (B:4072).

### 1.8 Run ledger

- Start payload `build_run_start_payload` (B:3897): `id, agentId, runtimeId, runtimeKind="hermes", bridgeVersion, triggerKind="message", startedAt, triggerMessageId, threadId, taskId`.
- Finish payload `build_run_finish_payload` (B:3957): `status, endedAt, durationMs, inputTokens, outputTokens, toolCalls, replyMessageId, error`. Status mapping `map_run_status` (B:3925); secret-safe error `ledger_error_message` (B:3940).
- Circuit breaker `LedgerBreaker` (B:3822, 3 failures -> 5 min), 5 s timeout, one pending finish retry (B:4183-4219). Goal turns (`emperor_goals.run_next`) do NOT open ledger runs.

### 1.9 Outbox

Dir `EMPEROR_CLAW_HERMES_OUTBOX_DIR` (default `<state>-outbox`, B:3479). `outbox_entry/put/save/forget` (B:3494-3560), `deliver_reply` (B:3599), `flush_outbox` (B:3667) with backoff (`OUTBOX_RETRY_*`, `OUTBOX_MAX_ATTEMPTS`). Guarantees a finished turn is never re-run.

### 1.10 Retries / environment waits

`schedule_retry` (B:454), `retry_due` (B:447), `busy_misses` (B:521), `environment_wait_exhausted` (B:503), `is_session_contention` / `is_transient_failure` / `is_environment_failure` (B:569-618), provider 402 detection (B:866-887). HTTP layer: `api()` (B:309) with `_urlopen_retrying` (B:279) budgeted by `TRANSPORT_*`.

### 1.11 Goals / objectives

- `emperor_goals.py` (203 lines): `process_commands` (:34) polls `GET/POST /agents/goals`; `run_next` (:133) builds a synthetic `goalTurn` message and calls `bridge.run_hermes` directly (:163), then `send_reply`, then native evaluation; `pause_all` (:98); `record_external_turn` (:114).
- `native_goal` (:9-31) shells out to `hermes_goal_adapter.py` inside Hermes' venv (`HERMES_INSTALL_DIR`, `EMPEROR_HERMES_GOAL_PYTHON`, `scripts/run-in-hermes-env`) and imports `hermes_cli.goals` (adapter :6-43). It keys goals by Hermes **session id** and migrates them across rotation (`migrate_goal_to_session`).
- The goals module is coupled to bridge internals via `sys.modules[__name__]` (uses `api`, `run_hermes`, `send_reply`, `save_state`, `_last_turn_reasoning`, `TurnInterrupted`, `AGENT_NAME`).

### 1.12 Control commands (stop / kill / replace)

`fetch_runtime_control` (B:2587) -> `GET /api/mcp/agents/control?agentId[&messageId]` returns `{commands, cancelled}`; server selects queued system messages with `metadataJson.runtimeControl.action IN ('kill','replace')` (`src/app/api/mcp/agents/control/route.ts:21-34`). `apply_runtime_controls` (B:2594) pauses goals, wipes sessions, acks each with `POST /agents/control {commandId}` (route :40-52). Mid-turn stop = process-group kill.

### 1.13 Environment variables read by the bridge (defaults)

| Var | Default | Line |
|---|---|---|
| EMPEROR_CLAW_API_URL | https://emperorclaw.malecu.eu | B:23 |
| EMPEROR_CLAW_API_TOKEN | "" (required) | B:24 |
| EMPEROR_CLAW_AGENT_NAME | Hermes | B:25 |
| EMPEROR_CLAW_AGENT_ROLE | operator | B:26 |
| EMPEROR_CLAW_AGENT_INSTRUCTIONS | "" | B:27 |
| EMPEROR_CLAW_AGENT_ID | "" (resolve/create by name) | B:28 |
| EMPEROR_CLAW_RUNTIME_ID | hermes-<host>-<rand8> | B:29 |
| EMPEROR_CLAW_HERMES_POLL_SECONDS | 5 | B:36 |
| EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS | 0 (off) | B:40 |
| EMPEROR_CLAW_HERMES_IDLE_TIMEOUT_SECONDS | 900 | B:46 |
| EMPEROR_CLAW_HERMES_TIMEOUT_GRACE_SECONDS | 10 | B:50 |
| EMPEROR_CLAW_HERMES_ORPHAN_GRACE_SECONDS | 8 | B:55 |
| EMPEROR_CLAW_HERMES_STATE_PATH | ~/.hermes/emperor-bridge-state.json | B:56 |
| EMPEROR_CLAW_HERMES_RETRY_BASE_SECONDS | 15 | B:57 |
| EMPEROR_CLAW_HERMES_RETRY_MAX_SECONDS | 300 | B:58 |
| EMPEROR_CLAW_HERMES_MAX_RETRY_ATTEMPTS | 3 | B:59 |
| EMPEROR_CLAW_HERMES_TRANSPORT_ATTEMPTS | 6 | B:71 |
| EMPEROR_CLAW_HERMES_TRANSPORT_BACKOFF_SECONDS | 0.5 | B:72 |
| EMPEROR_CLAW_HERMES_TRANSPORT_BACKOFF_MAX_SECONDS | 3 | B:73 |
| EMPEROR_CLAW_HERMES_TRANSPORT_TOTAL_BUDGET_SECONDS | 25 | B:74 |
| EMPEROR_CLAW_HERMES_SESSION_BUSY_BASE_SECONDS | 45 | B:83 |
| EMPEROR_CLAW_HERMES_SESSION_BUSY_MAX_SECONDS | 600 | B:85 |
| EMPEROR_CLAW_HERMES_SESSION_BUSY_FRESH_AFTER | 3 | B:87 |
| EMPEROR_CLAW_HERMES_MAX_ENVIRONMENT_WAIT_SECONDS | 86400 | B:93 |
| EMPEROR_CLAW_DOCTRINE_RESOURCE_ID | "" | B:121 |
| EMPEROR_CLAW_OPERATING_GUIDE_PATH | "" (sibling operating-guide.md) | B:126 |
| EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS | 6000 | B:131 |
| EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS_PER_RESOURCE | 0 (no cap) | B:136 |
| EMPEROR_CLAW_MAIN_CHAT_CONTEXT_LIMIT | 6 | B:142 |
| EMPEROR_CLAW_MAIN_CHAT_CONTEXT_MAX_CHARS | 1800 | B:143 |
| EMPEROR_CLAW_MAIN_CHAT_CONTEXT_PER_MESSAGE_CHARS | 300 | B:144 |
| EMPEROR_CLAW_RICH_REPLIES | on | B:149 |
| EMPEROR_CLAW_CONTEXT_MODE | full | B:165 |
| EMPEROR_CLAW_LEAN_REVALIDATE_SECONDS | 600 | B:170 |
| EMPEROR_CLAW_CAPABILITY_REFRESH_SECONDS | 600 | B:177 |
| EMPEROR_CLAW_LOOP_GUARD_MAX_TURNS | 3 | B:187 |
| EMPEROR_CLAW_HERMES_ACK_FIRST | 1 | B:190 |
| EMPEROR_CLAW_HERMES_SESSION_MAX_TURNS | 40 | B:199 |
| EMPEROR_CLAW_HERMES_SESSION_MAX_HOURS | 24 | B:200 |
| EMPEROR_CLAW_HERMES_DIRECT_SESSION_MAX_TURNS | 400 | B:202 |
| EMPEROR_CLAW_HERMES_DIRECT_SESSION_MAX_HOURS | 168 | B:203 |
| EMPEROR_CLAW_STATIC_BLOCK_REFRESH_MINUTES | 10 | B:211 |
| EMPEROR_CLAW_HERMES_PREDISPATCH_WORKERS | 8 | B:216 |
| EMPEROR_CLAW_OPEN_TASKS_LIMIT | 5 | B:217 |
| EMPEROR_CLAW_HERMES_PROFILE (fallback for HERMES_PROFILE) | "" | B:626 |
| EMPEROR_CLAW_REASONING_SOURCE | auto | B:2012 |
| EMPEROR_CLAW_REASONING_HISTORY | off | B:2028 |
| EMPEROR_CLAW_HERMES_OUTBOX_DIR | <state>-outbox | B:3480 |
| EMPEROR_CLAW_HERMES_OUTBOX_RETRY_BASE_SECONDS | 15 | B:3482 |
| EMPEROR_CLAW_HERMES_OUTBOX_RETRY_MAX_SECONDS | 900 | B:3484 |
| EMPEROR_CLAW_HERMES_OUTBOX_MAX_ATTEMPTS | 8 | B:3486 |
| EMPEROR_CLAW_RUNTIME_MODEL / EMPEROR_CLAW_LLM_MODEL | unset | B:3775 |
| EMPEROR_CLAW_PROFILE (CLI only) | builder | B:4943 |
| EMPEROR_CLAW_CLI_ACTIVE (CLI re-exec guard) | unset | B:4954 |

Non-EMPEROR vars: `HERMES_BIN` (hermes, B:30), `HERMES_TOOLSETS` (web,terminal,code_execution, B:35), `HERMES_HOME` (B:623, 1940, 2304, 2573), `HERMES_PROFILE` (B:626). Goals module: `HERMES_INSTALL_DIR`, `EMPEROR_HERMES_GOAL_PYTHON` (emperor_goals.py:10-12).

Exported to the Hermes child (not read by the bridge itself): `EMPEROR_CLAW_LLM_PROVIDER`, `EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE`, `EMPEROR_CLAW_CONTEXT_MODE`, `EMPEROR_CLAW_TURN_MESSAGE_ID`, `EMPEROR_CLAW_TURN_THREAD_ID`, `EMPEROR_CLAW_TURN_THREAD_TYPE` (B:2618-2646).

### 1.14 Seams for a transport abstraction

Everything Hermes-process-specific is concentrated in a small set of functions. A `HermesTransport` interface (e.g. `CliTransport` = today, `ServerTransport` = persistent server) should own:

| Seam | Today | Notes |
|---|---|---|
| Turn execution | `invoke_hermes` (B:2609) + the cmd build / retry block of `run_hermes` (B:3366-3437) | Return a structured result `{reply, session_id, usage, tool_calls, reasoning}` instead of a `CompletedProcess`. |
| Progress/event stream | 3 s poll of `latest_reasoning_activity` / `latest_tool_activity` (B:2734) | Server transport emits tool start/complete, reasoning, usage events; CLI transport keeps log tailing. |
| Interrupt | `_terminate_turn` (B:2479), `stop_turn` (B:2694), `_handle_shutdown` (B:2520) | Becomes `transport.interrupt(turn)`. |
| Session ownership / contention | `session_holder_pid`, `reap_orphan_turn(s)`, `SessionBusy`, `_persist_killed_session` (B:757-840, 2534, 3271-3291, 3404-3434) | Largely disappears with one server owning `state.db`; keep behind the CLI transport. |
| Usage and tool counts | `sum_api_usage`, `count_tool_calls`, `model_call_stats` (agent.log regex, B:3988-4106) | Should come from structured usage events. |
| Reasoning | `ReasoningSource` (B:2044-2390) | Already an interface; add an event-fed source. |
| Per-turn plugin context | env vars in `invoke_hermes` (B:2618-2646) | Cannot work with a long-lived server process; needs a per-request channel (see 2.3). |
| Goal engine | `native_goal` subprocess (emperor_goals.py:9) + direct `bridge.run_hermes` calls (:163) | Must go through the same transport (and ideally the run ledger). |
| Compaction | Implicit via rotation + profile `compression.*` defaults | A server transport could compact explicitly after reply. |

Parallel threads additionally require removing the per-turn globals (1.1), and making `main`'s serial loop and `state` writes thread-safe (state is a plain dict saved from many places).

---

## 2. Plugin (`integrations/hermes/emperor-claw/__init__.py`, 1,495 lines; `plugin.yaml` v0.3.0)

### 2.1 Env vars read

| Var | Line | Use |
|---|---|---|
| EMPEROR_CLAW_API_URL | :20 | base URL (default https://emperorclaw.malecu.eu) |
| EMPEROR_CLAW_API_TOKEN | :24 | bearer token; `_available()` gates registration |
| EMPEROR_CLAW_AGENT_ID / EMPEROR_CLAW_AGENT_NAME | :29-30 | `_agent_ref()` for agentId fields |
| EMPEROR_CLAW_TOOL_RESULT_MAX_CHARS | :62 | tool result compaction (default 12000) |
| EMPEROR_CLAW_TURN_THREAD_ID / _TURN_MESSAGE_ID / _TURN_THREAD_TYPE | :865-878 | `emperor_send_message` ack + `replyToMessageId` stamping |
| EMPEROR_CLAW_CONTEXT_MODE | :943 | context hook injects nothing in lean mode |
| EMPEROR_CLAW_PROMPT_INCLUDES_OPERATING_GUIDE | :945 | context hook skips duplicate guide |

### 2.2 Registration

`register(ctx)` (:1003): `requires = ["EMPEROR_CLAW_API_TOKEN"]`, `ctx.register_skill(...)` (:1008), 29 `ctx.register_tool(...)` calls (:1013-1479, toolset `emperor-claw`), `ctx.register_hook("pre_llm_call", emperor_context_hook)` (:1495). `plugin.yaml` lists 28 `provides_tools` and the `pre_llm_call` hook.

### 2.3 How per-turn context reaches the plugin

Only through process environment set by the bridge on the spawned `hermes chat` (B:2618-2646). The plugin reads `os.environ` at call time (:865-879, :943-945). With a persistent Hermes server, env is fixed at server start, so `acknowledge=true` acks and `replyToMessageId` stamping break unless context moves to a per-request mechanism (request metadata exposed to tools, a contextvar set by the server per session, or the bridge passing turn ids in the prompt/session metadata). Note also the profile is separately wired to Emperor's real MCP server (`mcp_servers.emperorclaw`, entrypoint.sh:140-152), which has no turn context at all.

---

## 3. Server side touched by runtimes

### 3.1 Endpoints

| Endpoint | File | Notes |
|---|---|---|
| GET /api/mcp/messages/sync | `src/app/api/mcp/messages/sync/route.ts` | Server long-poll: `MAX_POLL_TIME_MS=25000`, `POLL_INTERVAL_MS=1000` DB re-query (:50-52, :217). Params `since, mode, agentId, senderType, retryMessageIds` (:22-26). Excludes `runtimeControl`/`runtimeGoalRequest` system messages (:61-62). Server-side routing/loop guard via `routeForAgent` (:185), thread details (:234). Touches liveness (:47). |
| POST /api/mcp/messages/send | `src/app/api/mcp/messages/send/route.ts` | Zod body incl. `replyToMessageId`, `ack` (:14-26); idempotency only for replies via `Idempotency-Key` header (:36, :86, :118-135). |
| POST /api/mcp/chat/status | `src/app/api/mcp/chat/status/route.ts` | `AGENT_TYPING_TTL_MS=20_000` (:16). `typing` sets `typingUntil`, `currentActivity` trimmed to 200 chars and cleared when typing stops (:36-45). Broadcasts `participant_status` (:50-57). `cancelled` -> `markMessageFailedByRuntime` + notification (:63-79). Other states -> `updateThreadExecutionState` scoped by `messageId` (:81-101). |
| POST /api/mcp/chat/reasoning | `src/app/api/mcp/chat/reasoning/route.ts` | Writes `thread_message_reasoning`. |
| POST /api/mcp/agents/runs | `src/app/api/mcp/agents/runs/route.ts` | Idempotent start (`onConflictDoNothing`, :58-75), 2,000/min rate limit (:10, :52), bound-agent check (:41-49). Schema `startRunSchema` (`src/lib/run-ledger.ts:69-81`). |
| PATCH /api/mcp/agents/runs/[id] | `src/app/api/mcp/agents/runs/[id]/route.ts` | Idempotent finish; upserts a missing row; only `running`/`lost` can move (:12-17). Schema `finishRunSchema` (run-ledger.ts:84-95). Body cap 8 KiB (`RUN_PAYLOAD_MAX_BYTES`, run-ledger.ts:16). |
| POST /api/mcp/runtime/register | `src/app/api/mcp/runtime/register/route.ts` | Upserts `runtime_nodes` via `registerRuntimeNode` (`src/lib/control-plane.ts:~950-985`). Returns `serverCapabilities` + `replyFormatGuide` (:35-39). `SERVER_CAPABILITIES = [rich-blocks-v1, runs: 1, lean-context: 1]` (`src/lib/rich-reply-guide.ts:78`). |
| POST /api/mcp/agents/heartbeat | `src/app/api/mcp/agents/heartbeat/route.ts` | `agentId, currentLoad`. |
| GET/POST /api/mcp/agents/control | `src/app/api/mcp/agents/control/route.ts` | See 1.12. |
| GET/POST /api/mcp/agents/goals | `src/app/api/mcp/agents/goals/route.ts` | Objective command transport. |
| POST /api/mcp/agents/report-usage | `src/app/api/mcp/agents/report-usage/route.ts` | Token/cost accounting, separate from the ledger. |
| GET /api/mcp/context/lean | `src/app/api/mcp/context/lean/route.ts` | Lean static block, ETag. |
| GET /api/mcp/live | `src/app/api/mcp/live/route.ts` | Polled feed for screens (ETag/304), built by `src/lib/live-feed.ts`. |
| POST /api/mcp/actions, /actions/[id]/steps | `src/app/api/mcp/actions/route.ts`, `.../actions/[id]/steps/route.ts` | Generic action run/step logging (OpenClaw era). |

The bridge does not use `runtime/health`, `agents/[id]/sessions/*` (OpenClaw session lifecycle) or `actions/*`.

### 3.2 Tables (`src/db/schema.ts`)

- `runtime_nodes` :331-344 — `runtimeId, name, hostname, gatewayVersion, capabilitiesJson, status, lastSeenAt, startedAt`. Bridge sends `gatewayVersion="hermes-agent"` (constant) and capabilities `["hermes-agent","thread-reply","emperor-tools","rich-replies"]` (B:931-932). **No bridge version is sent here.**
- `agent_sessions` :346-~370 — OpenClaw session model (`openclawSessionId`, checkpoints, wake attempts). Not used by the Hermes bridge.
- `thread_participants` :842-860 — `typingUntil`, `currentActivity` (ephemeral live line).
- `thread_message_reasoning` :925-937 — one row per reply message, opt-in.
- `action_runs` :950-964 / `action_steps` :966-980 — `stepType, toolName, status, target, inputSummaryJson, outputSummaryJson, errorText, startedAt, endedAt`. Not linked to `agent_runs`, step id server-generated (not idempotent), insert-only (no PATCH for completion), no index on `action_run_id`, no UI reader (only `agent-deletion.ts` and `api/agents/[id]/route.ts` touch it).
- `agent_runs` :1151-1179 — `id (runtime-generated uuid), agentId, runtimeId, runtimeKind, bridgeVersion, triggerKind, triggerMessageId, threadId, taskId, replyMessageId, status, startedAt, endedAt, durationMs, inputTokens, outputTokens, costCents, toolCalls, error`; indexes per agent/startedAt, trigger message, running.
- `agent_run_daily` :1204-1224 — 400-day rollup. Lost-run closer `closeLostRunsSql` (run-ledger.ts:324, `LOST_RUN_AFTER_MS` 2 h, :33) run by retention (`src/lib/retention.ts:134`).

**Per-step events:** nothing suitable exists. `action_steps` is the closest shape but lacks a run FK to `agent_runs`, idempotent client ids, sequence numbers, update/complete semantics, retention and indexes. Recommendation: a new `agent_run_events` table (`id` client uuid, `run_id` FK -> agent_runs ON DELETE CASCADE, `company_id`, `seq`, `kind` tool_start|tool_end|reasoning|usage|compaction|..., `tool_name`, `status`, `duration_ms`, small redacted `summary`/`data jsonb`, `created_at`; unique `(run_id, seq)`; index `(company_id, created_at)` for retention), plus a batch append endpoint (e.g. `POST /api/mcp/agents/runs/[id]/events`) gated by a new server capability (`run-events: 1`) so old bridges keep working. Keep it out of the 8 KiB finish payload.

### 3.3 Realtime to the browser

- `broadcastMcpEvent` (`src/lib/pubsub.ts:15-36`) does `pg_notify('mcp_events', ...)`, 7.5 KB cap with a compact "refetch" envelope.
- `server.ts:70-252` hosts a `ws` server at `/api/mcp/ws`, authenticated with an **MCP bearer token in the Authorization header** (:72-93), fan-out per company from `LISTEN mcp_events` (:124-224). Browsers cannot set that header, and no component connects to it (no `api/mcp/ws` / `new WebSocket` reference in `src/components`).
- Production Docker runs `node server.js` (Next standalone output, `Dockerfile:65`), while `server.ts` is only used by `npm run dev` / `npm start` (`package.json:9,11`). So in the Docker deployment the WS endpoint and the LISTEN loop are most likely not running at all (verify before relying on it).
- The browser polls: direct chat every 3 s (`src/components/agent-direct-chat.tsx:308-314`) and team chat every 5 s (`src/components/agent-team-chat.tsx:253`) against `/api/chat`, which returns `participants` (`src/app/api/chat/route.ts:74-78`). There is no SSE route.
- Implication: streaming tool events to the UI needs either a new SSE route with session-cookie auth (works with the standalone server; must handle multi-instance via the existing NOTIFY channel) or event rows read by the existing polls.

### 3.4 Live status consumers

- `src/components/live-status-row.tsx:31-85` — memoised row; `useLiveActivity` holds an activity line (`src/lib/live-activity.ts`, `LIVE_ACTIVITY_HOLD_MS=20_000` :10, max 200 chars :13).
- `agent-direct-chat.tsx:605-612` picks the typing agent (`typingUntil > now`) and `currentActivity`.
- `agent-team-chat.tsx:416-424` shows activity only when exactly one agent types.
- `src/lib/agent-activity.ts:118-200` — per-agent "now" snapshot joining `thread_participants` typing rows, open `agent_runs`, claimed task, last run, last message; privacy via `threadVisibleToViewer` (:91) and `redactRunForViewer` (:101).
- `src/lib/live-feed.ts` — firmware/dashboard feed v2 (:32); activity at :646, thoughts from `thread_message_reasoning` (:448-497).
- Delivery inspector `src/components/delivery-inspector.tsx:89` -> `/api/messages/[id]/delivery` -> `loadMessageDelivery` (`src/lib/run-ledger-reads.ts:43`), shows runs incl. `toolCalls` (:67-69).
- Runs tab `src/app/(app)/agents/agent-runs-tab.tsx:81,107` -> `/api/agents/[id]/runs` -> `loadAgentRunsPage` (run-ledger-reads.ts:113); 30-day chart from `agent_run_daily`.

---

## 4. Mode B (local/managed Docker)

- Entry points: Easy Setup `src/app/api/agents/easy-setup/route.ts:174`, hire flow `src/lib/hire-hermes-agent.ts:12-50` (also via MCP tool `src/lib/mcp-server/tools/agents.ts` and `src/app/api/mcp/agents/route.ts`), setup-local Docker branch `src/app/api/agents/[id]/setup-local/route.ts:86-104`, recreate `src/app/api/agents/[id]/recreate-runtime/route.ts:45`, self-update roll `src/app/api/ops/update/route.ts:254-291`.
- `provisionHermesContainer` (`src/lib/hermes-provisioning.ts:90-263`):
  - Image `HERMES_IMAGE = EMPEROR_CLAW_HERMES_IMAGE || ghcr.io/emperorclaw/emperorclaw-hermes:latest` (:25-26); pulled for `linux/amd64` (:150), falls back to a local cached image (:152-160).
  - URL: probes `http://<own container hostname>:<port>/api/health`, falls back to `NEXTAUTH_URL` (:129-140).
  - Env (:165-201): API URL/token, agent name/id/role, `EMPEROR_CLAW_RUNTIME_ID=hermes-<safe>-<id8>-1`, poll 5, timeout 0, idle 900, retries 3, `HERMES_BIN=hermes` (overridden by entrypoint), `HERMES_TOOLSETS=emperor-claw,web,terminal,code_execution`, `EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS` (newline `key=value`, `src/lib/hermes-profile-defaults.ts:9-44`: compression thresholds, `approvals.single_query_mode=approve`, `tools.tool_search.enabled=off`), optional instructions, `EMPEROR_CLAW_LLM_PROVIDER/MODEL`, provider key env (`PROVIDER_ENV_VAR` :32-39).
  - Volume `hermesVolumeName(...)` mounted at `/home/hermes/.hermes/profiles`; state path set inside it (:211-221).
  - Container: same network mode as the app, `restartPolicy unless-stopped`, 512 MiB, 1 CPU (:225-234). One container per agent. **No Docker healthcheck** is defined (none in Dockerfile or create call).
  - Token: `mintAgentSetupToken` (:51-63) — new agent-bound `mcp_full` token per provision/recreate (old tokens are not revoked here).
- `recreateHermesContainer` (:272-318): stop + rm by `agents.containerId`, new token, re-provision, sets `status: "offline"` until the bridge heartbeats.
- Image (`integrations/hermes/Dockerfile`): `python:3.11-slim`, Node 26 via NodeSource, plugin+bridge copied to `/opt/emperor-claw-plugin/`, Hermes installed with `curl .../NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup` — **unpinned (tracks `main`)**; the Hermes version in the image is whatever `main` was at image build time.
- `integrations/hermes/entrypoint.sh`: `hermes profile create --clone` (:8), wrapper recreation (:19-25), plugin copy + enable (:27-32), provider/model config (:42-104), tool-loop hard stop (:112), apply `EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS` (:118-124), platform hint replace (:132), MCP server wiring (:140-152), `HERMES_BIN=~/.local/bin/<profile>` (:166), `HERMES_HOME=~/.hermes/profiles/<profile>` (:174), `exec python .../bridge/emperor_hermes_bridge.py` (:177). PID 1 = bridge; a persistent Hermes server would need a supervisor or a second process in this container.
- UI during provisioning: `src/app/(app)/agents/easy-setup-dialog.tsx`, `src/components/setup-wizard.tsx`, `src/components/setup-output-log.tsx` render the synchronous `outputs[]` (`SetupOutput` command/stdout/stderr/exitCode) returned by the route; no streaming progress. Recreate is in `agent-detail-panel.tsx`.
- Third, legacy path: setup-local bare-metal branch (`setup-local/route.ts:106-180`) runs `hermes profile create`, copies the plugin from the app's repo, writes `~/.hermes/emperor-bridge/<name>/.env`, and starts the bridge with `nohup`/`start /B` on the app host.

---

## 5. Mode A (remote)

- Docs: `src/content/docs/v1.1/hermes-runtime.md` — install Hermes from upstream `main` (:37), copy plugin into each profile and `plugins enable` (:62-84), bridge `.env` example (:136-170), one systemd **user** unit per agent with `EnvironmentFile`, `HERMES_HOME`, `HERMES_PROFILE`, `ExecStart=/usr/bin/python3 ~/.hermes/emperor-bridge/emperor_hermes_bridge.py`, `Restart=always`, logs to `bridge.log` (:192-227); "Quick Setup via LLM" prompt (:504-527). Also `integrations/hermes/emperor-claw/README.md:36-300` (same flow, `cp bridge/emperor_hermes_bridge.py ~/.hermes/emperor-bridge/`, :240-265), `src/lib/agent-providers.ts:107,145`, and UI instructions in `src/app/(app)/agents/agent-detail-panel.tsx:812-813, 953`.
- Distribution/update: manual file copy from the repo. There is no Hermes bridge installer — `install-bridge.sh` / `.ps1` install the **OpenClaw** companion (`~/.openclaw/emperor-control-plane`, `scripts/control-plane.js`), and `clawhub/` is the OpenClaw skill/plugin. No auto-update.
- Documented copy instructions flatten the bridge into `~/.hermes/emperor-bridge/`, but the bridge imports `emperor_goals` (sibling module, B:4462) which needs `hermes_goal_adapter.py` beside it; the README notes operating-guide.md must be copied separately (:247-256). Remote installs therefore already drift in file layout.
- Versioning/compat: `BRIDGE_VERSION = "0.3.0"` (B:157) is only sent in `POST /agents/runs` (`bridgeVersion`, stored on `agent_runs`). `/runtime/register` gets a constant `gatewayVersion` and fixed capabilities; the server never rejects or warns on old bridges. Compatibility is negotiated in one direction only: server advertises `serverCapabilities`, bridge feature-detects (`runs: 1`, `lean-context: 1`, `rich-blocks-v1`; B:150-167, B:1006-1040).

---

## 6. Tests and CI

- Python (`npm run test:bridge`, `package.json`): `tests/bridge-safety.test.py` (164 tests: guards, state, retries, contention, outbox, subprocess handling), `tests/hermes-hiring.test.py` (19), `tests/hermes-goals.test.py` (18), `tests/hermes-routing.test.py` (27), `tests/hermes-run-ledger.test.py` (26). **Not in CI:** `tests/hermes-latency.test.py` (48: static-block plan, parallel prefetch, dispatch status), `tests/hermes-plugin-results.test.py` (40: plugin result compaction), `tests/agent-chat.test.py` (9).
- Node static/unit (`npm test`): `tests/unit/bridge-logic.test.cjs`, `run-ledger*.test.ts`, `live-activity.test.ts`, `agent-activity.test.ts`, `live-feed*.test.ts`, `hermes-profile-defaults.test.ts`, `hermes-names.test.ts`, `docker-pull-response.test.ts`, `agent-control-command.test.ts`, `agent-goal-command.test.ts`, `reasoning-history.test.ts`; root `tests/installer.test.cjs`, `env-deployment.test.cjs`, `easy-setup-providers.test.cjs`, `dockerfile-migrate-imports.test.cjs`, `docs-integrity.test.cjs`.
- Integration (`npm run test:integration`, Postgres service): `tests/integration/run-ledger.test.ts`, `register.test.ts`, `agent-control.test.ts`, `agent-goal.test.ts`, `lean-context.test.ts`, `live-feed.test.ts`, `dashboard-live.test.ts`, `report-usage.test.ts`, `mention-delivery.test.ts`, `objectives.test.ts`, `retention.test.ts`.
- Workflows: `.github/workflows/ci.yml` (npm test, drizzle drift check `drizzle-kit generate --name _drift_check` :50-57, Python 3.11 bridge tests :59-68, app `docker build` no-push :72, integration job :75+). `.github/workflows/docker-publish-hermes.yml`: on `v*` tags builds `integrations/hermes` for `linux/amd64`, tags `<tag>`, `latest`, `<sha>` to `ghcr.io/<repo>-hermes`, then verifies anonymous pull. The Hermes image is **not** built in PR CI. `docker-publish.yml` publishes the app.
- No test exercises a real `hermes` binary; subprocess behaviour is mocked.

---

## 7. Risks for a breaking change

1. **Remote users (Mode A)** run hand-copied bridge files under their own systemd units. A server-transport bridge means: upgrade Hermes to a version with the server/streaming API, copy new bridge files (plus any new sibling modules), add a second long-running unit (or let the bridge supervise `hermes serve`), and possibly new env (server port/socket). Nothing updates them automatically, and the server cannot see their bridge version until a run is opened. Keep the CLI transport as a fallback selectable by env (e.g. `EMPEROR_CLAW_HERMES_TRANSPORT=cli|server`, auto-detect) and gate new server endpoints behind new `serverCapabilities` entries; send `BRIDGE_VERSION` and transport in `/runtime/register` (`gatewayVersion`/`capabilitiesJson`) so Ops can see who is behind.
2. **Per-turn plugin context via env** (2.3) silently breaks acks/`replyToMessageId` under a persistent server. Must be solved before switching transports.
3. **Hermes version is unpinned** in the image (Dockerfile installs from `main`) and in docs. A server API dependency needs a pinned/minimum Hermes version and a startup capability probe.
4. **Mode B container shape**: entrypoint `exec`s the bridge as PID 1, no healthcheck, 512 MiB limit; a resident Hermes server plus bridge in one container needs a supervisor/tini and likely more memory. Existing volumes hold `state.json` `sessions` keyed for `--resume`; the new transport must accept or migrate these, and objectives are keyed by Hermes session id (emperor_goals.py).
5. **Session semantics**: rotation, `primed` static-block hashes, contention/orphan handling and goal session migration are all CLI-lease-shaped. Parallel threads conflict with the single-writer assumptions (`state` dict, globals, one `state.db` writer).
6. **Usage/tool counts and reasoning** currently depend on agent.log text formats and state.db columns; a server transport changes where these come from — keep ledger fields (`inputTokens`, `outputTokens`, `toolCalls`) populated identically so Runs tab and `agent_run_daily` stay comparable.
7. **Realtime**: the production Docker image runs Next's standalone `server.js`, not `server.ts`, so the WS/NOTIFY path is likely inactive there; the browser relies on 3-5 s polling. Live tool events need a design that works on the standalone server.
8. **DB migrations**: drizzle-kit, files `src/db/migrations/NNNN_<kebab-name>.sql` (latest `0060_knowledge-injection-modes`, journal in `meta/_journal.json` + snapshot), CI fails on schema/snapshot drift. Migrations run at container start via `npx tsx src/db/migrate.ts` (`Dockerfile:65`); the runner image copies only `src/db/{migrations,migrate.ts,index.ts,schema.ts}`, `src/lib/character`, `knowledge-backfill.ts`, `knowledge-summary.ts` (`Dockerfile:36-46`). Anything newly imported by `migrate.ts` must be added to the Dockerfile — enforced by `tests/dockerfile-migrate-imports.test.cjs` (v0.8.98 outage). Keep any `agent_run_events` migration purely additive (new table + indexes) and add it to retention (`src/lib/retention.ts`).
9. **Release coupling**: the Hermes image is only built on tags; Mode B agents roll forward via `ops/update` recreate (`ops/update/route.ts:254-291`), while Mode A stays on whatever was copied. Both bridge generations will coexist against the same server for a long time.
