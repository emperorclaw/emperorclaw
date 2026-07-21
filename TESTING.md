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
| 2. Integration | `npm run test:integration` | Postgres | ✅ (integration job) |
| 4. Live / operator | `python tests/agent-chat.test.py` | instance + bridge + model | ❌ manual |

`npm test` = static + unit (layers 0/1/3), no database, always fast and green.

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

## Adding tests
- New branching logic → a Layer 1 unit test (extract the logic to a lib first).
- New/changed route behavior or a DB invariant → a Layer 2 integration test.
- New agent-reply decision rule → extend `bridge-logic.js` + its Layer 3 matrix.
- New end-to-end agent capability → a Layer 4 scenario + a rubric row.
