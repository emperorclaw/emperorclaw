# Emperor Claw — Page-by-Page UI/UX Audit & Redesign Plan

**Goal:** make the app **consistent, clean, and genuinely easy to use** — the kind of product a non-technical operator can open and understand in 30 seconds. Three things run through every task here:

1. **Plain vocabulary.** No insider jargon in the UI. "Control Plane", "telemetry", "artifacts", "dead_letter", "Project Brain", "scoped resources", "MCP endpoint" — these are engineer words. Operators think in "files", "notes", "alerts", "automations".
2. **Not "AI-looking".** The current aesthetic screams generated-dashboard: neon-cyan glow, uppercase letter-spaced micro-labels, `TASK-A1B2C3D4` monospace IDs everywhere, "load %" progress bars, pixel-art robot avatars, "Live" telemetry badges. Clean means calmer: real type hierarchy, one restrained accent, human labels, whitespace instead of glow.
3. **Hide the machinery.** This app exposes every internal concept it has — governance toggles, review buckets, recurrence lanes, importance taxonomies. Most users need maybe 30% of it. Hide or collapse the rest behind "Advanced", or remove it.

This plan is **page by page**. Each page gets: what it's for, what's confusing, vocabulary fixes, what to hide/simplify, and visual/consistency fixes. A separate `OPEN_SOURCE_PLAN.md` covers the engineering side (error states, security, storage) — this document is purely the design/usability layer. Where they overlap I note it.

> **Re-verify line numbers before editing** — they drift. All refs are from the audit snapshot.

---

## PART A — Global foundations (do these FIRST; every page depends on them)

These are the shared decisions. Fixing them once fixes the same problem on 15 pages.

### A1. Pick ONE design language and enforce it

Today there are **two tiers**: a polished design-system tier (`settings`, `artifacts`, `resources`, agent dialogs) that uses the shared `<Button>`, `sonner` toasts, and proper dialogs — and a **raw tier** (`dashboard`, `projects`, `customers`, `approvals`, `incidents`, `pipelines`) that hand-writes `<button className="rounded-full border border-cyan-400/40 bg-cyan-400/10…">` inline. Dozens of one-off button variants exist.

- **Adopt the shared `<Button>` (`src/components/ui/button.tsx`) everywhere.** Delete inline button markup. One primary, one secondary, one ghost, one destructive variant. Nothing else.
- **Kill the cyan/indigo split.** App is cyan; auth pages + two dialogs are indigo (`login/page.tsx:51-116`, `create-agent-dialog.tsx:77-103`, `globals.css:157-160`). Pick **one** accent and apply it to every page. Recommendation below (A2).
- Build a tiny shared kit so pages stop reinventing: `<PageHeader>`, `<StatCard>`, `<Card>`, `<Badge>`, `<EmptyState>`, `<ConfirmDialog>`, `<Drawer>`. Right now `SummaryCard`/`MetricCard`/`Chip`/`StatusDot` are re-implemented per file.

### A2. De-"AI" the visual style

The current look leans on tricks that read as machine-generated. Replace them with restraint:

| Current "AI tell" | Where | Replace with |
|---|---|---|
| Neon cyan glow + blurred radial accents | `KpiCard` glow blobs `page.tsx:312-313`, everywhere | Flat cards, subtle border, one accent used sparingly for primary actions/active state only |
| UPPERCASE letter-spaced micro-labels (`tracking-[0.24em]`) | every page header eyebrow, e.g. `page.tsx:198`, `projects-client.tsx:439` | Normal sentence-case section labels, or drop the eyebrow entirely |
| Monospace `TASK-A1B2C3D4` IDs shown to users | `page.tsx:103,388`, `projects-client.tsx:213,563` | Show the task **title**. Hide the ID (keep it in a "copy ID" affordance or the URL only) |
| Pixel-art robot avatars (DiceBear) | `page.tsx:365` | Simple initial-based avatars, or a clean neutral silhouette. Robots-as-avatars is the #1 "this is an AI product" signal |
| "load %" bars + "telemetry" + pulsing "Live" dots | `page.tsx:200,373-379`, chats "Live Feed" | "3 of 5 tasks" in words; drop "telemetry"; only show a live indicator when it's real and add a stale state |
| Grid-overlay hero panels (`emperor-subtle-grid`) | `page.tsx:196`, `projects-client.tsx:436` | A plain header. The sci-fi grid adds nothing |

Net effect target: it should look like a calm SaaS tool (think Linear/Height/Basecamp calm), not a "mission control" skin.

### A3. Vocabulary glossary — rename across the WHOLE app

Apply this as a find-and-replace pass over UI copy, nav, headings, and empty states. **Do not** rename database columns or API fields — UI strings only.

| Current UI term | Rename to | Notes |
|---|---|---|
| Control Plane | **Overview** (or drop; "Dashboard" already labels it) | `page.tsx:199`, `app-sidebar.tsx:53` |
| Workforce Health / telemetry | **Agent status** | `page.tsx:200,245` |
| Artifacts / Storage (as a feature) | **Files** | nav `app-sidebar.tsx:36`, everywhere. "Artifacts" is jargon |
| Knowledge & Rules / Scoped Resources | **Knowledge base** (or **Playbooks**) | nav `app-sidebar.tsx:30`. "Scoped resources" is DB-speak |
| Attention / Incidents | **Alerts** — pick ONE | Sidebar says "Attention", route is `/incidents`, H1 is "Needs Attention" (`app-sidebar.tsx:33`, `incidents/page.tsx:22`). Three names, one thing |
| Pipelines | **Automations** | nav `app-sidebar.tsx:29`. "Pipeline" is engineer-speak for "a thing that runs on a schedule" |
| Project Brain / Memory Timeline / "Teach Project New Context" / "Append Context" | **Project notes** / **Add note** | `projects-client.tsx:446,623,629,632,636` |
| dead_letter / failed exception lane | **Failed** | `projects-client.tsx:526`, `page.tsx` task states |
| canonical (artifact badge) | **Latest** (or **Primary**) | `projects-client.tsx:603` |
| MCP endpoint / MCP token | **API key** | settings, docs |
| Context Pack / RAG contract | drop from UI entirely | `pipelines-client.tsx`, jargon |
| Runtime / Runtimes | **Connections** (or **Workers**) | `settings-client.tsx:133`, ops |
| Task states raw (`inbox`, `in_progress`, `review`, `done`) | Inbox → **To do**, in_progress → **In progress**, review → **Needs review**, done → **Done** | already partly humanized; make it consistent |
| "requires human action", "Human / proof review" | "Needs your review" | `page.tsx:215`, `projects-client.tsx:518` |

### A4. One toast system, everywhere

Failures are currently invisible on the raw tier — they only `console.error` (`customers-client.tsx:42,61`, `approvals-client.tsx:98`, `incidents/incident-row.tsx:40`, `settings-client.tsx:75-107`, `projects-client.tsx:219`). **Every** create/update/delete must show a success or error toast (`sonner` is already installed and used on the good tier). This single fix removes most "did that work?" confusion.

### A5. One confirm + one drawer pattern

- **Destructive actions** go through a single styled `<ConfirmDialog>`. Today there are four patterns: styled type-to-confirm (`agents/delete-agent-dialog.tsx` — the gold standard), native `window.confirm()` (`projects-client.tsx:310,413`, `resources-client.tsx:306`, `pipelines-client.tsx:395`), and **no confirmation at all** (approvals reject, token revoke). Standardize on the styled dialog.
- **Side panels** (task detail, project notes) are hand-rolled `absolute` divs (`projects-client.tsx:561,619`) with fixed `w-[42%]`/`w-[45%]` that break on laptops/phones and have no Esc/focus handling. Build one `<Drawer>` (Radix Dialog under the hood) and use it everywhere.

### A6. Loading, empty, and error states (ties to OPEN_SOURCE_PLAN Phase 4)

- Add `error.tsx` + `not-found.tsx` (none exist — any error is a white screen).
- Make `loading.tsx` match the real layout (it currently uses the wrong colors/width, `loading.tsx:3,25`).
- One `<EmptyState>` component with icon + one-line explanation + a primary action. Empty states are inconsistent today: some rich, some bare ("No recent activity yet."), some missing.

---

## PART B — Page by page

Each page below assumes Part A is done. Ordered by nav.

### B1. Dashboard (`/`, `src/app/(app)/page.tsx`)

**For:** the first thing an operator sees — "what's happening right now."

- **Vocabulary:** "Control Plane" → drop (title it **Overview**). "active workforce telemetry" → "your agents and recent work" (`:200`). KPI labels: "Tasks In Inbox" → "To do", "Needs Review" → "Needs your review", "Needs Attention" → "Alerts" (`:213-216`).
- **De-AI:** remove the grid-overlay hero (`:196`) and the glow blobs on KPI cards (`:312-313`). Replace the "Live" trend badges (`:213-216`) — a static "Live" label on every card is meaningless noise; show a real number or nothing. Replace pixel-art avatars (`:365`) with initials.
- **Simplify "Workforce Health":** the `load %` bar + `Working on: TASK-a1b2c3d4 (research)` mono lines (`:373,388`) are engineer telemetry. Show "**Ada** — working on 2 tasks" in plain words, with a calm online/offline dot. Rename section to **Agent status**.
- **"Automation" card:** rename to **Automations**; the empty copy "Agents register recurring automation from their own runtimes" (`:269`) is incomprehensible to an operator — change to "No automations yet."
- **Consistency:** three KPI cards say "Live"; the activity feed uses `toLocaleTimeString` while other pages use other formats. Use one shared relative-time util ("2 min ago").
- **Keep:** Recent Activity and Team Channel are genuinely useful. Keep, just de-jargon the `kind` badges ("Storage" → "File", "Rules" → "Knowledge", "Attention" → "Alert", `:129,139,159`).

### B2. Projects (`/projects`, `projects-client.tsx`)

**For:** the work board — projects and their tasks from To-do → Done.

This is the **most over-engineered page** and the biggest ease-of-use win.

- **Vocabulary:** "Projects Board" is fine. Kill "Recurring definitions stay separated from spawned task work" (`:441`) — nobody speaks this. Kill the filter hint "Use agent filters only when a board has too much active work" (`:496`). "failed/dead-letter tasks" → "failed tasks" (`:526`).
- **Hide "Project Brain" behind plain language:** it's a notes feature dressed as sci-fi. Rename the button **Notes** (`:446`), panel title **Project notes** (`:623`), "Teach Project New Context" → "Add a note" (`:629`), "Append Context" → "Save" (`:632`), "Memory Timeline" → "Notes" (`:636`). Drop "The Brain stores critical cross-task knowledge" (`:637`).
- **Simplify the New/Edit Project form — this is critical.** It exposes **five governance toggles**: `requireApprovalForDone`, `requireReviewBeforeDone`, `commentRequiredForReview`, `blockStatusChangesWithPendingApproval`, `onlyLeadCanChangeStatus` (`:47-52`), plus `maxActiveAgents`. An operator creating a project should see **Goal, Customer, Lead** and nothing else. Move all five toggles under a collapsed **"Advanced rules"** section (default closed), or ship sensible defaults and hide them entirely for v1.
- **Simplify the Review column:** the four review buckets (Approval needed / Waiting review / Blocked / Ready to close, `:541-546`) are internal states. For most users, "Needs review (3)" is enough — collapse the bucket badges into an optional detail.
- **Hide the Recurring lane by default** (`:552`) — only show it if recurring tasks exist (it already conditionally renders, but the concept "Recurring definitions vs spawned tasks" needs to disappear from copy).
- **Task detail drawer:** stop showing `TASK-A1B2C3D4` as the header (`:563`) — show the task title. The numeric **Priority** field (`:594`) is power-user; hide under advanced. "Add Task Note / Send to Agent" (`:607`) → "Add a note". Fix the malformed class `bg-cyan-400/10/20` (`:622`, renders no background).
- **Fix silent failures:** `handleSendComment` (`:197`) and `handleAddProjectContext` (`:223`) only `console.error` — add toasts + pending states (per A4).
- **Consistency:** replace `window.confirm` archive (`:310,413`) with `<ConfirmDialog>`; the button says "Archive" but calls `DELETE` with no restore (`:314`) — either call it "Delete" or build real archive.

### B3. Automations (`/pipelines`, `pipelines-client.tsx`)

**For:** recurring jobs agents run on a schedule.

- **Vocabulary:** rename the whole feature **Automations** (nav + page). Remove "Context Pack / RAG contract" and "MCP" language from the UI (`:191,500`). "register recurring automation from their runtimes" → "Automations your agents run on a schedule."
- **De-AI / consistency:** the page wraps its own `min-h-screen bg-zinc-950` inside the app shell (`:411`) → double background; remove it. The 3-column grid has no mid-width breakpoint (`:431`) → cramped on laptops; add one.
- **Simplify:** if most companies have zero pipelines, lead with a strong empty state that explains what an automation is in one sentence, not a dense 3-pane console.
- **Fix:** Delete button has no pending/disabled state (`:480`, double-click risk); route delete through `<ConfirmDialog>` (`:395`).

### B4. Knowledge base (`/resources`, `resources-client.tsx`)

**For:** reusable knowledge/rules agents can pull into their work.

- **Vocabulary:** rename **Knowledge base** (or **Playbooks**). "Scoped Resources" / "resourceType" / "scopeType" are DB words — surface them as plain categories. Fix casing drift "shared"/"Shared", "draft"/"Draft / Needs review" in the same panel (`:410,411,453,479`).
- **This is a "good tier" page** (uses `<Button>`, aria labels) — it's the model. Mostly needs vocabulary + the lost-input guard (draft edits discarded by the 15s auto-refresh, `:409,420`).
- **Fix:** fixed-height panes `h-[calc(100vh-150px)]`/`h-[360px]` (`:317,438`) overflow short screens; make them flex.

### B5. Messages (`/messages`, `messaging-hub.tsx` + chat components)

**For:** talking to agents and the team.

- **De-AI:** drop the permanent pulsing "Live Feed" dot (`agent-team-chat.tsx:263`) unless it reflects a real connection; add a "reconnecting…" state (polls fail silently, `:175`).
- **Consistency:** the bespoke relative-time formatter here (`messaging-hub.tsx:38`) should become the shared util. Fixed `w-80` sidebar (`:80`) with no collapse breaks narrow screens.
- **Fix:** on send failure the draft is restored but no error shown (`agent-team-chat.tsx:227`) — add a toast. Add accessible names to the Send buttons (`:465`, none today).
- **Simplify:** hide raw internal terms ("thread", "channel" is fine; "MCP", "runtime" should not appear in chat UI).

### B6. Approvals (`/approvals`, `approvals-client.tsx`)

**For:** approve/reject things agents need a human to sign off.

- **HIGH ease-of-use + safety fix:** Approve/**Reject** fire instantly with **no confirmation** and the only feedback is `window.location.reload()` (`:96,159-184`). Reject is irreversible. Add `<ConfirmDialog>` on reject + success/error toasts. This is the scariest UX on the raw tier.
- **Vocabulary:** make the copy say plainly what approving/rejecting *does* ("The agent will continue" / "The agent will revise and resubmit"). The current "Please revise and resubmit" auto-message is fine but should be shown/editable before sending.
- **Consistency:** rebuild with shared `<Button>` + `<Card>`; add a real empty state ("Nothing waiting for approval").

### B7. Alerts (`/incidents` + `/attention`, `incidents/page.tsx`, `incident-row.tsx`)

**For:** things that went wrong and need a human.

- **Vocabulary:** settle on **Alerts** everywhere (sidebar "Attention", route `/incidents`, H1 "Needs Attention" — pick one, `app-sidebar.tsx:33`). Remove the redundant `/attention` → `/incidents` redirect route (`attention/page.tsx:6`) or make it the canonical one; don't keep both.
- **De-AI:** "Source: Watchdog", "severity - status" raw strings (`page.tsx:161,163`) → "Flagged automatically", "High priority · Open".
- **Fix:** row actions only `console.error` on failure (`incident-row.tsx:40`) — add toasts.

### B8. Agents (`/agents` + `/agents/[id]`, `agents-client.tsx`, agent dialogs)

**For:** the roster of agents and each agent's detail.

- **Mostly good tier** (create/delete dialogs are the gold standard). Keep the type-to-confirm delete as the model for A5.
- **Vocabulary:** "operator" default role, "register" (`page.tsx:123-124`) — say "added" not "registered". Intro copy `agents-client.tsx:52` likely leans on runtime/MCP jargon; simplify.
- **De-AI:** replace pixel-art avatars with initials/clean avatars (consistent with dashboard).
- **Fix:** `agents/[id]/page.tsx:42` redirects to `/agents` on an unknown ID — use `notFound()` so a bad link isn't a silent bounce.
- **De-personalize:** the settings/onboarding install strings reference `@malecu/...` (`settings-client.tsx:282`, `onboarding-tour.tsx:97`) — see OPEN_SOURCE_PLAN Phase 5.

### B9. Customers (`/customers`, `customers-client.tsx`)

**For:** the companies/clients projects belong to.

- **Vocabulary:** straightforward already. Fix the literal `\n` rendering in the notes placeholder (`:188` — single-quoted string shows `\n` verbatim).
- **Fix lost input:** customer notes live in local state with no unsaved-changes guard (`:186-191`); the global 15s `router.refresh()` wipes edits. Guard it or exclude editing views from auto-refresh (global issue, see C1).
- **Fix:** save/delete only `console.error` (`:42,61`) → toasts. Validation is a silent no-op (`:28`) → inline "Name is required."

### B10. Files (`/artifacts`, `artifacts-manager.tsx`)

**For:** files agents produced or you uploaded.

- **Vocabulary:** rename feature **Files** (nav + page). Drop the taxonomy jargon shown to users: "artifactClass", "importance", "canonical" badges (`projects-client.tsx:603`, and here). Most users want name, type, size, date, download. Move class/importance under an "Details" expander or remove.
- **Good tier** visually — keep the design, cut the vocabulary and the taxonomy noise.
- **Fix (from OPEN_SOURCE_PLAN):** downloads should force-download untrusted types; don't render the raw CDN URL.

### B11. Settings (`/settings`, `settings-client.tsx`)

**For:** workspace config + API keys.

- **Vocabulary:** "MCP token" → **API key** throughout. "Runtimes" stat is hardcoded to `2` (`:133`) — either wire it to real data or remove the stat.
- **Safety:** token **Revoke** has no confirmation (`:259`) — add `<ConfirmDialog>`. Failures only `console.error` (`:75-107`) → toasts.
- **Simplify:** group into clear sections (Workspace, API keys, Members). Hide advanced/rarely-used fields.

### B12. Ops (`/ops/*`, platform-admin only)

**For:** platform-admin internal tooling. Not customer-facing.

- **Lower priority** (admin-only). But since it ships in the repo: add pagination to `ops/companies`, `ops/users` (unbounded lists). Keep the utilitarian look — it's fine for an internal tool. Just don't let its jargon leak into the operator-facing pages.

### B13. Auth pages (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `src/app/(auth)/*`)

**For:** the first impression.

- **De-AI / consistency:** these are **indigo** while the app is cyan (`login/page.tsx:51-116`) — the very first screen doesn't match the product. Re-skin to the chosen accent.
- **Vocabulary:** keep it warm and human — "Welcome back", "Create your workspace." Avoid "Control Plane" here.
- These already use `required` on inputs (`login/page.tsx:75,92`) — good; extend that inline-validation habit to the in-app forms.

### B14. The fake `/tactics` page — DELETE

`src/app/tactics/page.tsx` is hardcoded fake data ("GitHub Enterprise Auth Flow", "Cloudflare Bypass Strategy"), `any`-typed (`:43`), with dead "Propose Tactic"/"View SOP" buttons (`:11,64`), reachable only by URL. It reads like real internal SOPs and must not ship. **Remove the route entirely.** (Also in OPEN_SOURCE_PLAN Phase 4.)

---

## PART C — Cross-cutting behaviors

### C1. Auto-refresh must stop eating edits
The global `AutoRefresh` runs `router.refresh()` every 15s (`layout.tsx:21`, `auto-refresh.tsx:10`). It silently discards unsaved input in customer notes, resource drafts, and dialogs, and fights the per-chat 5s polls. Options: pause auto-refresh while any form/drawer is dirty, or scope refresh to list views only. This is a top-3 "why did my text vanish" frustration.

### C2. Accessibility pass (also makes it feel finished)
`aria-label` appears only 14× app-wide. Every icon-only button needs a label (`projects-client.tsx:501,564,611,625`, `agent-team-chat.tsx:465`), and the collapsed sidebar nav (icon-only below `md`, `app-sidebar.tsx:74`) needs `title`/`aria-label`. Drawers need `role="dialog"` + focus trap + Esc (currently hand-rolled divs).

### C3. Real user identity in the sidebar
`app-sidebar.tsx:99-103` shows a hardcoded "Admin / owner / A" block. Wire it to the actual session user (name + initial). A fake user chip is an immediate "this is a demo" tell.

### C4. One date/number format
Ban ad-hoc `toLocaleTimeString`/`toLocaleString`/`toLocaleDateString` scattered per file. One `formatRelative()` + one `formatDate()` util, used everywhere.

---

## Suggested execution order

1. **Part A** (design system, accent, vocabulary glossary, toasts, confirm/drawer, states) — this is ~60% of the perceived improvement and unblocks every page.
2. **B14** delete `/tactics`, **B1** dashboard, **B2** projects — the highest-traffic, most-jargon pages.
3. **B6/B7/B11** approvals, alerts, settings — the safety-sensitive confirmations.
4. Remaining pages B3–B5, B8–B10, B13 — vocabulary + consistency sweep.
5. **Part C** cross-cutting behaviors + a11y.
6. **B12** ops last (internal).

## Definition of done

- A first-time operator can name what every nav item does without a glossary. No "artifact", "MCP", "dead_letter", "telemetry", "scoped resource", or "Control Plane" visible in the UI.
- One accent color, one button component, one card, one confirm dialog, one drawer, one date format — across all pages.
- No robot/pixel avatars, no fake "Live" badges, no monospace IDs shown as primary content, no sci-fi grid overlays.
- Every create/update/delete gives visible success/error feedback; every destructive action confirms first.
- New-project and settings forms show only the essentials; advanced options are collapsed or gone.
- No white screen on error; every list has a real empty state; no fake-data pages.
- Auth screens match the app; the sidebar shows the real user.
```