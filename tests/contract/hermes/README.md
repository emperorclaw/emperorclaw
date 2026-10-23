# Hermes v0.22.4 gateway contract harness

A disposable Docker image with a real Hermes gateway pinned to **v0.22.4**
(`4d04303818b61bf3aa09278af48356315515965b`, the build fails on any other commit), the Hermes
fake OpenAI-compatible provider, and `gateway_probe.py`, a client that talks to the gateway the way
the Emperor bridge does. No real model keys are used and no network access is needed at run time.

Findings: `docs/design/hermes-spike-results.md`.

## Run it

```bash
tests/contract/hermes/run.sh                      # protocol suite (gateway_probe.py); exit 0 = all required checks pass
tests/contract/hermes/run.sh all                  # + bridge suite (bridge_contract.py): what CI runs
RECORD_FIXTURES=1 tests/contract/hermes/run.sh    # also rewrite tests/fixtures/hermes-v0224/*.jsonl
PROBE_LATENCY_RUNS=3 tests/contract/hermes/run.sh # faster (fewer latency samples)
PROBE_ONLY=27,28,29 tests/contract/hermes/run.sh  # only the self-contained R-2/R-3/R-4 scenarios
```

`HERMES_BASE` picks the image the harness is layered on: `shipped` (the managed image from
`integrations/hermes`, tag `emperorclaw-hermes:ci`; CI), `spike` (`Dockerfile.spike-base`, the W0
install) or `auto` (default: shipped if it builds and is pinned, else spike with a warning).
`CONTRACT_SUITE=probe|bridge|all` (or the first argument) picks the suites.
`BRIDGE_CONTRACT_REQUIRE=1` makes a skipped bridge scenario a failure (CI).

Output goes to `tests/contract/hermes/results/` (git-ignored): `probe-report.json` and
`bridge-report.json` (every scenario with checks and evidence), latency figures, the gateway and
bridge logs, and the request logs of the fake model (`fake_llm_requests.jsonl`) and the fake
Emperor API (`emperor_echo_requests.jsonl`). The probe takes about 7 minutes, much of it in
deliberate waits (ticket TTL, approval timeout, the R-4 drain runs).

Equivalent raw commands (from the repository root):

```bash
docker build -t emperorclaw-hermes:ci integrations/hermes
docker build --build-arg BASE_IMAGE=emperorclaw-hermes:ci -f tests/contract/hermes/Dockerfile -t emperor-hermes-contract:v0.22.4 .
docker run --rm -e CONTRACT_SUITE=all -v "$PWD/tests/contract/hermes/results:/results" emperor-hermes-contract:v0.22.4
```

Explore by hand: `docker run -d --name hx emperor-hermes-contract:v0.22.4 shell`, then
`docker exec -it hx bash` (profile `spike` is configured, fakes are running, no gateway yet:
start one with `hermes -p spike gateway run --external-supervisor`).

## Pieces

| File | Role |
|---|---|
| `Dockerfile` | `FROM ${BASE_IMAGE}` (default `emperorclaw-hermes:ci`, the shipped image). Fails the build unless the base's Hermes checkout is commit `4d04303…`. Adds the probe venv (`websockets==15.0.1`), the repo's plugin + bridge and this folder. Build context = repo root (`Dockerfile.dockerignore` keeps it to the plugin + this folder). |
| `Dockerfile.spike-base` | The W0 spike's pinned install (`install.sh --branch v0.22.4 --skip-setup --skip-browser --skip-computer-use`), used only with `HERMES_BASE=spike`/`auto`. |
| `run.sh` | Host entry: builds the base and the harness image, runs the container. |
| `run_contract.sh` | Container entrypoint. Starts the fakes, writes profile `spike` (`gateway.standalone: true`, `unmanaged_idle_exit_seconds: 0`, model `custom` at the fake with `key_env`, Emperor's production profile defaults, `terminal.client_env_passthrough`), installs the `emperor-claw` and `envprobe` plugins, then runs `CONTRACT_SUITE`. |
| `fake_llm.py` | Wraps Hermes' `tests/fakes/fake_llm_provider.py`. Markers in the user text pick the response (`[[tool:read]]`, `[[tool:three]]`, `[[tool:envprobe]]`, `[[tool:emperor]]`, `[[tool:danger]]`, `[[tool:thenhang]]`, `[[tool:clarify]]`, `[[tool:steer]]`, `[[tool:ack]]`, `[[slow:N]]`, `[[reason]]`, `[[hang]]`, `[[hangonce:KEY]]`, `[[drop]]`). Logs every request. |
| `emperor_echo.py` | The fake Emperor API: records every call and echoes the bearer token (so tool results show which token the plugin read), and models the routes bridge 0.9 uses (register, heartbeat, sync, send with `Idempotency-Key`, runs, run events, control, lean context, goals, profile defaults). Test control under `/__fake/*` (inject messages, control commands, outages, duplicate runtime, state dump). |
| `envprobe/` | Test plugin with one tool, `envprobe_dump`: reports `os.environ`, `get_session_env`, `bound_client_env()`, `toolchain_environ()` as seen inside a gateway turn. |
| `gateway_probe.py` | Protocol suite: the client and 29 scenarios. Owns the gateway process (start, SIGTERM, SIGKILL, restart). Writes fixtures with `PROBE_FIXTURES_DIR`. |
| `bridge_contract.py` | Bridge suite: `python -m emperor_bridge run` against real gateways (own profiles, `HERMES_TEST_ISOLATION=1`) and the fakes. 26 scenarios from design §9.1. Skips with the reason while the package is missing. |
| `python_suites.py` | Not Docker: the runner behind `npm run test:bridge` (every `tests/*.test.py` + `tests/bridge/`). |
| `side_by_side.sh` | S-14 check: installs a second Hermes checkout with `install.sh --dir` beside the pinned one (needs network, about 3 minutes). Run: `docker run --rm --entrypoint sh emperor-hermes-contract:v0.22.4 /opt/contract/side_by_side.sh`. |

## Fixtures

`tests/fixtures/hermes-v0224/*.jsonl`: one JSON object per line, `{"dir": "out"|"in"|"meta",
"t_ms": <ms since the fixture started>, "frame": <raw JSON-RPC frame>}`. `meta` lines mark
connects, disconnects and gateway kills. Session ids, admission ids and epochs are real values from
the recorded run.

## CI notes

- Job `hermes-image-contract` in `.github/workflows/ci.yml`: `HERMES_BASE=shipped`,
  `BRIDGE_CONTRACT_REQUIRE=1`, `run.sh all`. On PRs only when Hermes paths change; always on
  `main` and tags. Results are uploaded as an artifact on failure.
- The image builds need network (GitHub + the installer's Python download); the run does not.
- Keep the run serial per container: both suites restart their gateways.
- `HERMES_TEST_ISOLATION=1` is set on the bridge suite's gateways, not on the probe's, so a
  contract violation inside Hermes is raised for the bridge suite and logged for the probe.

## Findings: R-2, R-3, R-4 (W8, 2026-10-22)

Probe scenarios `27_clarify_auto`, `28_steer_followup`, `29_graceful_stop_drain`, run on the
**shipped image** (`emperorclaw-hermes:ci`, Hermes `4d04303`), all required checks green. Evidence:
`results/probe-report.json`. Re-run: `PROBE_ONLY=27,28,29 tests/contract/hermes/run.sh`.

### R-2 `clarify` auto-answer: works, and production never needs it

- With the production toolsets (`emperor-claw,web,terminal,code_execution`) the model is **not
  offered `clarify`**. A call to it gets `Tool 'clarify' does not exist…` as the tool result and the
  turn completes. No `clarify.request` is published.
- With `clarify` available (profile default toolsets), the attached viewer gets
  `clarify.request` with payload `{kind:"clarify", prompt_id, execution_generation, question,
  choices:["blue (Recommended)","red"], multi_select, timeout_s:3600}` ~150–200 ms after submit.
  `clarify.respond {session_id, execution_generation, prompt_id, answer}` returns
  `{status:"resolved"}`, `clarify.settled` follows, and the model receives
  `{"responses":[{"status":"answered","user_response":"blue",…}],"outcome":"submitted"}`
  (the "(Recommended)" suffix is stripped). Respond → turn complete: ~130 ms.
- Unanswered, the turn blocks for `agent.clarify_timeout` (default **3600 s**).
- Recommendation: keep `clarify` out of the toolsets (current default). The bridge's auto-answer
  (first choice, else "use your best judgment") is a safety net. Add `agent.clarify_timeout: 60`
  to the hard-applied profile keys (W6 entrypoint, W7 installer) as the backstop.

### R-3 `session.steer`: lossy without a tool boundary, keep it off

- During a tool call: `session.steer` → `{status:"queued"}` in 2 ms. The text reaches the model at
  the next model call **in the same turn**, as a user message wrapped in
  `[OUT-OF-BAND USER MESSAGE …]` markers. No new admission.
- During a text-only stream (no tool call left): also `{status:"queued"}`, but the text **never
  reached the model** and no follow-up admission ran. It is silently dropped. Same result in two runs.
- While idle: `4001 stale_generation`.
- Answer: `EMPEROR_CLAW_HERMES_FOLLOWUP=coalesce` stays the default and `steer` stays off. If it is
  ever enabled, the bridge must treat `queued` as unconfirmed and check delivery (the receipt
  `result` has a `pending_steer` field; not yet checked).

### R-4 `agent.restart_drain_timeout` on SIGTERM: yes, with two consequences

- A turn shorter than the drain **completes**. Drain 45 s, 6 s turn: receipt `terminal/completed`,
  `turn_exit_reason text_response(finish_reason=stop)`, `result.final_response` present.
- A turn longer than the drain settles **interrupted**. Drain 4 s, 30 s turn:
  `interrupted_during_api_call(gateway_shutdown)` → D15 path. Never `unknown`.
- **Consequence 1:** the gateway closes viewer WebSockets as soon as SIGTERM arrives. No live
  `message.complete` reaches the bridge, and a submit during the drain fails (socket closed). The
  bridge learns the outcome only from `prompt.receipt` after the restart, so the restart path (D15)
  must also deliver **completed** receipts (`result.final_response`), not only handle
  interrupted/unknown ones. Bridge scenario `graceful_stop_drain` checks this.
- **Consequence 2:** the process exits at **drain + ~20.5 s**, no matter when the work finished.
  Measured: drain 4 → 24.5 s, 10 → 30.5 s, 45 → 65.6 s (drain 0 → 0.8 s). The log shows the drain
  done at +6.1 s and SessionDB closed at +6.5 s, then the process lingers. With drain 45 the gateway
  outlives the supervisor's 55 s wait and systemd's 60 s stop timeout and gets SIGKILLed. That is
  after SessionDB close, so no data is lost, but every stop then ends in a SIGKILL.
  **Recommendation: `agent.restart_drain_timeout: 30`** (exit ≈ 50.5 s, inside both budgets).
  The alternative is supervisor wait ≥ 70 s, `TimeoutStopSec` ≥ 75 s and Docker `StopTimeout` ≥ 85 s.
  The probe records the stop time against the 55 s budget as a soft check.
- An admission queued in Hermes behind the draining turn is not claimed during the drain. It
  runs after the restart.
