# Chat experience implementation — v0.39.0

The implementation follows [the experience plan](chat-experience-plan.md) and [the Hermes review](chat-interaction-review.md). It uses independent code with EmperorClaw's existing design system. It does not change the model/provider or claim that the web app has reached complete Hermes feature parity.

## What ships

- A shared native input backed by an editor-local external store. The transcript parent subscribes to empty/nonempty state rather than every character. Direct and team inputs grow to ten rem, preserve IME/mention behavior, and buffer draft persistence with lifecycle flushes. A failed send preserves newer text.
- Optimistic human messages use a client UUID as their stable virtual-row key. Acknowledgement maps the durable message to that same key. Failed sends can retry with the same scoped client identity; a database unique index prevents concurrent duplicate inserts. Replace controls retain their existing semantics and do not offer an unsafe automatic retry.
- Markdown history is memoized. Partial responses split completed paragraphs/code blocks from their growing tail, with bounded block count. Preview widgets, choices and images remain inert until the durable message arrives.
- A resize-aware, selection-aware live edge and a visible Jump to latest action. Direct-chat transcripts are cached in memory by viewer/agent/thread, capped at ten conversations, 200 messages each and one MB of text per conversation. Authorization failures clear the relevant cached transcript. Older-message loading retains the existing virtualizer anchoring.
- Bounded one-shot 180 ms message entrances, a subtle active-action shimmer, compact action counts, per-agent work disclosure in busy groups, static reduced-motion states, and an explicit reconnect label. Timers and active labels remain isolated from transcript rendering.
- Additive migration `0087_chat-experience`: a scoped client-message uniqueness index and a latest-preview table. It does not rewrite existing messages or append a row for each token.

## Enable and roll back

Chat UI improvements are on by default. Partial replies are opt-in while operators validate a canary deployment:

```dotenv
EMPEROR_CHAT_EXPERIENCE=1
EMPEROR_CHAT_EXPERIENCE_COMPANIES=
EMPEROR_CHAT_STREAMING=1
EMPEROR_CHAT_STREAMING_COMPANIES=<company UUIDs separated by commas>
```

An empty allow-list enables that feature for all companies when its master switch is enabled. `EMPEROR_CHAT_STREAMING=0` immediately stops accepting/reading previews after configuration restart; completed-message delivery continues. `EMPEROR_CHAT_EXPERIENCE=0` reverts enhanced input sizing and resize-follow/message-motion behavior; the safe editor isolation, draft handling and idempotent sends remain. Reduced motion is controlled by the person's OS/browser setting and removes continuous effects without losing labels.

Apply `npm run db:migrate` before starting a source installation. Docker applies migrations on startup. Update the Hermes host installer/bridge to 0.39.0; the server advertises `partial-replies-v1` only for enabled companies. Older bridges and servers keep completed replies. Do not roll back the additive migration to disable a feature.

A production canary still requires the deployment operator to update the app/runtime, enable the intended company UUIDs, observe live traffic and choose the expansion cohort. Local tests are not production canary evidence.

## Preview transport

The authenticated bridge posts cumulative segment snapshots at a 250 ms starting cadence to:

`POST /api/mcp/agents/runs/{runId}/responses?agentId={agentId}`

Body fields: `responseId` (UUID), `segmentIndex` (0–31), `revision` (positive integer), `text`, and `state` (`streaming`, `sealed`, `completed`, `interrupted`, `failed`, `capped`). Identity is derived from the authenticated run; the caller cannot supply another company/thread. A response UUID cannot be moved to another run or segment. Older/equal revisions are ignored, and a sealed/terminal preview cannot become streaming again.

The bridge derives response IDs deterministically from run and segment identity, coalesces delta bursts, seals interim segments and separately delivers the authoritative final reply through its existing outbox. Preview failure cannot fail a turn or delay durable reply delivery. The worker pool and pending segment state are bounded; unfinished work is cancelled at shutdown.

The server stores the latest accepted snapshot under a run-row lock, enforces 128 KiB UTF-8 per segment and 512 KiB aggregate per run, and emits an ID-only `chat_response_updated` notification. No partial reply text crosses PostgreSQL NOTIFY or the browser WebSocket.

The existing browser socket carries a scoped `response:{threadId}` invalidation, coalesced at 33 ms on this path. The isolated client tail refetches `GET /api/chat?...&previews=1`; this deliberately uses the normal current-session, agent-use and exact-thread access checks on every read. This is a security-conscious adjustment from the proposed direct-text WebSocket frame: it reuses cross-instance fanout and reauthorization without keeping a second raw-text authorization cache in the socket server. Ordinary transcript/dashboard subscribers do not refetch on each snapshot.

WebSocket failure uses a 1.5-second HTTP fallback while streaming is enabled; disabled companies use a 30-second capability recheck. Hidden tabs use the existing visibility-aware poller. A reconnected socket causes refetch/resync. There is only one fetch in flight per subscription, and stale thread responses are dropped. Final-message IDs reconcile saved replies and previews with stable virtual-row keys. Saved messages always win.

Preview reads are time-bounded. Rows expire 15 minutes after their last update; terminal run state is also visible to the client. Indexed cleanup occurs during ingestion and every five minutes in the custom server, including quiet periods. Runtime run-state/heartbeat handling remains the authority for lost/failed turns. Preview content is never logged or sent to analytics by this feature.

## Validation evidence

Local environment: macOS on this workstation, Node 26.4.0, Chromium through the installed Chrome channel, real PostgreSQL 16 in a disposable Docker container. Browser measurements used production builds, a 160-message formatted fixture, 306 input samples per build and an eight-ms synthetic typing interval. This is a repeatable development probe, not a cross-device capacity guarantee.

Initial input-to-next-animation-frame p95: v0.38.0 16.5 ms; new build 15.2 ms. No >50 ms long tasks were observed in either sample. This machine's baseline is already fast; the structural isolation matters more than that small timing difference. The shared input grew from 44 to 160 px in the multiline test. The browser probe confirmed pending feedback, same-key retry, authorized partial rendering and preservation of a scrolled-up reading position during growth.

The disposable storage/fanout load probe (`scripts/benchmark-chat-previews.ts`) writes eight cumulative snapshots per run at a 250 ms cadence and includes the scoped notification path. Results from this workstation:

| Active replies | Snapshots/s | Storage + notification p95 | WAL bytes during probe |
| --- | ---: | ---: | ---: |
| 1 | 4 | 15 ms | 12,408 |
| 10 | 40 | 33 ms | 123,592 |
| 50 | 200 | 103 ms | 622,840 |
| 100 | 399 | 139 ms | 1,257,168 |

These timings do not include upstream model latency, WAN latency, browser fanout across a production fleet or a sustained soak. Run the probe only on a disposable database ending in `_test` or `_bench`. It cleans its own company/user rows. Before broad rollout, repeat at deployment concurrency and inspect database/WAL, app CPU, network bytes, HTTP read amplification and end-to-end visible latency.

Automated coverage includes composer snapshots, preview byte/segment/revision limits, stable Markdown blocks, bridge coalescing and segment order, old-server fallback, transport failure isolation, cross-company/agent/private-owner authorization, terminal ingestion, expiry, concurrent human-send deduplication and conflicting retries. Browser regression coverage exercises growing input/IME, retry identity, reduced motion and preview-to-durable completion. Existing full suites remain part of the release gate.

## Operational limits

- Partial text remains best-effort and recoverable; the saved message is authoritative. A capped/expired/temporarily unavailable preview must not be interpreted as a failed final reply.
- A very large history beyond the bounded in-memory direct-chat cache can require loading older pages again. Cached text is never a substitute for a successful authorization check on opening the chat.
- The feature does not stream raw tool arguments/results, change reasoning visibility, or introduce end-to-end encryption. It uses existing transport/database protection and content handling.
- Production rollout metrics and recordings should contain timing/state information only. Do not collect prompts, reply text, credentials or personal tool arguments.
