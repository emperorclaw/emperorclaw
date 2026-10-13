# Lean agent context: index + on-demand knowledge

Status: proposed · Owner: Jose · Created: 2026-10-13

## Problem (measured)

On 2026-10-13, across 209 real Hermes turns (all on `deepseek-v4-flash`, 1M window):

- Input per turn: **p50 ≈188k tokens, p90 ≈398k, max 524k.**
- Cause 1 — history: Hermes compacted only at 50% of the window (524k). **Fixed by config** on all 9 profiles: `compression.threshold_tokens: 80000`, `proactive_prune_tokens: 48000`, `idle_compact_after_seconds: 1800` (see memory `hermes-context-bloat`).
- Cause 2 — **this plan**: what Emperor pushes into the prompt. A five-word question ("¿cuál es tu pc name?") travelled with a **27,469-char** prompt. That static block sits at the head of every session and Hermes pins the first messages (`protect_first_n: 3`), so it is paid **on every turn**, not once.

### What is in the prompt today

| Source | ~chars | When | Also available on demand? |
|---|---|---|---|
| `operating-guide.md` (bridge static block) | 10,900 | per session (pinned → every turn) | No |
| Static-block rules: lookup map, storage, messaging model | 4,800 | per session | No |
| Company Brain context (shared + "doctrine" notes, full bodies) | ≤6,000 (server default 12,000) | per session, **re-fetched every turn** to hash it | Yes (`/resources/{id}`) |
| Team roster, role instructions, memory (≤3,000) | variable | per session | Roster via `GET /agents` |
| Rich-reply guide (Hermes cuts to 1,600 of 5,500 — loses all block types) | 1,600 | per session | No |
| Dynamic block: open tasks, DM digest, group, org | 0.5–3k | every turn | Yes |
| Hermes system prompt: skills index (6.3 KB) + 24 tool schemas (44 KB) | ~66k bytes | every call | n/a (Hermes) |
| MCP server instructions (doctrine preamble + company context notes, no cap) | ~6,000+ | every MCP connect | partly |
| Hermes plugin skill `emperor-claw` `SKILL.md` | 32,500 on disk | **on demand** (index line only) | Yes |
| Codex bridge prompt (header, org, rich guide ≤8,000, message) | ~7,000 | **every turn** (no session resume) | n/a |

**The Emperor manual exists four times**: `operating-guide.md`, `BUILTIN_OPERATING_GUIDE`, the static block's rules, and the `emperor-claw` skill (whose lines 23-75 repeat the guide section by section) — plus a fifth flavour in the MCP instructions.

**Selection is not relevance-based**: `resourceContextPriority` ranks by name containing "operating"/"doctrine", scope and recency. Nothing looks at the message.

## Principle

> What is **standard** (how Emperor works) must always be *available*, never always *sent*.
> What is **company-specific** must be *discoverable* (an index), and *loaded* only when relevant.
> Only rules the agent must obey **without** making a tool call stay in the prompt.

## Design

### Tier 0 — Kernel (always, ≤1,500 chars, versioned with the server)
Identity, role, and the ~10 rules whose violation causes incidents we have actually seen, which must hold even if the agent never opens a document:
- Your reply is delivered to the current thread automatically; never `send_message` to answer it (duplicate posts).
- In team/group chats answer only when your @name is in the message; never write @all; a reply that answers your request closes it — no thanks/acks (loops).
- `approved` is the only go-ahead; `dismissed`/`expired`/`rejected` mean do not act (`mayProceed`).
- Emperor is the source of truth; never print secrets.
- Where to learn more: "Emperor manual: load skill `emperor-claw` (or MCP `get_emperor_manual`). Company knowledge: see index below; load a note with `get_knowledge_note`."

### Tier 1 — Index (per session, compact)
- **Knowledge index**: one line per eligible note — `title — one-line summary — id`, capped (e.g. 25 lines / 2,500 chars), ordered by scope + priority + recency (later: relevance to the thread). No bodies.
- **Roster**: `@alias — role` one line each (already compact; trim role to ~60 chars).
- **Reply formatting**: one line + pointer to the full guide.

### Tier 2 — On demand (tools)
- `get_emperor_manual(section?)` — the **single** Emperor manual, served by the server (one source, versioned with releases), sections addressable. The Hermes skill `emperor-claw` becomes a thin wrapper that tells the agent to fetch it (or embeds the same text generated at build time — one source either way).
- `get_knowledge_note(id | slug)` — full note, scope-checked, secrets excluded.
- `search_knowledge(query)` — name + content search returning index lines.
- `get_reply_format_guide()` — the full rich-reply guide (fixes today's truncation).

### Knowledge injection modes (replace the `isShared` boolean semantics)
Per note: `inject = always | index | on_request` + a `summary` (frontmatter `summary:` or auto-derived first sentence, ≤140 chars).
- `always` — small, critical company rules; **hard budget** (e.g. 1,500 chars total, UI shows the budget).
- `index` — appears in Tier 1; body on demand. **Default for existing shared notes, including "doctrine".**
- `on_request` — only via search/tags.
Migration: `isShared=true` → `index`; `isShared=false` → `on_request`. The UI toggle becomes a 3-way control with the budget meter.

### Codex parity
Codex today gets a ~7k prompt every turn with no Emperor tools. Give it the same Kernel + Index, and expose the Tier-2 tools through its existing API path (or MCP) so it can pull docs.

## Expected effect

- Static head: ~27,000 chars → **~4,000** (Kernel + index + roster). Because the head is pinned, that saves **~6k tokens on every turn** of every agent, on top of the compression fix.
- One manual instead of five copies → no drift, one place to fix behaviour.
- Company doctrine becomes discoverable instead of silently truncated at 6,000 chars.

## Risks and how we control them

- **Agents may skip reading a note they needed.** Mitigation: the Kernel keeps every rule tied to a past incident; the index line carries a real summary; measure with the run ledger + delivery verdicts (duplicate replies, loop_paused rate, approval violations, failed runs) before/after.
- **Rollout:** feature flag per agent `EMPEROR_CONTEXT_MODE=lean|full` (bridge env), pilot on one agent (SEO-Expert) for 3–5 days, compare metrics, then fleet.

## Phases (each a PR: OpenCode implements, fresh review, gates, release)

0. **Security fixes first (small, urgent):** `list_knowledge` returns full rows incl. `secret_text` (`src/lib/mcp-server/tools/knowledge.ts:38` spreads `listScopedResources` rows, which `select()` every column) → strip secrets, return index fields only. `get_knowledge_context` `resourceIds` and `GET /resources/{id}` skip the agent-scope check → enforce scope. `list_knowledge` search claims to search content but only matches names → fix or reword.
1. **Server:** `summary` + `inject` columns (migration), index builder, `get_emperor_manual` (single manual source, sections), `get_knowledge_note`, `search_knowledge`, `get_reply_format_guide`; MCP tools + REST for bridges; Knowledge UI 3-way control with budget.
2. **Hermes bridge:** Kernel + Index static block behind `EMPEROR_CONTEXT_MODE`; stop re-fetching the brain context every turn (fetch per session / on hash TTL); `emperor-claw` skill de-duplicated to the single manual; plugin tools for the Tier-2 endpoints; delete the duplicated rules from the static block.
3. **Codex bridge:** same Kernel + Index + tools.
4. **Pilot + measure** on one agent (run ledger: tokens/turn, failures, duplicates, loop pauses), then fleet rollout and default `lean`; installer sets the compression keys by default.
