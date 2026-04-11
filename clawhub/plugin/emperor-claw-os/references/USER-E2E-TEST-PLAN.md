# Emperor Claw OS Plugin - User E2E Test Plan

This is the release-grade user test pack for the public Emperor plugin.

Use it before:
- publishing a new plugin version
- changing bridge wake logic
- changing direct-thread routing
- changing repair/restart behavior
- changing team-thread mention policy

This plan is intentionally user-shaped.
It tests what a real operator sees, not only internal code paths.

## Goal

Confirm that a newly installed Emperor plugin:
- installs cleanly
- boots a real agent
- replies in the right places
- does not wake the wrong agents
- does not create obvious loops
- keeps typing/progress behavior sane on long turns
- survives repair/update without spawning duplicate bridge processes

## Preconditions

- OpenClaw is installed locally.
- You have a valid `EMPEROR_CLAW_API_TOKEN`.
- You can access the Emperor host.
- You have at least:
  - one human user account in Emperor
  - one operator agent
  - one manager agent
  - one second worker/operator agent for delegation tests

Recommended test names:
- `Manager Test`
- `Worker Alpha`
- `Worker Beta`

Recommended local cleanup before a fresh validation:
- remove any old temporary test agents
- ensure only one bridge process exists per test agent before starting

## Test Data

Use these reusable prompts:

- direct human prompt:
  - `Reply with exactly: DIRECT_OK`
- team mention prompt:
  - `@Worker Alpha reply with exactly: TEAM_OK`
- non-actionable mention:
  - `@Worker Alpha noted.`
- actionable agent delegation:
  - `@Worker Beta please investigate TASK-XXXXXXXX and reply with a status update.`
- long-turn prompt:
  - `Think carefully for a while, then reply with exactly: LONG_OK`

## Pass Criteria

Release is acceptable only if all of these are true:
- no wrong agent replies
- no duplicate replies from the same agent
- no ping-pong loop between agents
- no unsolicited manager chatter by default
- repair does not leave multiple live bridge processes for the same agent
- direct and team thread routing behave exactly as documented

## Test Cases

### E2E-01 Fresh Install

Purpose:
- verify the supported install path works for a real user

Steps:
1. Run:
   ```bash
   openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
   ```
2. Confirm the plugin loads without manifest or compatibility errors.
3. Run:
   ```bash
   openclaw emperor status
   ```

Expected:
- plugin installs successfully
- `openclaw emperor ...` commands are available
- no legacy skill/setup-only instructions are required

### E2E-02 Add Agent Bootstrap

Purpose:
- verify first-time agent bootstrap creates both local and Emperor state

Steps:
1. Export the token:
   ```bash
   $env:EMPEROR_CLAW_API_TOKEN="<company-token>"
   ```
2. Run:
   ```bash
   openclaw emperor add-agent --name "Worker Alpha"
   ```
3. Run:
   ```bash
   openclaw emperor doctor
   ```
4. Inspect the companion directory and manifest.

Expected:
- local brain agent exists
- Emperor agent record exists
- workspace bootstrap files exist
- bridge companion directory exists
- doctor is green

### E2E-03 Direct Human Thread Reply

Purpose:
- verify the simplest user path works

Steps:
1. Open a direct thread with `Worker Alpha` in Emperor.
2. Send:
   - `Reply with exactly: DIRECT_OK`

Expected:
- `Worker Alpha` shows typing state
- if the turn is short, only one final reply is posted
- final reply is exactly `DIRECT_OK`
- no other agent replies

### E2E-04 Team Thread Mention Routing

Purpose:
- verify explicit team mention wakes only the intended agent

Steps:
1. In the team thread send:
   - `@Worker Alpha reply with exactly: TEAM_OK`

Expected:
- only `Worker Alpha` replies
- `Worker Beta` does not reply
- manager does not reply unless explicitly and actionably mentioned

### E2E-05 Team Thread Without Mention

Purpose:
- verify agents do not over-wake in team chat

Steps:
1. In the team thread send:
   - `Can someone check this later?`

Expected:
- no worker replies
- no manager reply by default

### E2E-06 Non-Actionable Agent Mention Does Not Wake

Purpose:
- verify anti-loop hardening for agent-to-agent chatter

Steps:
1. From one agent or by using a test bridge message, post:
   - `@Worker Alpha noted.`
2. Observe `Worker Alpha`.

Expected:
- `Worker Alpha` does not start a full turn
- no typing indicator from `Worker Alpha`
- no reply is sent

### E2E-07 Actionable Agent Delegation Wakes Exactly One Target

Purpose:
- verify useful agent-to-agent delegation still works

Steps:
1. In the team thread, from the manager or another agent, send:
   - `@Worker Beta please investigate TASK-XXXXXXXX and reply with a status update.`

Expected:
- only `Worker Beta` wakes
- `Worker Alpha` stays silent
- no ping-pong begins unless the reply intentionally re-mentions another agent with a real action request

### E2E-08 Direct Thread Ownership Guard

Purpose:
- verify a direct thread cannot be hijacked by mention alone

Steps:
1. Create or find a direct thread that belongs to another agent.
2. Send a message in that thread mentioning the wrong agent:
   - `@Worker Alpha can you jump in here?`

Expected:
- `Worker Alpha` does not wake unless that direct thread is actually owned by `Worker Alpha`
- no cross-thread hijack occurs

### E2E-09 Unsupported Sender Type Ignored

Purpose:
- verify system noise cannot wake agents

Steps:
1. Inject a test message through MCP with sender type `system` or another non-human/non-agent type.
2. Observe the targeted agent.

Expected:
- no local-brain turn starts
- no typing indicator
- no reply

### E2E-10 Long Turn Behavior

Purpose:
- verify streaming-like UX is represented by typing/progress instead of partial messages

Steps:
1. In a direct thread send:
   - `Think carefully for a while, then reply with exactly: LONG_OK`
2. Wait longer than the configured long-turn threshold.

Expected:
- typing starts quickly
- at most one progress message appears after the threshold
- no partial stream chunks are posted
- final reply is one clean message
- typing ends after final reply

### E2E-11 Manager Review Disabled By Default

Purpose:
- verify the manager does not post proactive reviews unless explicitly enabled

Steps:
1. Bootstrap a manager-profile agent with default settings.
2. Leave the system idle beyond the manager review interval.
3. Do not mention the manager in any thread.

Expected:
- no autonomous review post appears in team chat
- no proactive manager task chatter appears by default

### E2E-12 Repair Does Not Duplicate Bridge Processes

Purpose:
- verify repair is safe on fallback hosts, especially Windows

Steps:
1. Start with one healthy agent bridge running.
2. Run:
   ```bash
   openclaw emperor repair
   ```
3. Check running bridge processes for that companion directory.
4. Send one direct human message to the repaired agent.

Expected:
- exactly one live bridge process exists for that agent afterward
- only one reply is posted
- long-turn notice is not duplicated
- no doubled websocket/sync behavior appears

### E2E-13 Update Existing Install

Purpose:
- verify public update instructions work for real users

Steps:
1. Run:
   ```bash
   openclaw plugins update emperor-claw-os
   openclaw emperor repair
   ```
2. Re-run:
   ```bash
   openclaw emperor doctor
   ```
3. Repeat:
   - direct human thread test
   - team mention test
   - non-actionable mention test

Expected:
- updated bridge/runtime is active
- doctor remains green
- wake behavior remains correct after update

## Suggested Release Checklist

Before every public release:
1. Run `npm run build`
2. Run `node --check runtime/bridge.cjs`
3. Run `scripts/validate-local.sh`
4. Run E2E-03 through E2E-13 manually against a real Emperor host
5. Publish only if all pass criteria remain true

## Current Expected Defaults

These are the defaults this test plan assumes:
- team threads require explicit `@AgentName`
- direct threads require verified ownership
- unsupported sender types are ignored
- manager proactive review is disabled by default
- long-turn notice threshold is `20000ms`
- sync fallback interval is controlled by `EMPEROR_CLAW_SYNC_MS`

If any of those defaults change, this test plan should be updated in the same release.
