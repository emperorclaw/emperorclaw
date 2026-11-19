# Chat experience: full implementation plan

Status: ready for implementation review. Planning only; no product changes are included in this document.
Prepared: 2026-11-19. Baseline release: v0.38.0.
Related audit: [chat-interaction-review.md](chat-interaction-review.md).

## Outcome

Typing should feel immediate, sent messages should appear immediately, and an agent's response should develop continuously through thinking, tool use and text. Motion should make state changes easy to follow. The reader controls the viewport, and every running indication reflects an actual pending request or runtime event.

Cover direct chat, multiple chats with the same agent, team/group chat, mobile, light/dark themes, reduced motion, reconnects and older Hermes runtimes. Preserve EmperorClaw's visual identity, rich replies, attachments, mentions, approvals, queue/replace controls, private-chat boundaries and accessibility.

## What we learned from Hermes

The local source checkout identifies `NousResearch/hermes-agent` at commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. The running installed build and that checkout may differ; the source observations are anchored to the checkout rather than claimed as a runtime performance measurement.

- `apps/desktop/src/lib/use-enter-animation.ts`: one-shot, keyed message/tool entrances, 180 ms transform animation, reduced-motion support, and protection against replay on unrelated updates. It also documents why an opacity-zero backwards fill could strand content invisible in a paused window.
- `apps/desktop/src/components/assistant-ui/tool/fallback.tsx`: active tool titles/summaries use shimmer; completed work has a quieter presentation.
- `apps/desktop/src/app/chat/composer/index.tsx`: a naturally growing editor and frame-coalesced synchronization, with synchronous flushes on submit and IME completion. It avoids hidden textarea measurement on every key.
- `apps/desktop/src/app/session/hooks/use-message-stream/utils.ts`: normal text flushes at 33 ms; an adaptive ceiling of 250 ms reserves main-thread time under load.
- `apps/desktop/src/components/assistant-ui/thread/list.tsx`: memoized turns, bounded rendering and resize-aware scroll restoration. Live-edge following is deliberately instant rather than a spring chasing every token.
- `apps/desktop/src/components/assistant-ui/thread/turn-activity.ts`: a two-second quiet threshold and suppression of a second wait indicator when an active tool already explains the wait.

Repository source: https://github.com/NousResearch/hermes-agent/tree/d923a5eb487a17c0a68801bba9ef0f56c81040a8/apps/desktop/src

The checked local root license is MIT with Nous Research's copyright notice. Prefer independent implementations using these interaction principles. If implementation reuses substantial code, verify the relevant file/package license at that revision and retain its notice in the copied file or appropriate third-party notice. Check dependency licenses independently. No Hermes code has been copied as part of this plan.

## Product behavior

### Writing and sending

- A comfortable input grows from one line to a bounded writing area, then scrolls internally. It shrinks after send without shifting the transcript away from the live edge.
- Keystrokes update the editor independently of transcript rendering. Draft persistence is buffered and flushed on submit, blur, thread change and page lifecycle events.
- Enter submits, Shift+Enter inserts a newline, and IME confirmation never accidentally submits. Preserve mention selection and paste/attachment behavior.
- Submit immediately creates a local human-message row and clears the composer. Show a subtle sending receipt until the server acknowledges it.
- Failed sends retain a visible failed row with Retry and a recoverable draft. Retry uses the same client request ID. Do not overwrite newer text typed while the previous send was in flight.
- The editor remains usable while an agent works. Queue, replace and stop semantics remain explicit. Returning focus after send must not open the mobile keyboard unexpectedly.

### Watching a turn

A turn is a stable unit containing assistant text segments, activity and its final outcome. A tool can occur between two assistant segments. Segment order must come from the runtime, not arrival time in the browser.

| State | What the user sees | Exit condition |
| --- | --- | --- |
| Sending | Their message, subtle sending receipt | Server acknowledgement or send failure |
| Queued | Queue label and position only when known | Run starts, cancellation, or refusal |
| Starting | Immediate acknowledgement that the accepted turn is starting | First activity or explicit failure |
| Thinking / quiet gap | A small active marker; descriptive label after a short quiet gap | Text, tool, approval or terminal event |
| Tool preparing / running | Current action label, discreet active treatment, optional elapsed time | Tool result or interruption |
| Responding | Actual partial formatted text in a stable row | Next segment or final response |
| Waiting for approval / answer | Clear request requiring the person's action | Answer, refusal, expiry or cancellation |
| Reconnecting | Connection state; last known content remains visible | Resync or explicit failure |
| Completed | Settled reply and compact expandable work summary | A new user turn |
| Failed / interrupted | Truthful outcome, preserved useful partial content, recovery action | Retry or a new turn |

Activity labels are human-readable (for example, “Searching files” or “Running tests”) with a safe fallback for unknown tools. Details expose redacted summaries already permitted by the run ledger, never raw credentials or unrestricted arguments. Raw reasoning remains governed by the existing disclosure policy; new animation does not expand what is visible.

A quiet gap inside a live turn earns a descriptive waiting label after about two seconds. A newly accepted send has immediate feedback, so this threshold never makes submit appear unresponsive. An active tool narrates its own wait; do not add a second competing spinner. Disconnect and stale-heartbeat states must replace an unsupported impression of continuing progress. A slow operation is not automatically a failed operation.

### Reading and navigation

- Auto-follow only when the reader is at the live edge or explicitly chooses Jump to latest.
- Follow content and composer resizing, including delayed images, Markdown and tool disclosures.
- Scrolling up, selecting text or navigating older messages suspends automatic following. A new-message indicator gives a route back.
- Save reading position per thread. Opening a different thread restores its position before an obvious jump can paint.
- Older-message prepends preserve the visible anchor. New activity in another chat updates that chat's badge without moving the current viewport.

## Motion specification

These are initial design tokens to validate in the browser, not measured properties of the installed Hermes build. Reuse EmperorClaw's motion helpers and semantic theme tokens; tune chat-specific timing without changing the whole application.

| Interaction | Initial motion | Constraints |
| --- | --- | --- |
| Button press / send | 80–120 ms state feedback; small icon transition | No hit-area or focus-ring movement; feedback within 100 ms |
| Human-message arrival | 160–200 ms, opacity plus 4–6 px rise | Once per client message identity; acknowledgement keeps the same row |
| Agent segment arrival | 160–200 ms, small rise | Animate the segment once; never every token or poll |
| Running action | Low-contrast shimmer on the label or a small active glyph | One primary continuous motion per active visible turn; stop on settle/disconnect |
| Step changes | 120–180 ms label transition in a stable footprint | Preserve readable previous/new text; do not remount the whole activity row |
| Tool completion | 120–180 ms running glyph to success/failure icon | Outcome remains recognizable without animation or color |
| Work-summary disclosure | 180–240 ms coordinated expansion | Update scroll anchoring with actual layout; no whole-transcript layout animation |
| Composer growth | Native growth with no per-key tween | No hidden measurement tree or repeated forced synchronous layouts |
| Jump to latest | 180–240 ms user-triggered scroll when appropriate | Streaming follow is immediate/coalesced; never restart a smooth scroll per token |
| Chat opening | Short fade/rise on the newly visible surface | Do not stagger the entire history or replay after virtualization |
| New-message badge | 120–160 ms enter/exit | Keep it away from the composer and safe-area controls |

Reduced motion removes translation, scale, shimmer and continuous motion. Use static active glyphs and readable status changes; an optional brief opacity change must not hide content. Content must remain visible if the tab is backgrounded, a frame is cancelled, or an animation never starts. Animation registries are bounded and scoped so one user's chat history is not retained indefinitely in memory. History hydration, poll reconciliation and virtualized remounts must not replay arrival effects.

## Client architecture

Extract shared primitives incrementally; retain direct/team-specific orchestration until contracts are stable.

Proposed modules:

- `src/components/chat/chat-composer.tsx`: isolated editor, controlled imperative submit/restore boundary, attachment slots and mention adapter.
- `src/components/chat/chat-message-row.tsx`: memoized row with stable message and run references.
- `src/components/chat/chat-turn.tsx`: ordered response segments, tool groups and terminal outcome.
- `src/components/chat/chat-activity.tsx`: current action, explicit wait/reconnect/approval state and accessible announcements.
- `src/lib/chat/use-chat-scroll.ts`: follow intent, prepend anchor, per-thread restoration and resize handling.
- `src/lib/chat/stream-reducer.ts`: ordered snapshot reconciliation and final-message handoff, independent of React.
- `src/lib/chat/use-chat-stream.ts`: transport subscription, bounded UI flush scheduling and lifecycle cleanup.
- `src/lib/chat/motion.ts`: keyed one-shot entrances and chat-specific motion tokens using existing helpers.

Names are proposed; adapt to repository conventions during implementation. Begin by memoizing `MarkdownRenderer` and the stable row boundary. A component extraction alone does not isolate typing: ownership of draft updates must move, and transcript props must retain identity on unrelated updates.

Keep the native textarea unless profiling proves it insufficient. Evaluate native CSS content sizing with feature detection and a bounded fallback; do not adopt contentEditable solely to imitate Hermes. Preserve native editing, accessibility and IME behavior.

## Real partial-response contract

### Identity and authorization

Use the existing run and thread identities. Each response segment has a stable `responseId`, run-local `segmentIndex`, monotonically increasing `revision`, and terminal state. All records carry company, thread, agent and run ownership resolved by the server. The bridge cannot assign itself a different audience.

Capability-negotiate `partial-replies-v1`. Old bridges keep the completed-message path. Keep assistant partial text separate from the durable run audit events; do not turn every token into an audit record.

Proposed bridge endpoint: `POST /api/mcp/agents/runs/[id]/responses`, accepting bounded cumulative segment snapshots. Proposed browser frame: `chat.response.snapshot`, carrying authorized segment state. Finalization points to the durable message ID. Endpoint names and schemas must be added to the protocol design and contract tests together.

Initial snapshot envelope:

```typescript
{
  responseId: string;
  segmentIndex: number;
  revision: number;
  text: string; // cumulative for this segment, not raw tool output
  state: 'streaming' | 'sealed' | 'completed' | 'interrupted' | 'failed';
  finalMessageId?: string;
}
```

Run/thread/company/agent are supplied or verified from the authenticated route context. Cumulative snapshots make duplicates and missed frames recoverable: accept only a higher revision; never regress terminal state. A changed final response remains authoritative even if it differs from the partial prefix. Multiple segments are legitimate, and interrupted/retried runs have separate identities.

### Initial transport and retention decision

Extend the existing authenticated browser WebSocket, using the current PostgreSQL fanout mechanism. Avoid a second per-chat connection and avoid provisioning a new broker for the first release.

- Bridge coalesces cumulative text at a starting cadence of 250 ms, plus immediate segment/terminal flushes. Do not POST per token. Preserve bounded retries and backpressure; final-message delivery remains higher priority than preview delivery.
- Store only the latest preview per segment with a conditional revision update. No append-only token table. Publish a small notification identifying the committed revision; PostgreSQL NOTIFY must not carry the reply text or exceed its payload budget.
- WebSocket servers fetch/cache the committed preview and deliver it to authorized viewers. Coalesce invalidations for the same response. Cap global and per-user buffering, and drop superseded previews for slow clients.
- Browser renders the newest snapshot at an initial 33 ms flush target, adapting up to 250 ms under load. This is a rendering budget, not a claim of 33 ms network delivery. Do not introduce fake typing delay to conceal transport cadence.
- Resync current previews plus durable messages after reconnect, version mismatch or notification loss. Terminal messages replace the same response row using `finalMessageId`; a concurrent poll cannot create a duplicate.
- Start with a 128 KiB UTF-8 preview ceiling per segment and an aggregate ceiling per run. Stop extending the preview safely when capped, indicate final content is still pending, and deliver the complete response via the existing message path.
- Preview rows expire after a bounded reconnect window (initially 15 minutes after terminal state); abandoned previews expire based on heartbeat/run state. Cleanup is automatic and indexed. Do not duplicate preview text into logs, analytics or error traces. Preserve existing database protection and retention controls; no claim of end-to-end encryption is introduced.

Before committing to the storage cadence, benchmark at 1, 10, 50 and 100 simultaneous active replies. At 100 replies this design can produce about 400 snapshot writes/second before segment transitions, so measure write amplification, WAL, notification fanout, CPU, read amplification and latency. If the deployment budget is exceeded, increase coalescing and/or introduce an ephemeral broker behind the same protocol before broad rollout. Do not ship an unbounded in-process-only design that fails across app instances.

### Security requirements

Reuse `humanSocketReceives`, subject/audience scopes and thread authorization, and add stream-specific tests. Socket authentication at upgrade alone is insufficient: revoke delivery after logout, session revocation, permission changes or thread membership changes. Enforce the same current authorization on preview reads and resync.

Test owner-private direct chats against admins, unrelated members, other agents and other companies. Do not broaden private-thread access to match a role assumption. Group replies reach only viewers who can read that group. The originating private thread must survive queueing, tool segments, retry, reconnect and finalization.

Preserve safe Markdown/widget/link rules. A partial code fence, HTML fragment, rich widget or choices block must not become an executable/interactable incomplete object. Reveal complex blocks only when valid/closed; render safe ordinary text around them. Do not stream raw tool output or secrets into the assistant-text channel. Redaction and existing content policies apply before previews cross the boundary.

## Delivery sequence and review gates

| Change set | Scope | Required evidence before the next dependent step |
| --- | --- | --- |
| 1. Baseline and fixtures | Repeatable long-chat, rich-message, multi-agent and mobile scenarios; React and browser traces | Record key-to-paint, render counts, layout cost, send acknowledgement and scroll behavior |
| 2. Composer and row isolation | Shared composer boundary, growing input, stable row/Markdown rendering, safe draft flush; scoped client-message idempotency in the existing send API with additive uniqueness migration | Typing, IME, mentions, attachments, switching, restoration and send-failure browser checks |
| 3. Scroll controller | Explicit follow intent, resize handling, per-thread restoration, prepend anchoring | No viewport theft or visible restore jump in delayed-content fixtures |
| 4. Turn/activity model and motion | State reducer, compact current action, grouped work, keyed motion and reduced motion | Full synthetic lifecycle including waiting, failure and cancellation; screenshots plus interaction verification |
| 5. Protocol and server | Preview schema/migration, revision rules, authorized reads/fanout, retention and load harness | Cross-company/private/group isolation, concurrent updates, multi-instance recovery, bounded storage and load results |
| 6. Bridge integration | Capability negotiation, snapshot coalescing, segment ordering, terminal handoff | Real pinned-Hermes contract tests and installer tests; old bridge behavior unchanged |
| 7. Client streaming | Stream reducer/subscription, stable Markdown tail, same-row finalization, fallback | End-to-end real agent run plus duplicate/reorder/reconnect/cancel/poll-race cases |
| 8. Rollout and release | Flags, docs, observability, app/bridge versions, release notes and images | All CI green, canary evidence, public images/assets verified, rollback exercised |

Dependency order: 1 → 2 → 3 → 4 for the client foundation; 5 → 6 → 7 for streaming, with 7 relying on 2–4. Finish all gates in 8 before enabling partial replies broadly. Keep change sets reviewable instead of rewriting both large chat components and the protocol in one patch.

## Performance and functional acceptance

Targets are initial acceptance budgets, not current measured results. Record the test machine, browser, build, fixture and throttling settings with results.

- Desktop key-to-next-paint p95 ≤ 50 ms; mobile/CPU-throttled p95 ≤ 100 ms. No transcript Markdown render on an ordinary draft-only keystroke.
- Send acknowledgement appears locally within 100 ms. Server failure remains truthful and recoverable; repeated retry produces one durable human message through a scoped idempotency key and uniqueness enforcement.
- Visible partial updates reach the browser within p95 500 ms of bridge receipt under the agreed load fixture, excluding upstream model latency. Track model first token separately from app transport and paint latency.
- Typical active UI work remains within a 16.7 ms frame budget; investigate every repeatable >50 ms main-thread task during typing/streaming. Do not claim smoothness from average FPS alone.
- Completed rows do not reparse on each partial update. Memory and preview storage stay bounded during a sustained run and repeated chat switching.
- Scroll-up and selection are never overridden by streaming. Prepend/resync preserves the visible anchor within a small documented tolerance; jump-to-latest restores following.
- No duplicate or reordered assistant segments after finalization, reconnect, retry, cancellation or poll races. Terminal status is monotonic.
- No animation replay on poll, history load, virtualized remount or thread return. No invisible content in background/foreground tests. Reduced motion removes continuous motion and movement without losing state information.
- Verify keyboard-only operation, screen-reader status announcements, 200% text zoom, high contrast where available, narrow mobile portrait/landscape, light/dark themes and slow/offline networks.

## Verification matrix

Use pure reducer tests for identity/revisions/terminal transitions, database integration tests for ownership/idempotency/expiry, and browser tests for actual interaction and rendering. Add protocol fixtures shared in meaning across Python and TypeScript. Avoid tests that merely match CSS class names.

Mandatory scenarios: direct main/extra/archived chat; two simultaneous private chats with one agent; group with multiple active agents; hidden tab resumes; server restarts; two app instances; WebSocket blocked with HTTP fallback; duplicate/out-of-order snapshots; final before preview; partial/final text mismatch; missing terminal event; expired/revoked session; permission or membership changes; large Unicode text; incomplete Markdown/code/table/widget; image sizing; upload failure; mention Enter/IME; queue/replace/stop; tool failure; approval expiry; interrupted turn with useful partial content.

Use the existing static/unit/integration/e2e suites and Hermes image/installer gates. Include desktop and mobile recordings of typing, sending, tool transitions, scrolling away and completion so the motion can be assessed, not just inferred from screenshots.

## Rollout, observability and rollback

- Ship client foundation and motion behind a company-level chat-experience flag, plus an independent server/bridge partial-replies capability flag. Defaults remain conservative until canary checks pass. Feature flags are server-evaluated and do not weaken authorization.
- Enable internal/test companies first; then a small production cohort; then expand after agreed latency/error/privacy gates pass. Document who can enable each flag and how to disable it.
- Metrics: input/paint latency sampled without text; preview accepted/dropped/capped counts; revision gaps; coalescing delay; snapshot writes; buffer size; reconnect/resync; finalization duplicates; scroll-follow interruptions; unexpected long-running state. No prompts, replies, authentication tokens, credentials or personal tool arguments in telemetry. Token-usage counts may remain in the existing usage metrics.
- If streaming degrades, disable previews independently and immediately use the durable completed-message path. Preserve already saved messages and drafts. Do not require a destructive migration rollback.
- Additive migration only. A release that changes the bridge needs synchronized bridge version, manifest, installer, image labels, compatibility constants, fixtures and release assets. Verify old/new server-runtime combinations and publish both app/runtime images before advertising availability.
- Update user docs with the new activity/connection states, queue/replace/stop behavior and reduced-motion behavior. Update protocol and architecture docs with the contract, limits, cleanup and recovery rules.

## Scope decisions

- Keep EmperorClaw's theme and existing design system; learn interaction mechanics from Hermes.
- Keep a native editor initially; contentEditable is an evidence-driven later choice.
- Preserve existing rich outputs, private routing, security controls and run ledger. Tool activity summaries must remain truthful.
- No model/provider migration, SSO, unrelated dashboard redesign, voice redesign or new infrastructure provisioning is part of this work.
- Planning ends here. Implementation begins with baseline measurements and the composer/row boundary, followed by the ordered change sets above.
