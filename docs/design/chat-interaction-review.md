# Chat interaction review: Hermes desktop and EmperorClaw

Reviewed 2026-11-19 against the running local Hermes desktop app and its installed source. This is a code and interface audit, not a measured latency benchmark. No Hermes source was copied into EmperorClaw. The observations below identify mechanisms to reproduce independently within EmperorClaw's existing design.

## What makes Hermes feel more continuous

1. **Typing stays local.** Its composer uses a naturally growing editor, coalesces draft synchronization to animation frames, and synchronously flushes before submission or IME completion. Its source explicitly avoids a hidden autosizing input that caused layout work on every keystroke.
2. **Replies actually stream.** Incoming assistant and reasoning deltas are buffered. Text updates normally flush at 33 ms intervals; an adaptive ceiling of 250 ms leaves time for input during heavy work. Completed transcript rows are memoized, so new text does not require re-rendering every earlier response.
3. **Scrolling follows content growth.** The transcript maintains bottom-follow state, restores reading position per session, and handles delayed height changes after Markdown, images and tool cards render. Scrolling up gives control back to the reader.
4. **Work is visible in context.** Tool calls have their own rows and states. Completed activity groups collapse into summaries. A short gap between calls does not flash a new waiting indicator: an unnamed quiet interval earns its own indicator after two seconds. An already visible running tool narrates its own wait.
5. **A turn has continuity.** Text, tool calls and completion are parts of one response rather than separate disconnected status surfaces.

Hermes source references, relative to the installed desktop source:

- `src/app/chat/composer/index.tsx`: editor input batching and the hidden textarea layout-cost explanation.
- `src/app/session/hooks/use-message-stream/index.ts`: delta buffering and reconciliation.
- `src/app/session/hooks/use-message-stream/utils.ts`: 33 ms normal flush and 250 ms adaptive ceiling.
- `src/components/assistant-ui/thread/list.tsx`: memoized turn rows, live-tail treatment, restored scroll positions and resize handling.
- `src/components/assistant-ui/thread/turn-activity.ts`: quiet interval and suppression of duplicate wait indicators.

## EmperorClaw findings

### Typing work shares the transcript render

`src/components/agent-direct-chat.tsx` keeps `draft` beside messages, run state and virtual-row rendering. Each edit updates the parent and synchronously writes sessionStorage. `MarkdownRenderer` itself is not memoized, so unrelated composer updates can revisit expensive mounted Markdown trees. These are identifiable sources of unnecessary work; profiling is still needed to quantify their contribution on this Mac.

The direct-chat textarea has `rows={1}` and height bounds but no growing-input behavior. Longer drafts scroll inside the same small input instead of opening into a comfortable writing area. Preserve the existing native textarea semantics, IME handling, attachments, draft restoration and Enter/Shift+Enter behavior when improving it.

### Reply animation is not text streaming

`src/components/typing-reveal.tsx` first lays out the full formatted message invisibly, then overlays a growing plain-text string for 300–1500 ms. This can reserve a large blank bubble and changes from raw Markdown to formatted content at the end. It adds a presentation delay after the actual reply has already arrived.

The bridge's `EventMapper._on_delta` in `integrations/hermes/emperor-claw/bridge/emperor_bridge/events.py` records first-token timing but does not forward the assistant text. `message.interim` is ignored by that event mapper. Run events carry status and tool activity, not an assistant-text delta contract. Browser realtime currently invalidates and refetches the thread; polling is a fallback. Replacing polling alone would not provide real text streaming.

### Scroll anchoring exists, but bottom following is incomplete

Both direct and team chats already virtualize messages and compensate for size changes above the reader. Keep those protections. Their main bottom-scroll effect is keyed to a changed last-message ID. Growth in the current response, attachment load, expanded activity, or composer height is not itself a new message ID. Treat bottom-follow as explicit reader intent and respond to content/viewport resizing while that intent remains active.

### Activity is available, but visually detached

The run ledger and `LiveStatusRow` already provide current-step summaries, elapsed time and accessible announcements; the ticker is isolated from the transcript. `LiveRunSteps` provides a collapsed history, and replies have run footers. This is a useful foundation. Improve the presentation of the current tool and completion handoff rather than adding another spinner or replacing the ledger.

## Implementation order

### 1. Responsive composer and stable transcript

- Isolate draft changes from message-row rendering; memoize content using stable props.
- Preserve direct and team chat behavior, including mention selection and attachments.
- Grow the composer naturally to a bounded height without repeated hidden measurement layouts.
- Buffer persistence off the input hot path; flush on thread change, submission and page lifecycle events. Keep a current in-memory draft so navigation never restores stale text.
- Measure key-to-paint and React commits on a long transcript before and after the change.

### 2. Reader-controlled bottom following

- Follow growing content and composer resize only while the reader is at the live edge.
- Stop following immediately on explicit upward scroll or text selection.
- Keep a visible jump-to-latest control; never pull the reader down on a background poll.
- Preserve position when loading older messages and when switching chats.
- Verify deferred Markdown/image heights and virtualizer measurement updates do not create competing scroll adjustments.

### 3. Real partial replies end to end

- Add a scoped partial-response contract across gateway, bridge, server and browser. Scope every update to company, thread, agent, run and response segment; authorize subscriptions exactly like the saved transcript.
- Use stable response IDs and ordered sequence numbers. Reconcile the final saved message into the same visible row; do not append a duplicate when a poll races completion.
- Batch updates at a bounded cadence, keep completed Markdown blocks stable, and update only the active tail. Treat 33 ms as an initial benchmark to evaluate, not a copied universal setting.
- Keep stream state separate from the durable run audit ledger. Bound buffering, redact sensitive tool data and discard stale updates after thread switches or cancelled runs.
- Preserve the existing completed-message path for older runtimes and reconnect recovery. Remove the synthetic plain-text typing overlay when genuine partial text is available.

### 4. Calmer work visibility

- Give the current tool a compact, readable label and running/completed/failed state beside the response.
- Group completed work into expandable summaries with details on demand.
- Avoid duplicate elapsed indicators and transient waiting flashes between tools.
- Keep genuine approvals and questions distinct from agent progress.
- Preserve screen-reader announcements without announcing every token or timer tick; respect reduced motion.

## Acceptance checks

- Long direct and team transcripts stay responsive while typing, streaming and opening controls. Record input latency and mounted-row render counts; do not infer responsiveness from animation alone.
- Multiline drafts grow and shrink, survive thread switches and page reloads, and submit once with the correct final IME text.
- A partial reply retains its ID, formatting continuity and scroll position through finalization, reconnect and concurrent polling.
- Reading older messages or selecting text is never interrupted by an incoming response. Jump-to-latest restores following.
- Tool activity is visible during a run, concise after completion, and truthful on failure, cancellation and approval waits.
- Verify desktop and narrow mobile layouts, light/dark themes, reduced motion, keyboard-only use, attachments, network failure and older-runtime fallback.

This review does not claim measured speed improvements or Hermes parity. The first two phases can improve the existing web client; genuine streaming requires the full bridge/server/client path in phase three.
