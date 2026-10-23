# Testing EmperorClaw

Testing is layered. Deterministic layers run in CI on every push/PR; the live
layer needs a real instance + model and is run manually or by an operator.

```
        ┌───────────────────────────────────────────────┐
  live  │ 4. Live / operator — real model, real bridge  │  manual, gated
        ├───────────────────────────────────────────────┤
  CI    │ 3. Bridge contract — reply logic, mock LLM     │
        │ 2. Integration — routes + real Postgres        │
        │ 1. Unit — pure logic, no I/O                   │
        │ 0. Static — source/architecture guardrails     │
        └───────────────────────────────────────────────┘
```

## What runs where

| Layer | Command | Needs | In CI |
|-------|---------|-------|-------|
| 0. Static guardrails | `npm run test:static` | — | ✅ |
| 1. Unit | `npm run test:unit` | — | ✅ (via `npm test`) |
| 3. Bridge contract | (part of `test:static`) | — | ✅ |
| 3. Hermes Python suites | `npm run test:bridge` | Python 3.11+ | ✅ (`python-suites`, 3.11/3.13/3.14) |
| 3. Hermes gateway contract | `npm run test:contract:all` | Docker | ✅ (`hermes-image-contract`) |
| 3. Hermes installer | `bash tests/hermes-installer.test.sh` | Docker | ✅ (`hermes-installer`) |
| 2. Integration | `npm run test:integration` | Postgres | ✅ (integration job) |
| 4. Live / operator | `python tests/agent-chat.test.py` | instance + bridge + model | ❌ manual |

`npm test` = static + unit (layers 0/1/3), no database, always fast and green.
The Hermes rows are described in [Hermes runtime (bridge 0.9)](#hermes-runtime-bridge-09).

## Layer 0 — Static guardrails (`tests/*.test.cjs`)
Read source and assert architectural/UX invariants (service boundaries, RBAC
shape, operator-UX consistency). Fast, no runtime. They catch drift, not logic
bugs.

## Layer 1 — Unit (`tests/unit/*.test.ts`)
Pure functions with no I/O. The money/version logic lives in `src/lib/billing.ts`
and `src/lib/semver.ts` precisely so it can be tested here and can't drift from
the routes that import it. Add a unit test whenever you add branching logic that
doesn't need the DB.

## Layer 3 — Bridge contract (`tests/unit/bridge-logic.test.cjs`)
**This is how we test "does the agent reply?" without a real model.** The bridge's
decision logic (should-respond classification, loop guard, usage estimate, output
cleaning) is extracted into `integrations/codex/bridge-logic.js` and tested as a
matrix: direct vs team chat, @mention gating, agent-loop prevention, dedup, and a
mock-LLM reply cycle. Deterministic — the LLM is a stub.

## Layer 2 — Integration (`tests/integration/*.test.ts`)
Route handlers run **in-process** against a real Postgres (no HTTP server). Covers
registration (bootstrap + email-optional auto-verify), report-usage (usage
increment, cost, budget pause, auth, cross-company isolation), and health.

```bash
docker run -d --name ec-test-pg -e POSTGRES_USER=emperor \
  -e POSTGRES_PASSWORD=emperor -e POSTGRES_DB=emperor_test \
  -p 5433:5432 postgres:16-alpine
export POSTGRES_CONNECTION_STRING=postgres://emperor:emperor@localhost:5433/emperor_test
npm run db:migrate        # provisions the schema via the migration chain
npm run test:integration  # runs serially against that DB
```

Tests skip cleanly when `POSTGRES_CONNECTION_STRING` is unset, so `npm test`
stays green without a DB. CI provisions via `db:migrate`, which **also guards
against migration/schema drift** — a schema column with no migration makes the
integration inserts fail.

## Layer 4 — Live / operator (real model)
Some behavior is inherently non-deterministic and can only be validated against a
running instance with a real bridge and model: *does the agent actually produce a
sensible, correct reply, create the pipeline, write the KB entry?* These are not
in CI (they cost money, need credentials, and have no single right answer).

- `tests/agent-chat.test.py` — scripted message → response / dedup / no-loop
  checks against a running instance.
- `tests/e2e/run_tests.py` — broader MCP flow coverage.
- `tests/e2e/test-plan.md` — the manual acceptance checklist.

Run them against a **disposable** instance:

```bash
export EMPEROR_CLAW_API_URL=http://localhost:3000
export EMPEROR_CLAW_API_TOKEN=<company MCP token from Settings → Access Tokens>
python tests/agent-chat.test.py
```

Never hardcode tokens. Get one from **Settings → Access Tokens** and pass it via
the environment.

### Operator / LLM-judge acceptance rubric
For the "did the agent reply sensibly?" checks that a human or an AI operator
grades, score each scenario against a fixed rubric so results are comparable
across runs:

| Criterion | Pass condition |
|-----------|----------------|
| **Responded** | A reply arrived within the timeout (default ~15s) |
| **On-task** | The reply addresses the request, not boilerplate |
| **Correct action** | Any requested side effect actually happened (pipeline/KB/task exists with the right fields) |
| **No loop** | The agent did not reply to its own or another agent's message |
| **Budget honored** | A budget-paused agent declines instead of answering |
| **Cost recorded** | `/budgets` shows tokens/cost increased after the exchange |

An AI operator can drive `tests/e2e/test-plan.md`, then grade each step against
this rubric and report pass/fail with evidence — that is the intended way to run
Layer 4 acceptance.

## Hermes runtime (bridge 0.9)

Three layers cover the Hermes integration (design: `docs/design/hermes-persistent-runtime.md` §9).

### Python suites: `npm run test:bridge`

`tests/contract/hermes/python_suites.py` **discovers** every suite, so a new one cannot be left out:
each `tests/*.test.py` runs in its own interpreter, and `tests/bridge/` runs with
`python -m unittest discover` (write `unittest.TestCase` classes: a run that collects 0 tests fails).

```bash
python3 -m pip install "websockets==15.0.1"   # the version Hermes v0.22.4 ships (S-15)
npm run test:bridge                           # everything, on your python3
npm run test:bridge:plugin                    # only tests/hermes-plugin-*.test.py
PYTHON_SUITES_STRICT=1 npm run test:bridge    # as CI: a missing expected suite fails
```

- The bridge runs on Hermes' own venv Python (3.14), so that is the version that matters. CI runs
  the full set on 3.13 and 3.14, and the plugin suites alone on 3.11 (the plugin also runs outside
  a Hermes venv). To reproduce a version locally:
  `docker run --rm -v "$PWD:/repo" -w /repo python:3.14-slim sh -c 'pip install -q websockets==15.0.1 && python tests/contract/hermes/python_suites.py'`.
- `tests/agent-chat.test.py` is a live suite: it is skipped unless `EMPEROR_CLAW_API_TOKEN` is set
  (see Layer 4).

### Gateway contract: `npm run test:contract` / `npm run test:contract:all`

A real Hermes gateway pinned to **v0.22.4**, Hermes' fake model provider and a fake Emperor API, in
Docker. No model keys and no network at run time (the image builds need network).

```bash
bash tests/contract/hermes/run.sh             # protocol suite (gateway_probe.py), ~6 min
bash tests/contract/hermes/run.sh all         # + bridge suite (bridge_contract.py): what CI runs
bash tests/contract/hermes/run.sh bridge      # bridge suite only
PROBE_ONLY=27,28,29 bash tests/contract/hermes/run.sh    # a few self-contained probe scenarios
BRIDGE_ONLY=simple_turn,interrupt bash tests/contract/hermes/run.sh bridge
RECORD_FIXTURES=1 bash tests/contract/hermes/run.sh      # rewrite tests/fixtures/hermes-v0224/
```

- **Base image.** The harness is layered on the image we ship (`integrations/hermes`, built as
  `emperorclaw-hermes:ci`), so the contract proves the shipped Hermes pin. `HERMES_BASE=shipped`
  (CI) fails if that image does not build or is not pinned. `HERMES_BASE=spike` uses the W0 spike's
  own install instead. `HERMES_BASE=auto` (default) tries shipped, then falls back to spike with a
  warning. `SKIP_BUILD=1` reuses the last image.
- **Results** land in `tests/contract/hermes/results/` (git-ignored): `probe-report.json`,
  `bridge-report.json`, gateway and bridge logs, and the request logs of the fake model and the
  fake Emperor. CI uploads the folder when the job fails.
- **Bridge suite skips** every scenario with the reason while `emperor_bridge` is not importable.
  CI sets `BRIDGE_CONTRACT_REQUIRE=1`, which turns a skip into a failure.
- Explore by hand: `docker run -d --name hx emperor-hermes-contract:v0.22.4 shell`, then
  `docker exec -it hx bash`. Details: `tests/contract/hermes/README.md`.

### Installer: `bash tests/hermes-installer.test.sh`

The remote-mode installer and systemd units, in a systemd container (standalone and shared
layouts, rollback, finalize). Needs Docker. CI job `hermes-installer`.

CI runs the two Docker jobs on every push to `main` and on tags, and on pull requests only when
`integrations/hermes/**`, the Hermes tests or the workflow change.

## Adding tests
- New branching logic → a Layer 1 unit test (extract the logic to a lib first).
- New/changed route behavior or a DB invariant → a Layer 2 integration test.
- New agent-reply decision rule → extend `bridge-logic.js` + its Layer 3 matrix.
- New end-to-end agent capability → a Layer 4 scenario + a rubric row.
- New Hermes bridge behavior → a `tests/bridge/` unit test (fixture-driven), plus a
  `bridge_contract.py` scenario when it depends on how the real gateway behaves.
- A new question about Hermes itself → a `gateway_probe.py` scenario that records the answer.
