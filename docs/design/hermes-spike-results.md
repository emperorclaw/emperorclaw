# Hermes v0.22.4 spike results (W0)

Status: measured 2026-10-22 against a **real Hermes v0.22.4 gateway** (`4d04303818b6`, verified at
image build), in Docker on the owner's Windows machine (Docker Desktop, x86_64, Python 3.14.7 inside
Hermes' venv). The model is Hermes' own loopback fake provider; no real keys, no production host was
touched.

Inputs: `docs/design/hermes-server-protocol.md` (**P§n**), `docs/design/hermes-persistent-runtime.md`
(**R§n**, decisions **D1–D20**, spikes **S-1..S-20**).

Where things are:

| What | Path |
|---|---|
| Harness (one command) | `tests/contract/hermes/run.sh` → builds `tests/contract/hermes/Dockerfile`, runs `gateway_probe.py`. README next to it. Kept here (not `scripts/hermes-spike/`) so W8 can adopt it as-is. |
| Full evidence of the last run | `tests/contract/hermes/results/probe-report.json` (git-ignored, regenerate with `run.sh`) |
| Recorded wire fixtures (S-20) | `tests/fixtures/hermes-v0224/*.jsonl` (9 files, see §5) |
| Side-by-side install check (S-14) | `tests/contract/hermes/side_by_side.sh` |

Last run: 26 scenarios, 0 required failures, about 3 minutes.

---

## 1. Headline findings (read these first)

1. **The protocol works as documented.** identify → ticket → WS → `session.create` → `prompt.submit` →
   events → `message.complete` → `prompt.receipt`, replay, interrupt, compress, restart. Overhead
   without model time is small: **connect 3.7 ms p50, `prompt.submit` RTT 15 ms, `message.start`
   22 ms after submit, a trivial turn ends in 192 ms** (fake model, §4).
2. **`api_text` IS persisted and replayed** (as the user row's `api_content`) in every later turn. S-12
   default flips: send only a small per-turn delta in `api_text`, never the full dynamic block.
3. **The plugin's `pre_llm_call` hook output is appended to every user message**, truncated to
   head+tail (~1.2 kB kept, the full 15,334 chars saved under `<profile>/hook_outputs/<session>/`),
   and replayed with the history. W5 must disable the context hook in gateway mode: the guide belongs
   in the session system prompt (D6).
4. **`os.environ["HERMES_SESSION_ID"]` is process-global and wrong under concurrency.** In two parallel
   sessions, the tool in session A read session B's id from `os.environ`. `get_session_env()` was
   right. Never read `os.environ` for per-session data.
5. **`client_env` reaches plugins only through `bound_client_env()`** (S-18 passes). It is never in
   `os.environ`. Names starting with `HERMES_` (except the system prompt) and secret-looking names
   (`*_TOKEN`, `*_KEY`) are dropped even when listed in `terminal.client_env_passthrough`.
6. **One WebSocket = one serial RPC queue.** A `session.mutate compress` (3 s) blocked a
   `prompt.submit` on the same socket for 2.1 s; the same submit on a second socket took 7 ms. The
   bridge must run compress (and any long RPC) on its own connection.
7. **Hermes' venv is not where D17 says.** v0.22.4 installs it at
   `~/.hermes/installs/<install-id>/environments/<hash>/venv/bin/python` (Python 3.14.7,
   `websockets` 15.0.1). `~/.hermes/hermes-agent/venv` does not exist.
8. **`session.create` replay must be byte-identical.** Re-sending a `request_id` with any changed
   frozen field (`cwd`, a `client_env` value) is refused: `invalid_params`, "a resumed request_id must
   carry the same frozen request". The bridge must store the exact create params per generation.
9. **Restarts:** SIGTERM settles a running turn as `interrupted` at once (`agent.restart_drain_timeout`
   defaults to 0) and the queued admission **runs by itself** after the restart. SIGKILL leaves the
   turn `unknown`, emits no `message.complete` for it, and **pauses the FIFO** until
   `prompt.resolve_unknown`. The gateway exits with **rc 1 on SIGTERM**.
10. `show_reasoning` survives a detach/re-attach but is **lost on gateway restart** (reads back `"0"`).

---

## 2. Open questions from P§10 (Q1–Q10)

| Q | Answer | Evidence |
|---|---|---|
| Q1 `served_profiles` / `profile_id` | `[{"profile_id": "/home/hermes/.hermes/profiles/spike", "home": "/home/hermes/.hermes/profiles/spike"}]`. `profile_id` **is the absolute profile home**. Note `kind` is `"hermes-gateway"` (P§1.4 says `"gateway"`), plus `code_version`, `parked_profiles`. | identify snippet below |
| Q2 standalone start | Starts clean with no default gateway and with the default profile present (container image has `~/.hermes/config.yaml`). Prints a "STANDALONE: serves only its own profile" banner. A **default gateway started afterwards** comes up `ready`, serves only `/home/hermes/.hermes`, does not touch `spike`; restarting `spike` while it runs also works (1.86 s to ready). | scenario 01, 26 |
| Q3 `source='emperor'` rows | `session.resume` → `4001 not_found`. `session.mutate import` → `4001 invalid_params`. Fresh sessions it is. (Rows simulated by inserting into `state.db` with the v0.22.4 schema; a real v0.21.6 DB copy was not available here.) | scenario 17 |
| Q4 adopted `cli` rows | Adopted on `session.resume` (same id, `message_count` 2, `lazy: true`), policy = **profile defaults at adoption time** (`provider: custom`, `toolsets: null`, `cwd: $HOME`, model from the row). A turn on it completed and the model saw the old messages (4 messages). | scenario 17 |
| Q5 `HERMES_SESSION_ID` after compress | `get_session_env("HERMES_SESSION_ID")` = the **logical** id before and after compress. The stored id did not rotate in these runs (logical == stored after `compress`). `os.environ` is unreliable (finding 4). | scenarios 08, 11, 13 |
| Q6 `show_reasoning` | Kept across detach/re-attach on the same gateway (`"1"`), **lost on restart** (`"0"`). Values read back as `"0"`/`"1"`. | scenarios 06, 16 |
| Q7 approval without viewer | Not forever. `approval.request` carries `timeout_s` = `approvals.timeout` (default **300**, 20 in the harness). After the timeout the tool returns `status: blocked` ("Silence is not consent"), the turn ends `outcome: completed`, `prompts` is empty. | scenario 14 |
| Q8 `.env` re-read | **Partly.** Plugins never see `.env` edits without a restart (`os.environ` and `get_session_env` kept `dotenv-v1`). The model key (`model.key_env`) is re-read **when a session is created**: an existing session kept `sk-fake-boot`, a new session used `sk-fake-rotated`. At boot `.env` wins over the process env (`dotenv-v1` beat `from-process-env`). | scenario 15 |
| Q9 ticket scopes | `scope` ∈ `{profile, host}`; `host` only with `purpose: interactive` (`gateway/runtime_bootstrap.py:22,41`). A standalone gateway also mints `host` tickets. Unknown scope → `{"ok": false, "error": "PermissionError: bootstrap binding rejected"}`. Stale `instance_id` → `"PermissionError: stale runtime instance"`. | scenario 01 |
| Q10 cost fields | With a `custom` provider: `session.usage` has **no** `cost_usd`/`cost_status`; `prompt.receipt.result` has `cost_status: "unknown"`, `cost_source: "none"`, `estimated_cost_usd: 0.0`. DeepSeek/OpenRouter not measured (no real keys allowed). | scenario 05 |

```json
{"ok":true,"protocol":1,"id":1,"result":{"protocol":1,"kind":"hermes-gateway","pid":149,
 "hermes_home":"/home/hermes/.hermes/profiles/spike","profile":"spike","supervisor":"external",
 "launch_supervisor":"external","code_sha":"4d04303818b61bf3aa09278af48356315515965b","code_version":"0.22.4",
 "instance_id":"95bc730c…","runtime_protocol":1,"authority_epoch":1,"state":"ready",
 "api_origin":"http://127.0.0.1:55953",
 "served_profiles":[{"profile_id":"/home/hermes/.hermes/profiles/spike","home":"/home/hermes/.hermes/profiles/spike"}],
 "parked_profiles":{},"capabilities":["session-authority-v1","durable-admission-v1","event-replay-v1"]}}
```

---

## 3. Spikes S-1..S-20

Exit criterion (S-1, S-2, S-12, S-15, S-17, S-18, S-19): **all answered.**

| ID | Result | Design impact |
|---|---|---|
| **S-1** | `profile_id` = absolute profile home; the entry's `home` equals it (§2 Q1). | Default confirmed. |
| **S-2** | Standalone `spike` starts clean with and without a default gateway; the default gateway does not adopt or refuse it (§2 Q2). | `multiplex_profiles: false` in the default profile is **not needed** (keep it as belt and braces if you like). |
| S-3 | `emperor` rows: resume `not_found`, import `invalid_params` (simulated rows). | Default confirmed: fresh sessions + continuity seed. |
| S-4 | `cli` rows adopt with current profile defaults (§2 Q4). | Not used (S-3 = fresh). |
| S-5 | Logical id via `get_session_env`, stable across compress. | Default confirmed. |
| S-6 | Lost on restart. | Default confirmed (re-set on every attach). |
| S-7 | Times out after `approvals.timeout` (default 300 s), turn completes with the command blocked. `yolo:true` runs it with no approval events. | Default confirmed (`yolo:true`). |
| S-8 | Plugins: restart needed. Model key: new sessions only. | Default confirmed: restart on rotation. |
| S-9 | `profile`/`host`. | Default confirmed (omit `scope`). |
| S-10 | Not measurable here (no real keys). Custom provider: no cost on `session.usage`, `cost_status: unknown` in the receipt. | Default confirmed (`costCents` null). Re-check on the PC with DeepSeek. |
| S-11 | **x86_64 Docker:** 222–228 MiB RSS idle after start, **290–297 MiB after ~110 turns** (single process, no children). Pi/PC not measured (production hosts are out of scope). | Over the 250 MiB idle budget once warm. Measure on the Pi before placing agents there. |
| **S-12** | **Replayed.** Turn n+1's request contained turn n's `[EMPEROR TURN CONTEXT …]` (persisted as the user row's `api_content`; `content` stays the human `text`). Every user message in history was 1.26–1.33 kB because of finding 3. | Apply the S-12 fallback: `api_text` = small delta (sender, thread, message id). Move everything static into the session system prompt. |
| S-13 | `hermes_goal_adapter.py` `start`/`status`/`clear` work against a gateway-owned **logical** session (`local-…`). `evaluate` failed in the harness with `JSONDecodeError` raised while reading the payload from stdin (traceback in `probe-report.json`, cause not isolated). Without an existing session row `start` fails: "Hermes objective state was not persisted". | Keep the D18 fallback ready. W4 must re-test `evaluate` on the PC. |
| S-14 | `install.sh --skip-setup --branch v0.21.6 --dir ~/.hermes/hermes-agent-v0.21.6` next to the pinned v0.22.4 install works: separate checkout, separate `~/.hermes/installs/<id>/environments/<hash>/venv`, own launcher `<dir>/.hermes/bin/hermes`, and `~/.local/bin/hermes` was **not** repointed. Tested in the reverse direction of the fleet (v0.22.4 primary); state.db schema sharing between versions not tested. | Side-by-side is viable: point units at `<dir>/.hermes/bin/hermes` explicitly. |
| **S-15** | Image: `~/.hermes/installs/019d0d114d22b7e6/environments/9bfa6ab9d70f47128fa7810d042ae3b9/venv/bin/python`, **Python 3.14.7, websockets 15.0.1**. `~/.hermes/hermes-agent/venv` does not exist. The `hermes` launcher runs a separate interpreter `~/.hermes/tools/python-3.14.7+…/bin/python3 -I`. | **D17 replaced** (see §6). |
| S-16 | `finite:true, unattended:true` on a long-lived `tool` session: 3 turns all `completed` (135–290 ms), the dangerous command ran with **no** approval events, session stayed usable. | Works, but D11 (`yolo:true`) is simpler and equivalent. Keep D11. |
| **S-17** | `compress {partial:true, keep_last:6}` with a 3 s summary call: **3.14 s**. A `prompt.submit` sent during the compress to the same session **queues** (`status: queued`) and completes after it (3.3 s from compress start). A compress while a turn runs → `4001 session_busy`. `expected_generation` is required. Duration at 60k real context not measurable with the fake (it is the summary model call). | Default confirmed, plus: compress on its own WS (finding 6), only when the session is idle, retry on `session_busy`. |
| **S-18** | `bound_client_env()` inside a plugin tool returned `EMPEROR_THREAD_ID`, `EMPEROR_THREAD_TYPE`, `EMPEROR_SESSION_GEN`, `EMPEROR_CLAW_TURN_THREAD_ID`, `HERMES_EPHEMERAL_SYSTEM_PROMPT`. Dropped: `EMPEROR_CLAW_API_TOKEN`, `OPENAI_API_KEY` (secret-like), `HERMES_PROBE_PREFIXED` (`HERMES_` prefix), `EMPEROR_PROBE_UNLISTED` (not in passthrough). Not in `os.environ`. Tool subprocesses get them through `toolchain_environ()`. Survives a gateway restart. Correct per session under concurrency. | **D7 confirmed.** The `by-session/<sessionId>.json` fallback is not needed; if used, key it by `get_session_env("HERMES_SESSION_ID")`, never `os.environ`. |
| **S-19** | `register(ctx)`, `ctx.register_tool(...)`, `ctx.register_skill(...)`, `pre_llm_call` hook and `plugin.yaml` keys load unchanged: all 28 `emperor_*` tools were offered to the model (52 tools total with `tools.tool_search.enabled: off`) and `emperor_health` ran end to end (bearer from the gateway process env). | No API diff. Behaviour diff: hook output goes into the user message (finding 3). |
| **S-20** | Recorded: normal, reasoning, three-tool, interrupt while streaming, interrupt while the provider hangs, provider drop mid-stream, compress (with a submit during it), reconnect replay, gateway SIGKILL mid-turn (`unknown`). | §5. |

---

## 4. Measured latencies (fake model, no model time)

Docker Desktop on Windows, x86_64, 10 samples each, milliseconds.

| Step | p50 | p90 | max |
|---|---|---|---|
| `identify` over `gateway.sock` | 1.4 | 1.7 | 1.7 |
| `session-ticket` | 0.6 | 0.9 | 0.9 |
| WS open (upgrade) | 1.1 | 1.6 | 2.0 |
| WS open → `gateway.ready` | 1.8 | 2.3 | 2.6 |
| **Total connect** (identify → ready) | **3.7** | 4.5 | 4.6 |
| `gateway.ping` RTT | 0.2 | 0.3 | 0.3 |
| `session.create` RTT | 23–526 (*) | 28–527 | 222–751 |
| `prompt.submit` RTT | 14.7 | 16.5 | 16.6 |
| submit → first event (`session.info`) | 3.0 | 8.1 | 14.7 |
| submit → `message.start` | 22.2 | 29.0 | 43.4 |
| submit → first `message.delta` | 82.6 | 92.9 | 900 (first turn) |
| **submit → `message.complete`** (trivial turn) | **192** | 201 | 1043 (first turn) |
| `session.interrupt` → `message.complete` (streaming) | 210 | | |
| `session.interrupt` → `message.complete` (provider hung) | 367 | | |
| `session.events.since` RTT | 1.4 | | |
| compress, 48 → 12 messages, fake summary | 154–169 | | |
| gateway cold start → `ready` | 3.8–4.2 s | | |
| gateway restart (SIGTERM / SIGKILL) → `ready` | 1.6–1.8 s | | |

(*) `session.create` was 17–28 ms p50 in four runs and 526 ms p50 in one run with identical code;
not explained yet. Create once per thread and cache, so it is off the hot path either way.

Turn time includes the agent loop with ~50 tool schemas and a 15 kB pre-LLM hook; the fake answers
in < 5 ms. **Gateway overhead per turn is about 0.2 s**, versus 9–10 s cold start today (R§0).

---

## 5. Fixtures (`tests/fixtures/hermes-v0224/`)

One JSON object per line: `{"dir":"out"|"in"|"meta","t_ms":…,"frame":{…}}`. `meta` lines mark
connect, disconnect and kill. Event order per file (from the recording):

| File | Sequence (abridged) |
|---|---|
| `normal_turn.jsonl` | create, `config.set`, submit → `session.info`, `message.start`, `agent.step`, `thinking.delta`, `message.delta`×6, `reasoning.available`, `session.usage`, `session.info`×2, `message.complete` → receipt |
| `reasoning_turn.jsonl` | … `reasoning.delta`×5, `message.delta`×2, `reasoning.available` … |
| `tool_turn_three_tools.jsonl` | 3× (`tool.generating`, `message.delta`, `tool.start`, `tool.complete`, `agent.step`, `session.usage`), then text, `message.complete` |
| `interrupted_turn_streaming.jsonl` | `message.delta` → `session.interrupt` → `agent.print`, `session.usage`, `message.complete{outcome:"cancelled",status:"interrupted"}` |
| `interrupted_turn_hang.jsonl` | `message.start` → (model hangs) → interrupt → `message.complete` in 367 ms |
| `provider_drop_mid_stream.jsonl` | partial `message.delta` → `agent.print` → Hermes retries with a continuation → `completed` |
| `compress.jsonl` | 4 turns, `session.mutate compress` ‖ a second connection's submit ‖ a submit on this connection (answered only after the compress), `sessions.changed`, `session.updated` |
| `reconnect_replay.jsonl` | 3 deltas, disconnect, new ticket, `session.resume`, `session.events.since` (34 events from `last_seq+1`, includes `message.complete`), receipt |
| `gateway_kill9_mid_turn.jsonl` | tool ran, model hangs, SIGKILL, restart, resume (`pending[0].status:"unknown"`, queued item still `queued`), receipt `unknown`, `resolve_unknown` → `interrupted`, queued turn then runs |

Shapes worth knowing:

```json
{"type":"message.start","admission_id":"ec10dd88…","execution_generation":1,"authority_epoch":2,
 "session_id":"local-162dd…","payload":{},"replay_epoch":"a3f3…","seq":2}
{"type":"tool.complete","payload":{"tool_id":"call_fake_1","name":"read_file","context":"hostname",
 "tool_call_id":"call_fake_1","tool_name":"read_file","args":{"path":"/etc/hostname"},"is_error":false,
 "result":"{\"content\": \"1|836e3e3fbb29\", …}","duration_s":0.0668,"inline_diff":null}}
```

Global events not listed in P§4 appear on every socket: `sessions.changed`, `platforms.changed`,
`session.updated`. Ignore unknown types.

---

## 6. Design defaults D1–D20

| D | Verdict | Notes / replacement |
|---|---|---|
| D1 Transport WS only | **Confirmed** | The gateway passes every check. For the record, `hermes -p X chat -Q --format stream-json --source tool -q …` still works on v0.22.4 (rc 0, 0.84 s, attaches to the already running gateway, same pid); `--resume <id>` rc 0; `--source emperor` rc 1 "Gateway does not support source 'emperor'"; unknown resume id rc 1. Deleting the CLI path loses nothing. |
| D2 Standalone per profile | **Confirmed** | Strengthened by finding 4 (`os.environ` is shared across sessions in one process). RSS: see S-11. |
| D3 Process layout | **Confirmed, with two settings** | (a) The gateway exits **rc 1 on SIGTERM**: use `Restart=always` (not `on-failure`) and do not alert on rc 1 after a stop. (b) `agent.restart_drain_timeout` defaults to **0** (interrupt at once). Set it (e.g. 45) below `TimeoutStopSec=60` if restarts should let turns finish (not tested here). With `--external-supervisor` the log claims `under_systemd=yes`; harmless. |
| D4 Session mapping | **Confirmed, refined** | `request_id` with slashes works (`emperor/probe-agent/fx-normal/g1-…`) and is idempotent across restarts. **Replay must carry identical frozen params** (finding 8): store the exact create params with the generation, and make `policyHash` cover all of them, `client_env` included. |
| D5 Turn idempotency | **Confirmed** | Exact resubmit → same `admission_id`; same `submission_id` with different text → `4001 admission_conflict`. |
| D6 Context placement | **Replaced in part** | System prompt via `client_env.HERMES_EPHEMERAL_SYSTEM_PROMPT` reaches the model (appended after Hermes' own system prompt). `text` is what the transcript shows. But `api_text` is persisted (`api_content`) and **replayed** (S-12), so `api_text` = a small per-turn delta only. Also remove the plugin's `pre_llm_call` context (finding 3). Gotcha: on Docker Desktop, Hermes' system prompt says "You are running inside WSL". |
| D7 Plugin turn context | **Confirmed** | S-18. Read `bound_client_env()`; never `os.environ` for session data. |
| D8 Credentials | **Confirmed** | `.env` wins over the process env at boot; plugin env frozen until restart; model `key_env` re-read only for new sessions. Restart on rotation. |
| D9 Concurrency | **Confirmed, plus one rule** | Two sessions ran concurrently (two 3 s turns in 3.3 s). Hermes queues a busy submit (`queued`), FIFO order kept, `prompt.cancel` on a queued row works and emits an empty `message.complete{outcome:"cancelled"}`. New rule: **RPCs on one WS are serial**, so long RPCs (compress) get their own connection. |
| D10 Interrupt | **Confirmed** | Take `execution_generation` from `message.start`. Stale generation → `4001 stale_generation`. Outcome names differ: `message.complete` says `outcome:"cancelled", status:"interrupted"`; the receipt says `outcome:"interrupted"`. Treat both as cancelled. |
| D11 Approvals | **Confirmed** | `yolo:true` → no `approval.*` events, command runs. Without it and with no viewer the turn still finishes after `approvals.timeout` (S-7). No `clarify` was exercised. |
| D12 Reasoning | **Confirmed** | `config.set show_reasoning on` → `reasoning.delta` + `reasoning.available`; `message.complete.reasoning` holds the full text. Re-set after every restart (S-6). |
| D13 Compaction | **Confirmed, refined** | S-17. Add: own connection, only when idle (`session_busy` otherwise), send `expected_generation`. A submit during compress queues, so holding the thread queue is optional, not required. |
| D14 Reconnect / replay | **Confirmed** | Gapless replay from `last_sequence+1`, includes `message.complete`. Old or wrong `replay_epoch` → `snapshot_required:true, truncated:true, count:0`. Events can arrive before the RPC answer that caused them (seen for `session.info` before the submit result): buffer by `admission_id`. |
| D15 Restart-lost turns | **Confirmed, refined** | SIGTERM: running turn → `terminal/interrupted` (`turn_exit_reason: interrupted_during_api_call(gateway_shutdown)`), **queued admissions then run on their own after restart**. SIGKILL: `unknown`, no `message.complete`, FIFO paused until `prompt.resolve_unknown` (→ `interrupted`), then the queue drains. So: on reconnect, poll `prompt.receipt` for every admission you were waiting on; whether a `tool.start` was seen must come from the bridge's own event log (the replay ring is gone after a restart). |
| D16 Usage / cost | **Replaced in part** | `prompt.receipt.usage` has only `{input_tokens, output_tokens, total_tokens}`. Cache, reasoning, `api_calls`, `model`, `provider`, `cost_status`, `estimated_cost_usd`, `turn_exit_reason` are in **`prompt.receipt.result`**. Read the ledger fields from `result`. `context_used` for D13 is in `session.usage.usage.context_used`. Cost: S-10. |
| D17 Bridge runtime | **Replaced** | Path: discover the venv as `~/.hermes/installs/*/environments/*/venv/bin/python` (one per install; with side-by-side installs there are two, so pick the one whose `hermes_cli` import resolves inside the target checkout, or take an explicit `HERMES_PYTHON`). Python is **3.14.7**, `websockets` **15.0.1** (≥ 13 holds). For `hermes_cli` imports (goal adapter) set `PYTHONPATH=<checkout>` and `cwd=<checkout>`. |
| D18 Objectives | **Open** | S-13: start/status/clear work, `evaluate` unverified. Keep the hidden-turn fallback ready. |
| D19 One runtime per agent | Not a Hermes question | Not exercised. |
| D20 Versioning | Not a Hermes question | Pin check that works: `identify.result.code_sha` / `code_version` (`"0.22.4"`), no git needed. |

---

## 7. Gotchas

- `identify.kind` is `"hermes-gateway"`, not `"gateway"`.
- Every WS refusal tested (no ticket, forged, reused, expired after 31 s, `Origin` header) is an
  **HTTP 403 on the upgrade**, not a 4403 close code.
- `ping` (RPC) took 28 ms once while a session was busy; `gateway.ping` (bypasses the queue) stayed
  at 0.2–0.4 ms. Use `gateway.ping` for liveness.
- Unknown params are refused before the handler: `4001 invalid_params` with `data.fields: ["bogus"]`.
- `tool`-source sessions appear in neither `session.list scope:live` nor `scope:stored`
  (even with `include_hidden`).
- `config.set`/`config.get` return `{"key","value","scope":"session"}`, values `"0"`/`"1"`.
- With the fake model the "final text" contains the hook output echo; that is the fake echoing the
  user message, not a Hermes bug.
- `tools.tool_search.enabled: off` is required for plugin tools to be offered directly (otherwise
  the model only sees `tool_search/tool_describe/tool_call`).
- The `custom` provider ignores `OPENAI_API_KEY`; it sends `Bearer no-key-required` unless
  `model.key_env` (or an explicit key) is set.
- `DropMidStream` is recovered by Hermes itself (continuation call), so a provider cut does not fail
  the turn.

---

## 8. Recommended minimal client flow (bridge 0.9)

```text
start:   identify (gateway.sock) → require state=ready, runtime_protocol=1, session-authority-v1,
         code_version=="0.22.4"; profile_id = served_profiles[home==profile_home].profile_id
connect: session-ticket {profile_id, instance_id, purpose:"interactive"} → WS {api_origin}/api/ws,
         subprotocols ["hermes-gateway-v1", "hermes-gateway-ticket.<t>"], no Origin, proxy=None,
         max_size 8 MiB → wait gateway.ready.  Open TWO sockets: "turns" and "maintenance" (compress).
thread:  session.create {request_id:"emperor/<agent>/<thread>/g<gen>", source:"tool", yolo:true,
         cwd, client_env:{HERMES_EPHEMERAL_SYSTEM_PROMPT, EMPEROR_THREAD_ID, EMPEROR_THREAD_TYPE,
         EMPEROR_SESSION_GEN}}  (store these exact params; replay them verbatim)
         config.set {session_id, key:"show_reasoning", value:"on"}   (after every create/resume/restart)
turn:    write turn file → prompt.submit {session_id, submission_id:"emp-<msgId>", text:<human>,
         api_text:<small delta + human>, turn_author}
         events: message.start (keep execution_generation) … tool.* / reasoning.delta / session.usage …
         done = message.complete with payload.admission_id == receipt.admission_id
         prompt.receipt {include_result:true} → ledger fields from result
stop:    session.interrupt {session_id, execution_generation}
compress (maintenance socket, session idle, context_used ≥ threshold):
         session.mutate {session_id, request_id, expected_revision, expected_generation,
         operation:"compress", payload:{partial:true, keep_last:6}}  (timeout 660 s; retry on session_busy)
reconnect: identify; if instance_id changed → restart path; else ticket → WS → session.resume →
         session.events.since {last_sequence, replay_epoch}; if snapshot_required → prompt.receipt per
         waiting admission. Restart path: resume, re-set show_reasoning, receipt for waiting admissions,
         prompt.resolve_unknown for status "unknown".
```

---

## 9. Exact commands that worked

```bash
# install, pinned (image build)
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v0.22.4/scripts/install.sh \
  | bash -s -- --skip-setup --skip-browser --skip-computer-use --branch v0.22.4
git -C ~/.hermes/hermes-agent rev-parse HEAD   # 4d04303818b61bf3aa09278af48356315515965b

# profile + gateway
hermes profile create spike
hermes -p spike config set gateway.standalone true          # plus unmanaged_idle_exit_seconds 0
hermes -p spike plugins enable emperor-claw
hermes -p spike gateway run --external-supervisor           # long-running, never idle-exits

# side-by-side second checkout
bash install.sh --skip-setup --skip-browser --branch v0.21.6 --dir ~/.hermes/hermes-agent-v0.21.6
~/.hermes/hermes-agent-v0.21.6/.hermes/bin/hermes --version   # v0.21.6; ~/.local/bin/hermes untouched

# CLI (still works on v0.22.4, for reference only)
hermes -p spike chat -Q --format stream-json --source tool --toolsets emperor-claw -q "hello"
hermes -p spike chat --resume <local-…> -Q --format stream-json --source tool -q "again"
```

## 10. Not covered

Real providers (S-10 cost, real compress duration at 60k tokens), the Pi and the PC (S-11, S-14 in
the fleet direction), `clarify` auto-answers, `session.steer`, `HERMES_TEST_ISOLATION=1` runs, and
the cause of the S-13 `evaluate` failure.
