# Hermes server protocol contract (persistent gateway + streaming client)

Status: extracted from source, not yet exercised against a live gateway.
Target: Hermes **v0.22.4** (tag commit `4d04303818b61bf3aa09278af48356315515965b`, 2026-10-21).
Baseline: **v0.21.6** (`818c13be1d`, currently on the Pi). The PC (`ecf9655b5a`, a main-branch
commit after v0.21.4) also predates the protocol described here.

All citations are `path:line` at tag `v0.22.4` unless marked `@v0.21.6`. "Inferred" marks
statements read from code paths but not confirmed by a test or a doc.

---

## 0. Summary of decisions this contract enables

| Question | Answer at v0.22.4 |
|---|---|
| Server process | `hermes -p <profile> gateway run` (the messaging gateway owns the session authority). No `--idle-exit` means it never idle-exits. |
| Listener | HTTP/WS on **127.0.0.1, ephemeral port** (no config knob). Discovered only through the profile's **UNIX control socket** `<profile_home>/gateway.sock`. |
| Auth | Single-use **session ticket** (30 s TTL) minted over the control socket. The peer must be the **same UID**. The WS must come from loopback with **no `Origin` header**. |
| Wire | WebSocket, subprotocol `hermes-gateway-v1`, JSON-RPC 2.0, one JSON object per text frame. Server pushes `{"method":"event"}` notifications. |
| Session model | Durable, server-owned FIFO per session (`prompt.submit` = durable admission, not completion). Several sessions run concurrently in one process. Max 32 queued per session. |
| Turn end | `event` `message.complete` whose payload carries `admission_id` + `outcome`. Use `prompt.receipt {include_result:true}` for the authoritative committed result and usage. |
| Orchestrator source | `source: "tool"` (third-party integration; maps to agent platform `cli`; hidden from human pickers). **`--source emperor` (what the bridge uses today) is rejected by v0.22.4.** |
| Per-session system prompt | `session.create.client_env.HERMES_EPHEMERAL_SYSTEM_PROMPT` (frozen per session). |
| Per-turn context | `prompt.submit.api_text` (model-facing text, max 1,000,000 chars) next to the persisted `text`; `turn_author` for attribution. |
| Plugin knows the turn | `gateway.session_context.get_session_env("HERMES_SESSION_ID")` inside the turn gives the session id. Mapping session to Emperor thread (and the running admission to the Emperor message) stays in the bridge. |

---

## 1. Starting the server for one profile

### 1.1 Command

```
hermes -p <profile> gateway run [--replace] [-v|-vv|-q] [--external-supervisor] [--force]
```

Flags (`hermes_cli/subcommands/gateway.py:69-117`):

- `--replace`: replace an existing instance on this home (for systemd).
- `--force`: start even if a service manager already supervises this profile, and the escape hatch for
  the named-profile refusal (§1.3).
- `--no-supervise`: only matters inside the official s6-overlay image (`:99`). Emperor's
  `python:3.11-slim` image is not s6, so it does not apply.
- `--external-supervisor`: declares a foreign process manager (use under Docker) (`:110`).
- `--idle-exit` is internal (`:117`). Only client auto-starts pass it. **Never pass it.**

Idle exit (`gateway/run_idle_exit.py:1-19, 32, 41`): `gateway.unmanaged_idle_exit_seconds`
(default 600, `0` disables) is armed **only** for a gateway started with `--idle-exit` and no
supervisor. A hand-started or systemd gateway never arms it. Belt and braces: set
`gateway.unmanaged_idle_exit_seconds: 0` in the profile config anyway.

Supervisor detection (`gateway/control_socket.py:130-146`): `INVOCATION_ID` in the environment means
`systemd`, `--external-supervisor` means `external`, otherwise `manual`.

### 1.2 What it starts

- PID/lock claim, then the **control socket** (`gateway/run_bootstrap.py:270-300`). If the control
  socket fails to bind, startup aborts, because it mints every local attach ticket.
- The session authority, then the **HTTP/WS listener** `start_gateway_api(runner, host="127.0.0.1",
  port=0)` (`gateway/run_api.py:138`, called with defaults from `gateway/run_runtime.py:497-499`). No
  config sets the host or port. The bound origin is published as `api_origin`
  (`gateway/run_api.py:200-203`).
- Anything else the profile configures: messaging adapters, cron, kanban dispatcher.

### 1.3 Named profiles vs the multiplexer (important for "one server per profile")

v0.22.4 defaults to **one host gateway serving every profile** (`gateway.multiplex_profiles`, default
`true`, `hermes_cli/config_defaults.py:2184`). A named profile (`~/.hermes/profiles/<name>`) is
**refused** its own gateway (`hermes_cli/gateway.py:4194-4240`
`_named_profile_refused_under_multiplexer`) unless one of these holds:

- that profile's `config.yaml` sets `gateway.standalone: true` (`hermes_cli/profiles.py:1065`), or
- `--force` is passed.

Two deployment shapes are possible:

| Shape | Start | Client ticket |
|---|---|---|
| **A. Standalone per profile (recommended, matches one runtime per agent)** | `hermes -p X config set gateway.standalone true`, then `hermes -p X gateway run --replace` | control socket at `~/.hermes/profiles/X/gateway.sock` |
| B. One multiplexer for all profiles | `hermes gateway run` (default profile) | the default home's control socket mints a ticket bound to X (`hermes_cli/gateway_client.py:225-233` via `control_home_for`) |

Caveat for shape A: if a default multiplexer is also running and still lists X, the standalone start
is refused with a "rescan" message. Do not run a default gateway on the same home root, or make sure
it has rescanned.

systemd unit sketch (shape A):

```ini
[Service]
User=jose
ExecStart=/home/jose/.local/bin/hermes -p viktor gateway run --replace
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=60
```

Docker (one container = one profile): run the gateway as the container's long-running process (or
under the bridge's supervisor) as UID `hermes`, with `--external-supervisor`, and run the bridge **in
the same container** (§1.5).

### 1.4 Discovery and readiness

Control socket (`gateway/control_socket.py:1-8, 111-127`):
`<HERMES_HOME>/gateway.sock`. If that path is too long for `sun_path` (more than 100 bytes), the socket
lives at `$XDG_RUNTIME_DIR|$TMPDIR|/tmp/hermes-gw-<sha256(home)[:16]>/control.sock`, and
`<HERMES_HOME>/gateway.sock.path` holds that path. The wire is one JSON line in and one JSON line out,
then the server closes. Never a TCP port.

Client-side checks (`hermes_cli/gateway_runtime_discovery.py:77-171`): the home is not writable by
others, the socket is mode 0600 and owned by our UID, and the peer UID (`SO_PEERCRED`) equals ours.

`identify` request:

```json
{"protocol":1,"verb":"identify","id":1}
```

Response (shape from `gateway/control_socket.py:171-186` + `gateway/run_bootstrap.py:293-308`;
validated by `hermes_cli/gateway_runtime.py:98-152`):

```json
{"ok":true,"protocol":1,"id":1,"result":{
  "protocol":1,"kind":"gateway","pid":12345,"start_time":1792600000.1,
  "hermes_home":"/home/jose/.hermes/profiles/viktor","profile":"viktor",
  "supervisor":"systemd","launch_supervisor":"systemd","code_sha":"4d04303818b6…",
  "instance_id":"5f0c…","runtime_protocol":1,"authority_epoch":3,"state":"ready",
  "api_origin":"http://127.0.0.1:43817",
  "served_profiles":[{"home":"/home/jose/.hermes/profiles/viktor","profile_id":"/home/jose/.hermes/profiles/viktor"}],
  "capabilities":["session-authority-v1", "…"]}}
```

**Ready** means `state == "ready"`, `runtime_protocol == 1`, `"session-authority-v1" in
capabilities`, an `authority_epoch` above 0, and a loopback `api_origin` with a port. `state` can also
be `starting`, `draining` (with `drain_reason`, for example `idle_exit` or the restart wait), or
`conflict`. Shape of `served_profiles` entries: inferred from the `_endpoint` validation. The
`profile_id` you use later is `served_profiles[i].profile_id` for the entry whose `home` equals the
profile home.

Health check: a connectable socket with a well-formed `identify` IS liveness
(`control_socket.py:2-3`). Inside an open WS, also use `ping` (RPC) or the `gateway.ping` heartbeat
(§2.4). Do **not** use `hermes gateway ensure` for health: it starts a gateway if none runs.

### 1.5 Authentication: the session ticket

`session-ticket` request over the same control socket (`hermes_cli/gateway_client.py:225-259`,
server `gateway/control_socket.py:347-373`):

```json
{"protocol":1,"id":1,"verb":"session-ticket","params":{
  "profile_id":"/home/jose/.hermes/profiles/viktor",
  "instance_id":"5f0c…","purpose":"interactive"}}
```

```json
{"ok":true,"protocol":1,"id":1,"result":{"ticket":"<opaque>","expires_in_seconds":30,
  "instance_id":"5f0c…","profile_id":"/home/jose/.hermes/profiles/viktor","runtime_protocol":1}}
```

- Allowed params: `profile_id`, `instance_id`, `purpose` (required), `scope`, `subject`. `subject` must
  be a structured login subject. Omit it, and the principal becomes `uid:<peer uid>`
  (`control_socket.py:375-389`).
- The peer must be the gateway's own UID (`SO_PEERCRED`). That rule IS the auth boundary.
- Tickets are **single-use** and live 30 s. Mint a fresh one for every WS (re)connect.
- `instance_id` must match the live instance. On mismatch the response is "stale runtime instance":
  re-`identify`.

Consequence for Emperor: **the bridge must run on the same host (or container), as the same UID,
with access to the profile home**. No remote attach exists without the dashboard auth stack.

---

## 2. Transport framing

### 2.1 Upgrade

```
GET {api_origin→ws}/api/ws
Sec-WebSocket-Protocol: hermes-gateway-v1, hermes-gateway-ticket.<ticket>
(no Origin header)
```

(`hermes_cli/gateway_client.py:37-43`, `gateway/run_api.py:246-375`)

- The server accepts with subprotocol `hermes-gateway-v1` (`gateway/session_contract.py:9`). The
  client must check `ws.subprotocol == "hermes-gateway-v1"`.
- Refusals: close code **4403** for a bad or absent ticket, an `Origin` header, or a non-loopback peer
  (`run_api.py:333-337, 361-363`). **1013** for not ready or draining (`run_api.py:291-297`).
- The reference client uses `max_size = 8 MiB`, `open_timeout = 10`, and `proxy=None`
  (`gateway_client.py:303-305`). Do not route through `HTTP(S)_PROXY`.
- Ticket redemption grants capabilities `session:read|submit|control|approve|respond|create` and
  operator scope (`gateway/session_controls.py:113-140`).

### 2.2 Frames

JSON-RPC 2.0, one JSON object per WS text frame (`tui_gateway/ws.py:555-590`).

Request and response:

```json
{"jsonrpc":"2.0","id":7,"method":"prompt.submit","params":{"session_id":"local-…","submission_id":"emp-msg-123","text":"hi"}}
{"jsonrpc":"2.0","id":7,"result":{"admission_id":"9a1f…","ref":{"profile_id":"/home/…/viktor","session_id":"local-…"},"sequence":4,"status":"queued","outcome":null,"authority_epoch":3,"execution_generation":null}}
```

Error (`gateway/session_controls.py:235-330`):

```json
{"jsonrpc":"2.0","id":7,"error":{"code":4001,"message":"queue_full","data":{"reason":"queue_full"}}}
```

| code | meaning |
|---|---|
| 4001 | domain refusal; `message` = `data.reason` (`invalid_params` + `data.fields`, `permission_denied`, `not_found`, `stale_generation`, `revision_conflict`, `queue_full`, `admission_conflict`, `runtime_draining`, `profile_mismatch`, `session_busy`, `unknown_execution`, …) |
| 5001 | `storage_unavailable` (SQLite) |
| -32601 | unknown method |
| -32603 | handler crash |
| -32700 | parse error |

Unknown or missing param keys are refused **before** the handler runs (closed contracts,
`session_controls.py:275-280`). Send only the documented keys.

Server event (notification) (`gateway/session_events.py:38-54`, stamp from
`gateway/session_authority.py:1080-1093`):

```json
{"jsonrpc":"2.0","method":"event","params":{
  "authority_epoch":3,"execution_generation":7,"admission_id":"9a1f…",
  "type":"message.delta","session_id":"local-…","payload":{"text":"Hel"},
  "replay_epoch":"c0ffee…","seq":42}}
```

- `seq` increases monotonically per session within one `replay_epoch`.
- `execution_generation` and `admission_id` are present only while an admission is claimed. Idle
  events carry `{}` for the execution stamp.
- A `session_id`-less event is global (for example `gateway.ready`, `skin.changed`).

Server→client **requests** (sudo, secret, batched clarify, desktop UI bridges): `{"jsonrpc":"2.0",
"id":"srq-<n>","method":"sudo"|"secret"|…,"params":{…}}`. Answer with a plain response frame
`{"jsonrpc":"2.0","id":"srq-<n>","result":{…}}`. They time out after 120 s
(`gateway/session_server_requests.py:1-20, 67-70`). A headless orchestrator can ignore them: they time
out or get `request.cancel`.

### 2.3 Connection start

The first frame after accept (`tui_gateway/ws.py:530-537`):

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{
  "skin":{…},"change_events":true,"heartbeat":true,"replay_epoch":"…","session_authority":true}}}
```

Then call `runtime.describe` (§3.1) and check `session_create.sources` / `parameters` before using an
option.

### 2.4 Keepalive and backpressure

- `{"jsonrpc":"2.0","id":N,"method":"gateway.ping"}` gets `{"result":{"ok":true}}` directly, bypassing
  the queue (`ws.py:583-587`).
- The server send deadline is 30 s per frame (`ws.py:92`). If the client stops reading, its
  subscription overflows and is retired with a synthetic `session.replay_gap` event
  (`session_events.py:56-63`). The client must then `session.resume` again.
- The server dispatches requests serially per connection (`ws.py` `_dispatch_loop`). The dispatch
  queue holds 256 frames.

---

## 3. Methods

All methods below are on the authenticated `hermes-gateway-v1` socket. Contracts live in
`tui_gateway/contracts/canonical.py` and `canonical_sessions.py`. Handlers live in
`gateway/session_controls.py:170-215` (table) plus sibling modules.

### 3.1 `runtime.describe {}` / `ping {}`

`session_controls.py:485-503`.

```json
{"instance_id":"5f0c…","profile_id":"/home/…/viktor","authority_epoch":3,
 "capabilities":["durable-admission-v1","event-replay-v1","local-cli-create-v1","acp-editor-policy-v1","acp-session-mcp-v1"],
 "session_create":{"sources":["acp","cli","gui","oneshot","tool","tui"],
                   "parameters":["accept_hooks","api_key","base_url","checkpoints","client_env","cwd","cwd_explicit","editor","follow_profile_config","ignore_rules","ignore_user_config","max_turns","model","pass_session_id","provider","reasoning","request_id","row_cwd","run_budget","safe_mode","service_tier","skills","source","title","toolsets","verbose","yolo"]},
 "skin":{…}}
```

`ping {}` returns `{"pong":true}`.

### 3.2 `session.create`

Params (`canonical_sessions.py:21-55`, `CREATE_FIELDS` at `gateway/session_policy.py:15-18`):

| field | notes |
|---|---|
| `request_id` | **Idempotency key.** The session id is derived from (profile, principal, request_id) (`session_controls.py:447-452`). Repeating it returns the same session, including after a daemon restart. A conflicting repeat returns `invalid_params`. Use a deterministic id such as `emperor-thread-<threadId>`. |
| `source` | `cli` (default) \| `tui` \| `gui` \| `acp` \| `tool` \| `oneshot` (`session_policy.py:78`: `tool` and `oneshot` map to agent platform `cli`). **Use `tool`**: third-party integration, hidden from human pickers, no coding-posture toolset auto-add, and unattended turns stay allowed (CLI platform). |
| `cwd` | existing absolute directory on the gateway host. Frozen. |
| `model`, `provider`, `base_url`, `api_key`, `reasoning`, `service_tier` | frozen launch route. `api_key` is held in memory only, never persisted. After a gateway restart it must be re-sent via `session.resume.api_key`. |
| `toolsets` | explicit list (empty is allowed). Unknown names are **refused**, not dropped. |
| `skills` | list, rendered once into the frozen prompt. |
| `max_turns`, `run_budget` (seconds per run), `yolo` (auto-approve), `checkpoints`, `accept_hooks`, `pass_session_id`, `ignore_rules`, `safe_mode`, `ignore_user_config`, `verbose` | launch policy |
| `follow_profile_config` | `true`: each turn re-reads `model`/`providers`/`fallback_*`/`model_aliases`/`platform_toolsets` from the profile's **current** config (`session_policy.py:19-22`). Useful when Emperor edits an agent's model. |
| `client_env` | `{NAME: value}`, filtered by `agent/session_client_env.py:23-69`. Kept: `HERMES_EPHEMERAL_SYSTEM_PROMPT`, `HERMES_INFERENCE_PROVIDER`, host-only `HERMES_PREFILL_MESSAGES_FILE` / `HERMES_ENABLE_PROJECT_PLUGINS`, toolchain names (`PATH`, `VIRTUAL_ENV`, `CONDA_*`, …), plus any non-secret, non-`HERMES_` names listed in the profile's `terminal.client_env_passthrough`. Secrets are filtered out. Frozen per session. |
| `title`, `hidden` | `title` resolves an existing session or creates one with that title. |
| `row_cwd`, `cwd_explicit`, `editor` | CLI/ACP specifics; not needed. |

Result: the same snapshot as `session.resume` (§3.3). `create` attaches the caller automatically
(`session_controls.py:483`).

```json
{"jsonrpc":"2.0","id":2,"method":"session.create","params":{
  "request_id":"emperor-thread-8f2c","source":"tool","cwd":"/home/jose/work/viktor",
  "toolsets":["emperor-claw","web","terminal"],"follow_profile_config":true,
  "client_env":{"HERMES_EPHEMERAL_SYSTEM_PROMPT":"You are Viktor, an Emperor Claw agent…"}}}
```

### 3.3 `session.resume` (attach)

Params (`canonical_sessions.py:58-74`): `session_id` | `title` | `latest` (`cli`\|`tui`) + `workspace`,
`api_key`, `defer_history`, `omit_messages`, `display_projection`, `cols`, `source`, `editor`.

Result (`canonical_sessions.py:137-157`, built at `session_controls.py:559-639`):

```json
{"session_id":"local-…","stored_session_id":"local-…","messages":[…],"message_count":12,
 "running":false,"authority_epoch":3,"replay_epoch":"c0ffee…","last_sequence":41,
 "subscription_id":"sub-…","revision":17,"execution_generation":7,
 "pending":[{"admission_id":"…","ref":{…},"sequence":5,"status":"queued","outcome":null,
             "authority_epoch":3,"execution_generation":null,"input_id":"…","text":"…","controls":["steer","replace"]}],
 "prompts":[{"kind":"approval","prompt_id":"…","execution_generation":7,"choices":["once","deny","session","always"],"command":"rm -rf build","description":"…","timeout_s":300}],
 "info":{"desktop_protocol":"hermes-gateway-v1","source":"tool","model":"…","profile_id":"…","cwd":"…",…},
 "pending_connection":null,"todo_state":null}
```

- **You must be attached** (`session.create` or `session.resume` on this connection) before
  `prompt.submit`. Otherwise you get `permission_denied` (`session_controls.py:749-750`).
- Closing the socket detaches but **never** stops the execution (`gateway_client.py:1`).
  `session.detach {session_id, subscription_id, end_reason?}` detaches explicitly
  (`session_controls.py:655-677`).

### 3.4 `prompt.submit`

Params (`canonical_sessions.py:205-230`; allowed set enforced at `session_controls.py:747-765`):

| field | notes |
|---|---|
| `session_id`, `text` | required. `text` is what is persisted as the user row. |
| `submission_id` (or `input_id`) | **required** idempotency key per admission. An exact retry returns the same receipt. Different content under the same key returns `admission_conflict` (`hermes_state_runtime.py:150-152`). Use the Emperor message id. |
| `api_text` | model-facing text when it differs from `text` (max 1,000,000 chars, `gateway/session_cli_turn.py:16, 33-38`). **Put the per-turn Emperor context block here**, and keep `text` as the human message. |
| `turn_author` | `{id, name, is_bot, origin}` for memory attribution (`agent/turn_author.py:58-81`). |
| `model_override` | `{model, provider?, reasoning?}` for this admission only. |
| `finite` | `true` = single-query semantics: clarify gets a headless "use your judgment" answer (`gateway/session_finite.py:18-26`). |
| `unattended` | requires `finite:true`. Auto-approves. Allowed only for the creating principal over a native ticket on a CLI-platform session (`tool` qualifies) (`session_finite.py:44-68`). |
| `attachments` | `[{path, mime}]` host-local files. |
| `clarify_batch`, `display_kind:"hidden"`, `title_preview`, `surface`, `voice_*`, `interrupted`, `queued` | UI-specific; not needed. |

**There is no per-turn system-prompt field.** The ephemeral system prompt is per session
(`client_env.HERMES_EPHEMERAL_SYSTEM_PROMPT`, read in `gateway/run_config_loaders.py:92-100`). Per-turn
context goes in `api_text`.

Result (`AdmissionStatus`, `canonical.py:29-38`): `{admission_id, ref{profile_id,session_id},
sequence, status: queued|started|unknown|terminal, outcome, authority_epoch, execution_generation}`.
**This is durable admission, not completion.**

### 3.5 Concurrency rules

- One FIFO per session. A submit while busy is **queued** (never refused for being busy) up to
  `ADMISSION_QUEUE_MAX = 32` queued rows, then `queue_full` (`hermes_state_runtime.py:121, 155-162`).
- To feed a running turn instead: `session.steer {session_id, execution_generation, text}` or
  `session.redirect {…}`. Result: `{status: queued|redirected|rejected, text, execution_generation,
  authority_epoch, delivered?}` (`canonical_sessions.py:261-283`, `gateway/session_busy_controls.py:9-15`).
  `prompt.steer_queued {session_id, admission_id}` moves a queued admission into the running turn.
  `prompt.replace_queued` replaces its text.
- Sessions are independent. Many sessions run concurrently in one gateway (exercised by
  `tests/gateway/test_session_policy.py`, three simultaneous turns, per
  `website/docs/developer-guide/gateway-local-sessions.md`).
- `config.set {session_id, key:"busy", value: interrupt|steer|queue}` stores only a UI preference
  (`session_busy_controls.py:30-75`). It does not change server admission.
- A turn whose outcome was lost across a restart becomes `unknown`. It is never replayed, and it
  **pauses the FIFO** until `prompt.resolve_unknown {session_id, admission_id, execution_generation}`
  (`canonical.py:68-76`).

### 3.6 Other methods

| method | params → result | source |
|---|---|---|
| `session.interrupt` | `{session_id, execution_generation}` → session handle `{ref, instance_id, authority_epoch, revision, execution_generation, execution_state: idle\|running\|waiting\|unknown\|terminal}` | `session_controls.py:823-837`, `canonical_sessions.py:77-83` |
| `prompt.cancel` | `{session_id, admission_id}` → AdmissionStatus. A queued row is retired. If the drain just claimed it, the claim is interrupted. | `session_controls.py:806-821` |
| `prompt.receipt` | `{session_id, admission_id, include_result?}` → AdmissionStatus + `result` + `usage` (terminal only) | `session_controls.py:792-806`, `canonical.py:41-56` |
| `session.events.since` | `{session_id, last_sequence, replay_epoch}` → `{events[{type,session_id,payload,replay_epoch,seq,authority_epoch?,execution_generation?,admission_id?}], latest_seq, last_sequence, epoch, replay_epoch, truncated, snapshot_required, count}` | `session_controls.py:679-685`, `session_events.py:77-89` |
| `session.mutate` | `{session_id, request_id, expected_revision, operation, payload, expected_generation?}` | `canonical.py:82-109` |
| — compress | `operation:"compress"`, `payload:{focus?:str, preview?:bool, partial?:bool, keep_last?:int}` (`keep_last` needs `partial:true`). Use a 660 s timeout. | `hermes_state_mutations.py:38,76-87`, `gateway_client.py:20-26` |
| — others | `rename{title}`, `archive{archived}`, `sidebar{…}`, `delete{}`, `reset{}`, `branch{title?,through_message_id?}`, `rewind{target_message_id}`, `model{model,provider?,reasoning?}`, `reasoning{effort}`, `workspace{cwd}`, `import{sessions:[…]}` | `hermes_state_mutations.py:8-56` |
| `session.stats` | `{session_id}` → cumulative tokens incl. `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `api_calls`, context figures, `compression_count`, `model`, `provider` (**no cost**) | `canonical.py:209-243` |
| `session.info` | `{session_id}` → frozen policy projection (model, toolsets, system_prompt, context_length, …) | `canonical.py:147-206` |
| `session.list` | `{scope: live\|stored, limit≤200, title?, include_hidden?}` → `{sessions[{session_id,id,title,source,started_at,message_count,running,model?}], scope}`. **`tool`/`oneshot`/`kanban` rows are excluded from the live list** (`session_controls.py:540-546`). Track session ids in Emperor's own DB. | `session_controls.py:511-557` |
| `approval.respond` | `{session_id, execution_generation, prompt_id, choice}` (choice ∈ the prompt's `choices`: `once`, `deny`, `session`, `always`) → `{status: resolved\|already_resolved, prompt_id}` | `session_controls.py:839-843`, `gateway/session_pending_controls.py:18-38` |
| `clarify.respond` | `{session_id, execution_generation, prompt_id, answer}` → same | `session_controls.py:845-849` |
| `config.set`/`config.get` | `{session_id, key, value}`. Keys: `busy`, `verbose`, `show_reasoning` (`on`/`off`/`1`/`0`/`true`/`false`), `yolo`, `service_tier` (write). `model` is refused (`use_session_mutation_model`). | `session_busy_controls.py:30-128` |

Approval and clarify flow: during a turn the server publishes `approval.request` or `clarify.request`
(payload = the `prompts[]` entry shape above) and blocks the agent thread. Answer with
`approval.respond`/`clarify.respond` from an **attached** connection
(`gateway/session_authority.py:983-998`). Resolution publishes `approval.settled`/`clarify.settled`
`{prompt_id, execution_generation}`. Prompts survive viewer disconnects, and a new viewer sees them in
`session.resume.prompts`. An interrupt or teardown denies them. For hands-off operation either create
the session with `yolo:true` or submit with `finite:true, unattended:true`.

There is no "discard/close session" RPC beyond `session.detach {…, end_reason}` (the last viewer
leaving an idle local session ends its row) and `session.mutate operation:"delete"`.

---

## 4. Event catalogue during a turn

Declared in `tui_gateway/contracts/events.py`. Canonical producers: `gateway/run_turn_runner.py`,
`gateway/run_turn_progress.py`, `gateway/local_viewer_events.py`, `gateway/session_authority.py`.
Typical order:

| # | type | payload (canonical) | notes |
|---|---|---|---|
| 1 | `session.info` | `{stored_session_id, pending[], authority_epoch, desktop_protocol, running, execution_generation, revision}` | FIFO and state change (`session_authority.py:405-420`). Also emitted after settlement. |
| 2 | `message.start` | `{}` (automation turns add `display_kind/display_text/text`) | claim stamped (`session_authority.py:1080-1093`) |
| 3 | `status.update` | `{kind, text}`; `kind:"compacting"` for auto-compaction progress | `run_turn_progress.py:1017-1020` |
| … | `reasoning.delta` | `{text}` | **only if the session's `show_reasoning` flag is on.** Default is off for `source:"tool"` (`local_viewer_events.py:52-87`). Turn it on with `config.set {session_id,key:"show_reasoning",value:"on"}`. The flag lives in memory, so re-set it after every gateway restart or re-attach. |
| … | `reasoning.available` | `{text}` | non-streaming providers, same gate |
| … | `thinking.delta` | `{text}` | spinner text (`""` clears) |
| … | `message.delta` | `{text: str \| null}` | `null` = segment boundary before tool lines (`run_turn_runner.py:270-283`) |
| … | `message.interim` | `{text, already_streamed}` | commentary sealed beside tool calls |
| … | `tool.generating` | `{name}` | model emitting tool args |
| … | `tool.start` | `{tool_id, tool_call_id, name, tool_name, context, args, labels?}` | `args` bounded to 64 KiB of JSON, oversized fields cut to 4 KiB each (`gateway/session_tool_events.py:4-22`, `run_turn_progress.py:44-55`) |
| … | `tool.progress` | `{tool_id, name, progress, total?, percent?, message?}` | MCP progress, at most one per 500 ms per call |
| … | `tool.complete` | start fields + `{is_error, result, duration_s, inline_diff?, todos?, revision?, result_text?}` | `result` is a string at most 64 KiB. Beyond that it becomes `{"output"\|"error": first 32 KiB, "truncated": true}` (`session_tool_events.py:25-30`). `result_text` only in session `verbose` mode. |
| … | `todo.updated` | `{todos, revision}` | |
| … | `agent.step` | `{iteration}` | each agent-loop step |
| … | `session.usage` | `{usage{model,input,output,reasoning,prompt,completion,total,calls,context_used,context_max,context_percent,cache_read,cache_write,cache_hit_pct,cost_usd?,cost_status?,…}, input_tokens, output_tokens, cache_read_tokens, …}` | after API calls and at turn end (`events.py:274-309`; `Usage` at `tui_gateway/contracts/common.py:19-44`) |
| … | `approval.request` / `clarify.request` / `*.settled` | §3.6 | |
| … | `agent.print` | `{text}` | lines the agent printed (subagent completion, compaction, budget notices) |
| … | `subagent.*`, `moa.*` | see `events.py:575-662` | |
| **end** | **`message.complete`** | `{text, content, admission_id, outcome: completed\|failed\|cancelled\|unknown…, status: complete\|interrupted\|error, warning?, error_surface?, reasoning?, usage?, persisted_turn{row_ids, complete, user_row_id, final_assistant_row_id, submission_id}, response_reused?, failure_reason?, billing?}` | `gateway/session_settlement_recovery.py:53-94, 97-112`. A cancelled **queued** row also gets one, with empty text (`session_authority.py:777-792`). |
| after | `session.info` | `running:false`, updated `pending` | "Idle follows the completion" (`session_settlement_recovery.py:222-224`) |

Other events: `session.title {session_id,title}`, `session.updated` (after mutations),
`session.replay_gap {replay_epoch, latest_seq}` (subscription retired, so re-attach),
`approval.cancelled`, `notification.show/clear`, `error {message}` (session-level failure outside a
turn), `request.cancel`.

**Turn finished** = `message.complete` whose `admission_id` matches your submit receipt. Events
can arrive **before** the `prompt.submit` response, so buffer by `admission_id` (the reference client
does this, `hermes_cli/gateway_chat_view.py:115-130`). `text` is the final assistant text. For the
committed record (`final_response`, token ledger, cost, model, exit reason) call
`prompt.receipt {session_id, admission_id, include_result:true}` (`session_controls.py:792-806`). If
`outcome != "completed"` or `status != "complete"`, treat the turn as failed or interrupted.

Compression: an explicit `session.mutate compress` answers only after the summary and commit, and
returns `{…, status, lines, revision}`. Auto-compaction during a turn shows as `status.update` with
`kind:"compacting"`. `session.usage.compression_count` and `session.stats.compression_count` count
compactions. Physical transcript ids rotate, but clients keep using the **logical** session id.

### 4.1 Replay after reconnect

- The ring is **in memory**: 512 frames or 4 MiB per session, 64 sessions, 64 MiB per process
  (`tui_gateway/event_replay.py:30-36`). Long streaming turns overflow 512 frames quickly.
- On reconnect: mint a ticket, open the WS, `session.resume`, then
  `session.events.since {session_id, last_sequence: <last seen seq>, replay_epoch}`. If
  `snapshot_required`/`truncated` is true (epoch changed or evicted), rely on the resume snapshot
  (`messages`, `pending`, `prompts`) plus `prompt.receipt include_result` for any admission you were
  waiting on. That is exactly what the reference client does (`gateway_chat_view.py:135-160`).
- A gateway restart changes `authority_epoch` and `replay_epoch`. A turn interrupted by the restart
  settles as `interrupted`, with `warning` = the restart notice, or as `unknown`.

---

## 5. Environment, credentials, and per-turn plugin context

- **Credentials** come from the profile's `.env` and process environment, bound per turn by the
  secret scope (`agent/secret_scope.py`; design in `website/docs/developer-guide/multiplexing-gateway.md`).
  For a standalone gateway the launch environment (systemd `Environment=`, Docker env) is frozen at
  start. **Rotate env-only keys by restarting the gateway.** Inside a profile scope, `.env` wins over
  the frozen environment for keys set in both. Plugin tools should read keys with
  `os.environ`/`get_secret` exactly as today.
- **Session per Emperor thread.** Inside a turn, plugins and tools can read
  `gateway.session_context.get_session_env("HERMES_SESSION_ID")`. That is a ContextVar bound per turn
  and inherited by executor threads (`gateway/session_context.py:1-6, 81-92, 191-197`; bound in
  `gateway/run.py:3977-4007`). `HERMES_SESSION_PLATFORM` is `local`. `HERMES_SESSION_MESSAGE_ID` comes
  from the session's source, **not** the admission (inferred), so do not rely on it.
- **Per-session metadata to plugins:** `client_env` names listed in the profile's
  `terminal.client_env_passthrough` (non-secret, not `HERMES_*`) are bound for every turn of that
  session. Plugins read them via `agent.session_client_env.bound_client_env()`, and tool subprocesses
  get them through `toolchain_environ` (`agent/session_client_env.py:113-160`). Example:
  `client_env:{"EMPEROR_THREAD_ID":"8f2c"}` with `terminal.client_env_passthrough: [EMPEROR_THREAD_ID]`.
  This is frozen at create, so it is per thread, not per message.
- **Per-message id to plugins:** no public per-admission field reaches plugins.
  Options, in order of preference:
  1. The bridge keeps `session_id → running admission_id → emperor_message_id` (one running admission
     per session is guaranteed by the FIFO). The plugin asks the bridge (local IPC) using
     `HERMES_SESSION_ID`.
  2. Carry it in `turn_author.origin` or `id`. During execution the private ContextVar
     `gateway.session_cli_turn._cli_turn` holds `(admission_id, {"turn_author":…,"api_text":…})`
     (`gateway/session_cli_turn.py:17, 66-81`). This is private API and may change.
  3. Put a machine-readable line in `api_text` (the model sees it, the plugin does not).

---

## 6. Sessions created by `hermes chat -q` (migration)

- In v0.22.4, `hermes chat -q` itself is a client of this same gateway: it auto-starts
  `gateway run --idle-exit` and submits through `session.create`/`prompt.submit`
  (`hermes_cli/gateway_chat.py:161-228`). **It validates `--source` against
  `runtime.describe.session_create.sources` and raises `Gateway does not support source 'emperor'`**
  (`gateway_chat.py:202-204`). The current bridge passes `--source emperor`
  (`integrations/hermes/emperor-claw/bridge/emperor_hermes_bridge.py:3351-3352`), so **upgrading the
  host to v0.22.4 breaks the current bridge** until that flag changes to `tool`.
- Pre-authority rows are adoptable when their `source` ∈ `{cli, tui, gui, desktop, oneshot, tool,
  acp}` (`hermes_state_local_migration.py:15`): `session.resume {session_id}` over a native ticket from
  the same profile adopts the historical id as the logical owner without copying messages
  (`gateway/session_local_migration.py:1-8, 34-45`). **Rows stored with `source = 'emperor'` are not in
  that set.** `session.resume` then goes through the messaging-owner path, and the expected result is
  `not_found`/`permission_denied` (inferred, see open questions). Plan: **start fresh sessions**, seeding
  continuity through the per-session system prompt or the first `api_text`. `session.mutate
  operation:"import"` exists but is unverified for this case.

---

## 7. Contract tests without real API keys

- `tests/fakes/fake_llm_provider.py` (present at v0.22.4 **and** v0.21.6) is a real 127.0.0.1 HTTP
  server speaking OpenAI Chat Completions (JSON + SSE). It is scriptable with `Text(text, reasoning,
  chunk_chars, delay_per_chunk, prompt_tokens, completion_tokens, cached_tokens)`,
  `ToolCall(name, args, parallel)`, `Error(status)`, `Hang`, `DropMidStream`, `StallMidStream`,
  `Raw`. It records every request. Auxiliary calls (no `tools`) are answered separately.
  `write_hermes_home(home, base_url)` writes `model.provider: custom`, `base_url`,
  `default: fake-model`, and `.env OPENAI_API_KEY=sk-fake-e2e`. Standalone:
  `python -m tests.fakes.fake_llm_provider 8765`.
- `HERMES_TEST_ISOLATION=1` makes contract violations (result or event payload not matching its
  Pydantic model) **raise** instead of log (`tui_gateway/AGENTS.md`, "Transport").
- Reference end-to-end tests to mirror: `tests/gateway/test_local_session.py` (disposable gateway,
  real tickets, loopback model, approval and clarify across reconnect),
  `tests/gateway/test_local_session_recovery.py` (kill and restart),
  `tests/gateway/test_session_policy.py` (concurrent sessions).
- Machine-readable wire: `apps/shared/src/gateway-contract.openrpc.json`, rendered by
  `scripts/gen_gateway_contracts.py` (`x-canonical-methods`).

Suggested harness: fake provider plus a temp `HERMES_HOME` with `gateway.standalone: true` and
`gateway.unmanaged_idle_exit_seconds: 0`, then `hermes gateway run`, then Emperor's client.

---

## 8. Version pinning

- There is no PyPI release (the `pyproject.toml` version is `0.0.0`). Install from git by tag:
  ```
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v0.22.4/scripts/install.sh \
    | bash -s -- --skip-setup --branch v0.22.4
  ```
  `install.sh` accepts `--branch NAME` (passed to `git clone --branch`, so tags work), `--commit SHA`,
  and `--channel stable|main` (`scripts/install.sh:46-94, 905`). For an exact pin use
  `--commit 4d04303818b61bf3aa09278af48356315515965b`. Also pass `--skip-browser` if Playwright is not
  needed.
- The pinned install still runs `hermes update` when asked. Never run it in the container, and do not
  set `--channel main`.
- Emperor's image today (`integrations/hermes/Dockerfile:49-50`) pipes `main/scripts/install.sh` with
  only `--skip-setup`. That is the `stable` channel by default: **the latest release at build time,
  not pinned**. Change it to:
  ```dockerfile
  ARG HERMES_REF=v0.22.4
  RUN curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_REF}/scripts/install.sh" \
      | bash -s -- --skip-setup --branch "${HERMES_REF}"
  ```
  Then verify at build time: `git -C ~/.hermes/hermes-agent describe --tags` must equal `v0.22.4`.
- Alternative: `nousresearch/hermes-agent:<tag>` official image (s6-overlay; `gateway run` is
  redirected to the supervised service unless `--no-supervise`).
- Bare-metal hosts: `git fetch --tags && git checkout v0.22.4`, then the installer's dependency sync
  (an operator action, outside this document's read-only scope).

---

## 9. Differences v0.21.6 → v0.22.4

| Area | v0.21.6 | v0.22.4 |
|---|---|---|
| Session authority (`gateway/session_contract.py`, `session_controls.py`, `session_local*.py`, `hermes_cli/gateway_client.py`, `gateway_runtime*.py`) | **absent** | present (introduced in the v0.22 line). The PC's `ecf9655` lacks it too. |
| `hermes chat -q` | in-process agent per invocation; arbitrary `--source` accepted (inferred: current bridge works) | thin client of an auto-started `gateway run --idle-exit`; `--source` must be a declared surface |
| Persistent server option | `hermes serve` (dashboard backend) WS `/api/ws` with `?token=` = `HERMES_DASHBOARD_SESSION_TOKEN` or a random per-start value (`hermes_cli/web_server.py:380-386 @v0.21.6`, `web_server_chat.py:255-372 @v0.21.6`), or stdio `tui_gateway.entry` | gateway control socket + ticketed `hermes-gateway-v1` WS (this document). `hermes serve` still exists. |
| `session.create` params | legacy TUI shape: `cols, source(any str), cwd, cwd_explicit, messages, parent_session_id, title, model, provider, reasoning_effort, fast, service_tier, close_on_disconnect, hidden, idempotency_key, …` (`tui_gateway/contracts/sessions.py:119-140 @v0.21.6`) | closed canonical set (§3.2), `request_id` idempotency, `source` enum |
| `prompt.submit` | `{session_id, text, …truncate_*}`; turn runs in the sidecar, not durable | durable admission with receipt, FIFO (32), `submission_id` idempotency, `api_text`, `turn_author`, `finite`/`unattended` |
| Compression | `session.compress {session_id, focus_topic}` (`sessions.py:569-592 @v0.21.6`) | `session.mutate operation:"compress" payload:{focus,…}` |
| Replay | `session.events.since {session_id, last_seen}` → `{events, latest_seq, truncated, count, epoch, open_requests}` | adds `replay_epoch`, `snapshot_required`, `last_sequence` |
| Approvals | server→client request `approval` answered with a response frame | `approval.request` event + `approval.respond` RPC (generation-fenced, survives reconnect) |
| Interrupt | `session.interrupt {session_id}` → `{status: interrupted\|not_interrupted}` | `{session_id, execution_generation}` → handle |
| Gateway shape | per-profile gateways normal | multiplexer default; named profile needs `gateway.standalone: true` or `--force` |

Recommendation: do not build the persistent client against v0.21.6's `hermes serve`. Its wire is the
legacy TUI contract that v0.22.4 supersedes for local sessions. Upgrade the runtime hosts to v0.22.4
first.

---

## 10. Open questions (verify on a disposable profile before implementing)

1. Exact `identify.served_profiles` entry shape and `profile_id` value for a standalone named profile.
   Is it the absolute home path? Check against a live `gateway run`.
2. Does a standalone `hermes -p X gateway run` with `gateway.standalone: true` start cleanly when
   **no** default gateway exists? And inside Docker, where the default profile also exists?
3. `source:'emperor'` rows written by v0.21.6: confirm `session.resume` refuses them, and whether
   `session.mutate import` can adopt them. Otherwise accept a fresh start.
4. Adopted legacy (`cli`/`tool`) sessions: which frozen policy (model, toolsets, system prompt) do they
   get? Current profile defaults at adoption time?
5. Is `HERMES_SESSION_ID` during a turn the **logical** id (`local-…`) or the current physical
   transcript id after compression? The bridge needs to map either.
6. Is `show_reasoning` lost on gateway restart (it lives on the in-memory `live` object)? Re-set it
   on every attach to be safe.
7. Does a `tool`-source session with neither `yolo` nor `unattended` block indefinitely on approval
   when no viewer is attached, or time out (`timeout_s` in the prompt)? What is the default timeout?
8. Is `.env` re-read per turn in a standalone (non-multiplexed) gateway, so key rotation needs no
   restart, or only at boot?
9. Ticket `scope` values beyond `profile`/`host`, and whether one host-scoped ticket could serve every
   profile on a multiplexer (shape B).
10. Cost: `Usage.cost_usd`/`cost_status` presence on canonical `session.usage` frames for DeepSeek and
    OpenRouter (the `tui_usage` projection).
