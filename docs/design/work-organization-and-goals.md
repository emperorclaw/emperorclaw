# Work organization and persistent objectives

## Organization

A work team is an existing group conversation. Its optional coordinator can be a human or agent; membership is many-to-many. Coordination describes responsibility, not authorization. Project lead and approval rules remain authoritative. Avoid an exclusive department tree: it would misrepresent shared agents and break existing onboarding.

The dashboard uses team branches with their coordinator and members. Arrange teams exposes an agent palette: drag onto a team, or select and press Add here (keyboard and touch alternative). Adding never removes another membership. Coordinators are selected from actual members; existing human coordinators remain selectable. Full human membership management stays in the existing group editor. No new database table or migration is needed for this layer.

Group turns receive current-room purpose, bounded member names, coordinator and concise delegation rules. Direct turns receive a summary of at most four of the agent’s own teams and its role, under 900 characters, with complete membership available through existing tools. The complete membership is available through existing group tools. Do not inject the entire organization into every turn. Runtime access and message routing continue to enforce actual membership, not the text prompt.

## Persistent objectives

Hermes' native persistent goal engine is appropriate for one agent working on one objective. It is not a global company mission and does not automatically create work assignments. Do not forward `/goal` as ordinary language to an LLM: the current bridge invokes a quiet one-shot query with a contextual prefix, so a slash command embedded there is not a native goal invocation.

The bridge adapter uses Hermes' native GoalManager in the Hermes dependency environment and attaches decisions to the actual persisted session. Emperor intercepts the supported slash commands before constructing the model prompt. Feature-detect installed runtime support; older images must keep normal messaging working and explicitly report goals unavailable. Other runtimes require their own adapters and declared capabilities. Hermes ACP currently does not implement goals.

The UI is one optional Objective control in the agent dialog: objective text, optional completion criterion, a bounded turn limit, Start. An active objective exposes status, turns used, Pause, Resume and Clear in the same dialog. Do not add a second chat parser or a global mission panel. Full details live in the conversation.

Implemented safeguards:

- Persist objective state across bridge/container restart, scoped to company, agent and conversation/session.
- Use native done/continue/blocked decisions, not an unconditional repeat loop. Default at most 20 turns; account for ordinary user turns as well.
- Preserve native waiting/backoff behavior without repeatedly burning turns on a pending external process.
- Check company/agent budgets before each new turn; report usage for each turn, including continuation and judging where available.
- Stop/replace must interrupt the current process and pause continuation; a stopped goal must not silently restart after a container restart.
- Human pause/clear must take effect between tool calls using the existing runtime control channel. Status must not require another model call.
- A coordinator may delegate a task, but it does not automatically start goals in every member or gain permission to reset their budgets.
- Do not allow goals to bypass existing agent-to-agent loop guards, routing, project approvals or member access.
- Test completion, exhaustion, blocked/waiting states, judge failure, session migration/compression, restart recovery, unsupported runtime, concurrent pause and stop, and usage accounting with the actual supported Hermes build.

Native quality gates execute commands; retain the runtime's permissions and do not expose a general-purpose shell-command field in the initial web UI.

Reference: https://hermes-agent.nousresearch.com/docs/user-guide/features/goals

Supported commands: `/goal <objective>`, `/goal status`, `/goal show`, `/goal pause`, `/goal resume`, `/goal clear`, and `/goal -- <literal objective>`. Completion criteria use `verify:` and other native contract fields. Draft, gate and manual wait commands are explicitly rejected by the web command parser; the native judge can still park an objective. Other runtime adapters are not enabled until they support equivalent persistence and interruption.

Verification covers real PostgreSQL command isolation/cancellation/privacy, scheduler unit tests, mobile UI controls, and the current upstream GoalManager with a test database and mocked judge. A deployed Hermes container with live model credentials has not been exercised in this workspace. Reported usage remains an estimate for the execution model; auxiliary judge/provider billing is not a complete invoice measure.

Goal requests carry a reserved `runtimeControl: { action: "goal" }` marker as well as their goal payload. Older message-sync implementations already exclude runtime controls, and older kill/replace handlers ignore this unknown action, so a pending goal is not accidentally treated as a model prompt during a server/runtime downgrade.
