# Throne Display v2 — "A tiny living office"

Goal: a desk object people want after seeing it in a 15-second video. Zero learning curve: you glance at it, you never operate it. Every feature below must read on camera at arm's length on a 1.28" round screen.

## What changes for the viewer

1. **Agents look like they do on the web.** Same character model as `src/lib/character` (robot/human, variant, skin, hair, accessory), redrawn as pixel art at ~20x20 and scaled. Expressions: neutral, happy, focused, worried, sleepy, scanning.
2. **Agents act out what they are doing.** Feed activity kinds map to a pose + prop: typing (laptop glow), thinking (`...` bubble), reviewing (magnifier), talking (speech bubble), waiting-for-you (walks to the glass), blocked (worried + red `!`), celebrate (jump + confetti), coffee (mug, idle), nap (`z z`, idle), offline (ghost).
3. **Thought bubbles.** The working agent's latest real reasoning, typed out letter by letter in a bubble above its head.
4. **Handoffs fly.** When one agent @mentions another, a paper plane flies from sender to recipient.
5. **Task done = celebration.** Confetti burst + the crown flashes.
6. **Needs you.** Pending approval: an agent knocks on the glass, the outer ring pulses gold. Tap shows the request title.
7. **Director mode.** Auto-cycling "camera" for filming: wide room → zoom on the busiest agent → its thought → next event → back. Events (handoff, done, needs-you) interrupt the cycle.
8. **Camera-safe.** Thought and message text are scrambled into glyph "scribbles" and names show as roles, so a video never leaks client data. On by default in Director mode.

Existing modes (Feed, Focus, Pulse) stay; Throne becomes the new living office and Director is added.

## Work units

### WU1 — Server: live feed v2 (`/api/mcp/live`, `src/lib/live-feed.ts`)
Additive, backward compatible (old firmware ignores new keys; `v` bumps to 2).
- Per agent: `look` (compact character spec from `avatar_appearance`, same resolver the web uses), `act` (activity kind from `lib/team-scene.ts` mapping), `mood` (expression).
- Per agent: `thought` — latest reasoning snippet (≤140 chars) from `thread_message_reasoning`, only for messages in non-private threads (same masking rule as `activity`), secrets/URLs/emails redacted, `thoughtAgeSec`. Omitted when stale (>10 min).
- `events[]` — last ~10 events with stable ids and `ageSec`: `handoff{from,to}`, `task_done{agentId,title}`, `needs_you{agentId,title}`, `blocked{agentId}`.
- `needs[]` — top 3 pending approvals/requests `{agentId,title}`.
- Unit tests for mapping, redaction, privacy masking; integration test for the route shape.

### WU2 — Firmware: characters + acting (`devices/throne-display`)
- Port the web character model to a compact pixel renderer (`character.cpp`), driven by `look` + `mood`, with deterministic fallback from id hash when `look` is missing (old servers).
- Pose/prop overlays per `act`; idle routines (coffee, nap, stretch) on a per-agent seed.
- Parse new feed fields within the existing ArduinoJson filter and fixed buffers (no PSRAM).

### WU3 — Firmware: moments
- Thought bubble typewriter; paper-plane handoff; confetti + crown flash; needs-you knock + gold ring + tap for title. Event ids are de-duplicated so each plays once.

### WU4 — Firmware: Director mode + camera-safe
- New mode in the swipe cycle; scripted shot list with eased zoom; event interrupts.
- Camera-safe toggle (on by default in Director): scramble text, role labels. Toggle with a 1 s two-finger-free gesture: double-tap in Director; persisted in NVS.

### WU5 — Ship
- Bump `custom_fw_version` to 2.0.0, `npm run firmware:build`, publish images, README update, CHANGELOG, gates (tsc, unit, static, drift, integration in throwaway DB, CI), fresh review, tag release.
- Hardware check on a real board (needs the display plugged in over USB).

## Feed v2 contract (frozen — server and firmware both build against this)

`GET /api/mcp/live` keeps every v1 key unchanged and sets `"v": 2`. New keys (all optional for the client; a v1 server sends none of them):

Per agent (inside `agents[]`):
```jsonc
"look": { "k": "r",        // "r" robot | "h" human
          "u": 205,        // hue 0-359 (same as appearance.hue)
          "v": 2,          // variant 0-3
          "s": 1,          // skin index 0-5 (SKIN_TONES)
          "h": 9,          // hair: color = h % 8 (HAIR_COLORS), style = floor(h / 8) % 6
          "a": "g" },      // accessory: "-" none | "g" glasses | "h" headset | "c" cap | "b" bow
"act": "typing",           // typing|writing|reviewing|presenting|talking|thinking|waiting|blocked|celebrate|coffee|nap|stretch|offline|idle
"mood": "focused",         // neutral|happy|focused|worried|sleepy|scanning
"thought": "Checking whether the migration…", // optional, ≤140 chars, redacted; absent when none/stale/private
"thoughtAgeSec": 12        // optional, present with thought
```
The `look.h` packing mirrors how the web derives hair color/style from `appearance.hair` — the server must use the SAME math as `src/lib/character/draw.ts`; if draw.ts uses a different split, the server sends `h` = color index and adds `"hs"` = style index, and the firmware supports both.

Top level:
```jsonc
"events": [                // newest first, ≤10, from the last 10 minutes
  { "id": "evt-…",         // stable id (e.g. source row id + type) so the device plays each once
    "t": "handoff",        // handoff | task_done | needs_you | blocked
    "a": "<agentId>",      // actor
    "b": "<agentId>",      // handoff recipient (handoff only)
    "title": "≤56 chars",  // task_done / needs_you / blocked: task or request title
    "ageSec": 8 }
],
"needs": [ { "agentId": "…", "title": "≤56 chars" } ]   // ≤3 pending approvals/requests addressed to humans
```
Device JSON budget: the whole v2 payload for 24 agents, 8 messages, 10 events must stay under 12 KB.

## Constraints
- ESP32-C3, ~400 KB SRAM, no PSRAM, single core 160 MHz, no FPU: integer math, partial redraws or one 240x240 16-bit canvas at most, fixed buffers.
- Read-only token; the device never writes.
- Reasoning is raw model output: truncate, redact, respect private threads, and never send it when the display token has private chats off and the source thread is private.
