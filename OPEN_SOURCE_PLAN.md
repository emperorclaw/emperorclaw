# Emperor Claw — Open-Source Readiness Plan

**Audience:** an implementing agent (or engineer) taking Emperor Claw from a private, single-tenant hosted app (`emperorclaw.malecu.eu`) to a self-hostable, open-source project that anyone can `git clone` and run locally — with a **local filesystem storage option** instead of Bunny CDN, an **easy install**, and a codebase that doesn't embarrass the author when it hits the front page.

**How to use this document:** work top-to-bottom. Phase 0 is a hard security gate — **do not make the repo public until Phase 0 is 100% complete.** Phases 1–2 make it actually installable and are the core of the "opensource it to run locally" ask. Phases 3–6 are the polish that makes it a *good* open-source project rather than a dump. Each task lists concrete files with line references (from an audit of the repo at the time of writing — re-verify line numbers before editing, they drift).

**Do NOT start coding features before Phase 0.** Secrets are already in git history.

---

## Snapshot: what Emperor Claw is (so you have context)

- **Stack:** Next.js 16 (App Router) on a **custom `server.ts`** (not `next dev` — it attaches a WebSocket server for `/api/mcp/ws`), React 19, TypeScript, PostgreSQL + Drizzle ORM, NextAuth v4 (Credentials + argon2), Tailwind 4 + shadcn, `sonner` toasts.
- **Realtime:** WebSocket fanout over Postgres `LISTEN/NOTIFY` on channel `mcp_events` (`server.ts`, `src/lib/pubsub.ts`).
- **Background jobs:** a watchdog + lifecycle monitor auto-started from `src/instrumentation.ts`, guarded by a **Postgres advisory lock** (`20261010`). **This means the app assumes a single long-running Node process** — it cannot run serverless/multi-region without shared-state rework.
- **Two API surfaces:** `/api/ui/*` (browser, session-cookie auth) and `/api/mcp/*` (agent-facing, bearer-token auth). MCP tokens are **company-scoped**, not agent-scoped.
- **Storage:** a clean `StorageAdapter` interface (`src/lib/storage/types.ts`) with exactly **one** implementation — `BunnyStorageAdapter`. The factory `getStorageAdapter()` hardcodes it. This is the seam we exploit for local storage.
- **Deploy today:** single Ubuntu VPS, PM2 + nginx, GitHub Actions rsync. No Docker, no `.env.example`.

---

# PHASE 0 — Security gate (BLOCKING — do this before anything is public)

> Everything here must be done **before** the repo is pushed to a public remote. Several secrets are **already committed to git history**, so removing them from the working tree is not enough — they must be rotated *and* the history scrubbed.

## 0.1 — Rotate every leaked credential (do this FIRST, in the real world, not in code)

These are live secrets found committed or on-disk. **Assume all are compromised the moment the repo goes public.** Rotate them at the source before touching the repo:

| Secret | Where it leaked | Action |
|---|---|---|
| Bunny Storage AccessKey `35f0a738-…-295b-4254`, zone `emperor1` | `scripts/_bunny_purge_all.py` (untracked, on disk) | Regenerate the Bunny storage-zone password/key |
| VPS root password `VPS_PASSWORD_REDACTED`, IP `VPS_IP_REDACTED` | `check-remote-db.sh`, `migrate-remote-db.sh`, `run_ssh.exp`, `db-tunnel.sh` (tracked) | Change VPS root password; ideally disable root SSH password auth entirely |
| Pi password `PI_PASSWORD_REDACTED`, IP `PI_IP_REDACTED` | `scripts/deploy-hermes-plugin.py`, `scripts/setup-malecu-ops.py`, `scripts/_pi_*.py` | Change Pi password |
| SMTP password `SMTP_PASSWORD_REDACTED` (`no-reply@malecu.eu` @ migadu) | `src/lib/email.ts:9` (tracked, hardcoded default) | Rotate Migadu mailbox password |
| Real user creds `user@example.com` / `USER_PASSWORD_REDACTED` | `docs/v1.1/usage.md:49,78,83-84` (tracked) | Change that account's password |

**Do not proceed to 0.2 until rotation is done** — scrubbing history first would just tell attackers exactly which secrets to grab from a fork/cache in the window before you rotate.

## 0.2 — Remove secrets from the working tree

Delete or scrub every file carrying a hardcoded secret or internal host. These are **ops/personal scripts that do not belong in the product repo at all** — delete them:

- `scripts/_bunny_purge_all.py`, `scripts/_bunny_purge_prod.py` (untracked)
- `scripts/_pi_run_cleanup.py`, `scripts/_pi_cleanup_storage.py`, `scripts/_pi_folder_test.py` (untracked)
- `_vps_diag.py` (untracked, repo root)
- `check-remote-db.sh`, `scripts/check-remote-db.sh`
- `migrate-remote-db.sh`, `scripts/migrate-remote-db.sh`
- `db-tunnel.sh`, `scripts/db-tunnel.sh` (and the `db:tunnel` npm script, `package.json:23`)
- `run_ssh.exp`, `scripts/run_ssh.exp`
- `scripts/deploy-hermes-plugin.py`, `scripts/setup-malecu-ops.py`, `scripts/deploy-vps.py` (and `deploy:vps` script, `package.json:14`)

Scrub in-place (keep the file, remove the secret):
- `src/lib/email.ts:8-10` — remove the hardcoded SMTP user/password/from defaults; require them from env, and if unset, disable email sending with a clear log line (not a silent fallback to someone else's mailbox).
- `docs/v1.1/usage.md:49,78,83-84` — replace real creds with `you@example.com` / `<your-password>`.
- `src/lib/env.ts:48` — remove the `https://emperorclaw.malecu.eu` production fallback; default to `http://localhost:3000` or throw if `APP_URL`/`NEXTAUTH_URL` is required.

Also purge personal absolute paths (`/home/jose/…`, `/var/www/emperorclaw`, `~/.hermes/…`) from `docs/v1.1/configuration.md:28-29,63-64,70-71`, `integrations/hermes/**/SKILL.md`, `clawhub/**/bridge.{js,cjs}`, and `docs/v1.1/overview.md:54`.

## 0.3 — Scrub git history

After 0.1 + 0.2, the tracked secrets are still in history. Use `git filter-repo` (preferred) or BFG to purge the blob content of the tracked secret files across all commits. Then **force-push to a fresh public repo**, or better, **start a new repo from a squashed clean root commit** — for a first open-source release, a single clean initial commit is the safest option and sidesteps history-rewrite fragility entirely.

**Verification (do not skip):** after scrubbing, run a secret scanner over the full history — `gitleaks detect --source . --log-opts="--all"` or `trufflehog git file://.` — and grep history for each rotated value, the strings `malecu`, `VPS_IP_REDACTED`, `PI_IP_REDACTED`, `/home/jose`, and `smtp.migadu`. Zero hits required before public.

## 0.4 — `.gitignore` + `.env.example` (prevent re-leak)

- Confirm `.gitignore` covers `.env*` (it does, `:34`), `graphify-out/`, `.claude/`, `.venv/`, `.tmp-openclaw/`, `.next/`, `node_modules/`, and the ops-artifact trees.
- Add **`.env.example`** (see Phase 1.1) — this is the single most important missing file for installability.

## 0.5 — License + copyright

- `LICENSE` is MIT but reads `Copyright (c) 2024-2026 Malecu OU`. Decide: keep MIT (fine for OSS) but update the copyright holder line to your chosen public identity, or relicense deliberately. **This is a decision for the owner — flag it, don't guess.**

---

# PHASE 1 — Make it installable (the core "run locally" ask)

## 1.1 — `.env.example` (the keystone deliverable)

There is **no** env template today; a stranger cannot start the app. Create `.env.example` documenting every variable, grouped, with safe local defaults and inline comments. Derived from source usage:

```bash
# --- Core (required) ---
POSTGRES_CONNECTION_STRING=postgres://emperor:emperor@localhost:5432/emperor
APP_URL=http://localhost:3000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=            # generate: openssl rand -base64 32
PORT=3000

# --- Storage (choose ONE backend) ---
STORAGE_BACKEND=local       # local | bunny   (see Phase 2)
# local backend:
STORAGE_LOCAL_DIR=./.data/storage
# bunny backend (only if STORAGE_BACKEND=bunny):
BUNNY_STORAGE_ZONE=
BUNNY_STORAGE_ACCESS_KEY=
BUNNY_STORAGE_REGION=       # optional, e.g. frankfurt
BUNNY_STORAGE_HOST=         # optional, overrides region
BUNNY_STORAGE_PULL_ZONE_URL=  # optional public CDN base

# --- Secrets encryption (required for integrations) ---
EMPEROR_CLAW_MASTER_KEY=    # generate: openssl rand -hex 32

# --- Email (optional; sending disabled if unset) ---
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# --- Platform admin allowlist (optional) ---
EMPEROR_PLATFORM_ADMIN_EMAILS=admin@example.com
```

Cross-check against actual reads: `src/db/index.ts`, `src/lib/env.ts`, `src/lib/secrets.ts`, `src/lib/email.ts`, `src/lib/platform-admin.ts`, `server.ts`, `drizzle.config.ts`. **Add a startup validation** (a small `assertEnv()` in `src/lib/env.ts` or instrumentation) that fails fast with a readable message listing any missing required vars — far better first-run UX than a stack trace.

## 1.2 — Docker Compose for one-command Postgres + app

No Docker exists today. Add:
- **`docker-compose.yml`** — a `postgres:16` service (volume-backed) + the app service. Wire `POSTGRES_CONNECTION_STRING` to the compose network. Mount a volume for `STORAGE_LOCAL_DIR` so local artifacts persist.
- **`Dockerfile`** — multi-stage: install deps, `next build`, run via `npx tsx server.ts` (the app needs the custom server; **do not** use `next start`). Node 20+.
- Ensure the app **waits for Postgres** (healthcheck + depends_on) before migrating.

Goal: `cp .env.example .env && docker compose up` gives a working app at `localhost:3000`. This is the "easy install" the user asked for.

## 1.3 — First-run bootstrap (replace the destructive seed)

`src/db/seed.ts` currently **deletes all companies + users** (`:13-14`) then creates `admin@acme.com` / `password123` and prints a live MCP token. That's a footgun as a default.

- Make seed **idempotent and non-destructive**: create the demo company/admin only if none exist; never `DELETE`.
- Move it behind an explicit `npm run db:seed` that prints a warning, OR replace it with a **first-run onboarding flow** (the app already has `src/app/(auth)/` and onboarding routes — prefer routing a fresh install to a "create first admin" screen over seeding credentials).
- Never `console.log` a raw token in a default path.

## 1.4 — Consolidate the migration story

Today there are **five** competing mechanisms: `drizzle-kit push`, `drizzle-kit generate`, `src/db/migrate.ts`, `manual-migrate.ts` + `tmp_migrate.ts` + `apply.ts`, and the runtime `ensureArtifactStorageSchema()`. A self-hoster can't tell which is authoritative.

- Pick **one**: Drizzle migrations (`db:generate` → `db:migrate`) as the single source of truth.
- Fold the runtime DDL from `src/lib/artifact-schema.ts` into real migration files (see Phase 3.4 — it's also a correctness problem).
- Delete `manual-migrate.ts`, `tmp_migrate.ts`, and root-level one-off `.ts` scripts (`check-db.ts`, `test-*.ts`, `openclaw-test.ts`, `simulate-openclaw.ts`, `generate_test_token.ts`, `edit_resources.py`) — or move genuinely useful ones into `scripts/` with docs. The repo root is currently littered with ~15 loose dev scripts that read as clutter.

## 1.5 — README rewrite

Current `README.md` assumes the hosted service (`emperorclaw.malecu.eu/setup`). Rewrite for self-hosters:
- What it is (2 sentences) + a screenshot/GIF.
- **Quick start:** `docker compose up` path AND a manual path (Postgres + `npm i` + `.env` + `db:migrate` + `npm run dev`).
- Architecture note: **requires a single long-running process** (WebSocket + watchdog + advisory lock) — not serverless. Say this loudly so nobody wastes a day trying to deploy to Vercel.
- Storage backends: local (default) vs Bunny.
- The OpenClaw plugin/agent integration story, de-personalized (no `@malecu` namespace as the only option).
- Config reference pointing at `.env.example`.

---

# PHASE 2 — Local storage backend (explicit user request)

The `StorageAdapter` interface is the clean seam. Implement a local-filesystem backend and make the backend env-selectable.

## 2.1 — Implement `LocalStorageAdapter`

Create `src/lib/storage/local.ts` implementing `StorageAdapter` (`src/lib/storage/types.ts:38-45`). Methods and semantics to match Bunny's contract:

- `buildStorageKey(companyId, logicalPath)` → `companies/{companyId}/artifacts/{normalizedPath}` (mirror `bunny.ts:74-77`).
- `upload({companyId, logicalPath, data, contentType, checksum})` → write buffer to `{STORAGE_LOCAL_DIR}/{storageKey}`, `mkdir -p` parent dirs, compute size + SHA-256, return `{storageKey, storageUrl, sizeBytes, contentType, checksum}`. `storageUrl` = an app-relative download path (e.g. `/api/ui/artifacts/{id}/download`) or `file://`-style marker — **not** a public URL.
- `download` / `stat` → read file / `fs.stat`.
- `delete` → `fs.rm`, tolerate missing file (already-deleted is not an error).
- `getDownloadUrl` → return the app download route, since there's no CDN. **Downloads must stream through the authenticated app route**, preserving auth/visibility checks (this is actually *more* secure than Bunny's public pull-zone — call that out).

**Critical:** reuse a **shared, hardened** `normalizeLogicalPath` that strips `..` and absolute-path escapes (see Phase 3.2). Do not copy Bunny's current traversal-vulnerable version. For local FS, path traversal is a direct arbitrary-file-write on the host — even more dangerous than the Bunny case.

## 2.2 — Env-driven backend selection

Rewrite `src/lib/storage/index.ts`:

```ts
export function getStorageAdapter(): StorageAdapter {
  if (cachedAdapter) return cachedAdapter;
  const backend = process.env.STORAGE_BACKEND ?? "local";
  cachedAdapter =
    backend === "bunny" ? new BunnyStorageAdapter()
    : backend === "local" ? new LocalStorageAdapter()
    : (() => { throw new Error(`Unknown STORAGE_BACKEND: ${backend}`); })();
  return cachedAdapter;
}
```

Default to `local` so the app works with zero external services out of the box. Bunny becomes opt-in.

## 2.3 — Decouple callers from Bunny assumptions

Audit every storage caller so none assumes a public CDN URL or the literal string `"bunny"`:
- `src/app/api/mcp/artifacts/route.ts:232` hardcodes `storageProvider = "bunny"` — set it from the active backend instead.
- DB columns `storageUrl`/`storageProvider`/`storageKey` (`src/db/schema.ts:428-430`) — fine to keep, but populate `storageProvider` from config.
- UI `src/app/(app)/artifacts/artifacts-manager.tsx:116-117` — ensure it renders the app download route, not a raw CDN URL.
- Callers list to re-verify: `src/lib/artifact-storage.ts`, `src/lib/artifacts.ts`, `src/lib/artifact-quota.ts`, `src/lib/path-utils.ts`, `src/lib/folder-artifact-moves.ts`, and every route under `src/app/api/{mcp,ui}/artifacts/**` + `src/app/api/chat/voice/route.ts`.

## 2.4 — Document a third option later (optional, not now)

An `S3StorageAdapter` (works with AWS S3, MinIO, R2, Backblaze) is the natural next contribution and would make the project attractive to serious self-hosters. Note it as a "good first PR" in `CONTRIBUTING.md`; don't build it in this pass.

---

# PHASE 3 — Correctness & security hardening (needed before strangers self-host)

These are real bugs found in audit. An open-source multi-tenant app with these will get CVEs filed on day one. **The two HIGH items were verified by hand against the source.**

## 3.1 — HIGH: unauthenticated cross-tenant write

`src/app/api/tasks/[id]/notes/route.ts` has **no auth check at all** — it looks up a task by id alone (`:16`) and inserts a note using the task's `companyId` (`:20-26`), then broadcasts a realtime event. Any anonymous caller can inject notes into any company's tasks by guessing a UUID. **Verified.**
- Fix: require a valid session or MCP token, resolve the caller's `companyId`, and assert `task.companyId === callerCompanyId` before insert. Mirror the pattern in the sibling `src/app/api/mcp/tasks/[id]/notes/route.ts`. Consider whether this legacy route is needed at all — if the MCP/UI equivalents cover it, delete it.

## 3.2 — HIGH: storage path traversal

`BunnyStorageAdapter.normalizeLogicalPath` (`src/lib/storage/bunny.ts:170-180`) splits on `/` and filters empty segments but **does not strip `..`**. **Verified.** Upload routes build the path from unsanitized `fileEntry.name` (`mcp/artifacts/upload/route.ts:95`, `ui/artifacts/upload/route.ts:72`) and `mcp/artifacts/route.ts:238-242` accepts a client-supplied `path`/`storageKey` raw. A crafted filename (`../../<otherCompany>/artifacts/x`) escapes the tenant prefix → cross-tenant overwrite/read.
- Fix: a single shared sanitizer that rejects/strips `.`/`..` segments, leading slashes, and null bytes, used by **both** adapters and applied to `fileEntry.name` and any client `path` at the route layer. `sanitizePathSegment` already exists and is used in `move`/`replace` — extend it and apply everywhere.
- This becomes **more** urgent with local storage (host filesystem write). Do 3.2 *before* shipping Phase 2.

## 3.3 — HIGH: idempotency is non-atomic (TOCTOU)

`checkIdempotency` SELECTs, route later `saveIdempotencyResponse` INSERTs (`src/lib/mcp.ts:144-174`); `idempotencyKeys` (`schema.ts:607-614`) has **no unique index**. Concurrent identical requests both execute the mutation (double artifact/task/delete).
- Fix: add a UNIQUE constraint on `(companyId, requestHash)`, INSERT-first with `ON CONFLICT DO NOTHING`, and treat the conflict as "already processed." Include the **request body** in `requestHash` (currently only key + endpoint, `mcp.ts:151`) so a reused key with a different body doesn't return a stale response. Add a TTL/GC job (the table grows unbounded).

## 3.4 — MEDIUM: runtime DDL on the hot path

`ensureArtifactStorageSchema()` (`src/lib/artifact-schema.ts:161`) runs ~60 raw DDL statements on **every** artifact/folder request, memoized per-process. It includes whole-table `UPDATE`s (`:58-61`), diverges from Drizzle's migration snapshots, and retries the whole batch on any failure.
- Fix: move all of it into proper Drizzle migrations (ties into Phase 1.4). Delete the runtime call.

## 3.5 — MEDIUM: rate limiting

- No throttle on **login** (`src/lib/auth.ts:51-82`) → unlimited credential stuffing. Add the existing rate limiter to the credentials path.
- No rate limiting on **any** `/api/mcp/*` → a leaked company token is unlimited.
- The limiter itself (`src/lib/rate-limit.ts:8`) is an **in-memory `Map`** — useless under PM2's multiple workers and reset on every restart. For self-hosters, either document a single-worker requirement or back it with Postgres/Redis. `getClientIp` trusts the first `x-forwarded-for` hop (`:10-22`) — only safe behind a trusted proxy; document that.

## 3.6 — MEDIUM: upload content-type / stored-XSS

`ui/artifacts/[id]/download/route.ts:39-46` honors `?disposition=inline` and echoes the client-supplied `Content-Type`. An uploaded `text/html` artifact served inline **executes in the app origin**. Add `X-Content-Type-Options: nosniff`, force `Content-Disposition: attachment` for non-previewable types (or serve user content from a separate origin/sandbox), and add a MIME allowlist. Enforce `artifacts.visibility` (stored but never checked on download). Also note: file size is checked only *after* the whole body is buffered into memory (`upload/route.ts:107`) — a large-body memory DoS; reject early where possible.

## 3.7 — MEDIUM: validate request bodies

`zod` is a dependency but unused in routes; mutating routes destructure raw bodies (`mcp/artifacts/route.ts:152-178`, `mcp/agents/[id]/route.ts:27`, `mcp/tasks/*`, `webhook/inbound`, etc.). Add zod schemas at each mutating route boundary. Good open-source hygiene and stops malformed-JSON crashes.

## 3.8 — LOW/MEDIUM: the rest (track, fix opportunistically)

- `mcp/route.ts:77-113` "upsert" is a plain INSERT wrapped in `.catch(console.error)` that always returns `{success:true}` — creates duplicate rows and reports DB failures as success. Rename or implement real upsert.
- `webhook/inbound/route.ts:31-38` dedup is global, not company-scoped — cross-tenant message drop + existence probe.
- Multi-company users get an indeterminate "first membership" (`getCompanyId` `auth.ts:151` and friends, `.limit(1)` no ordering) — add a company switcher or document single-company assumption.
- Swallowed audit logging (`logAudit` `.catch(console.error)`, `mcp.ts:277-287`).
- `companyTokens.tokenHash` (`schema.ts:60`) has no unique/index — add one (it's an auth hot-path lookup). Also confirm FK indexes exist on `tasks(companyId,…)` and `agents(companyId,name)` (used by `resolveAgentId`).
- Password-reset/verify tokens in URL query strings (`forgot-password/route.ts:65`, `register/route.ts:111`) — standard but note it.

---

# PHASE 4 — UI/UX punch list

The app has **two quality tiers**: a design-system tier (`settings`, `artifacts`, `resources`, `agents` dialogs) using `<Button>`, sonner toasts, and pending states; and a **raw tier** (`dashboard`, `projects`, `customers`, `approvals`, `incidents`, `pipelines`, `tactics`) that hand-rolls markup with inconsistent feedback. Most of this phase is dragging the raw tier up to the good tier.

## 4.1 — HIGH

- **No `error.tsx` and no `not-found.tsx` anywhere** (`src/app`). Any server-component throw = raw Next overlay / white screen. Add a route-level `error.tsx` (with reset) and `not-found.tsx`, styled to match the real shell (`emperor-panel`, cyan, `max-w-[1800px]`).
- **`src/app/(app)/loading.tsx`** uses the wrong shape/colors (`zinc-950` gradient + indigo dot, `max-w-6xl`) — matches no real page. Fix the skeleton to the actual layout, or make per-route `loading.tsx`.
- **Delete the fake `/tactics` page** (`src/app/tactics/page.tsx`) — hardcoded fake SOPs ("GitHub Enterprise Auth Flow", "Cloudflare Bypass Strategy"), `any`-typed data (`:43`), dead "Propose Tactic"/"View SOP" buttons, orphaned from nav (URL-only). Ships fake internal-looking data into a public repo. Remove it (or rebuild it real — but remove for launch).
- **Destructive actions with no confirmation + no feedback:** approvals Approve/**Reject** fire immediately (`approvals-client.tsx:159-184`, only feedback is `window.location.reload()` at `:96`); token **Revoke** (`settings-client.tsx:259`) no confirm. Route all destructive actions through the existing gold-standard confirm dialog (`agents/delete-agent-dialog.tsx`) and add toasts.
- **Unbounded fetch+render:** `projects/page.tsx:14-21` loads all tasks/artifacts/events/memory for the company with no limit; `projects-client.tsx:534-555` renders every task into kanban columns. Add pagination/limit + virtualization for large tenants.
- **Icon-only buttons and collapsed sidebar without accessible names** (`aria-label` appears only 14× app-wide). Add labels to all icon buttons (`projects-client.tsx:501,564,611,625`, `agent-team-chat.tsx:465`) and the collapsed sidebar links (`app-sidebar.tsx:74`).

## 4.2 — MEDIUM

- **Standardize on shared `<Button>`** (`src/components/ui/button.tsx`) — currently used in only 4 areas; the rest hand-write `<button className="rounded-full border border-cyan-400/40…">`. Replace ad-hoc buttons app-wide.
- **Fix the cyan/indigo accent split:** auth pages + two dialogs are indigo while the app is cyan (`login/page.tsx:51-116`, `create-agent-dialog.tsx:77-103`, `globals.css:157-160`, `tactics` — being deleted). Pick one accent.
- **Client mutation failures are invisible** (`console.error` only): `customers-client.tsx:42,61`, `approvals-client.tsx:98`, `incidents/incident-row.tsx:40`, `settings-client.tsx:75-107`, `projects-client.tsx:219`. Add error toasts everywhere.
- **Replace native `window.confirm()`** deletes (`projects-client.tsx:310,413`, `resources-client.tsx:306`, `pipelines-client.tsx:395`) with the styled dialog.
- **"Archive" label, delete behavior:** `projects-client.tsx:314,417` call `DELETE` but the button says "Archive" with no restore. Rename to "Delete" or implement real archive.
- **Shared date/util:** formatting is ad-hoc per file (`toLocaleTimeString`/`toLocaleString`/`toLocaleDateString` scattered + a bespoke relative formatter in `messaging-hub.tsx:38`). Add one date util.
- **Naming drift:** sidebar "Attention" → route `/incidents` → H1 "Needs Attention" (`app-sidebar.tsx:33`, `incidents/page.tsx:22`), plus a redundant `/attention`→`/incidents` redirect. Pick one name.
- **Per-page metadata:** only `layout.tsx:20` sets a title; every tab reads "Emperor Claw". Add `metadata` per route.
- **Lost-input risk:** the global 15s `router.refresh()` (`auto-refresh.tsx:10`) discards unsaved edits in `customers` notes (`customers-client.tsx:186-191`), `resources` draft, and dialogs. Add unsaved-changes guards or exclude editing views from auto-refresh.
- **Hand-rolled drawers aren't dialogs** (`projects-client.tsx:560,618`): no `role="dialog"`, focus trap, Esc, or aria-modal; fixed `w-[42%]`/`w-[45%]` break on mobile.
- **Fake liveness:** chats show a permanent pulsing "Live Feed" dot; on poll failure they only `console.error` (`agent-team-chat.tsx:175,263-264`). Add a real stale/reconnecting indicator.
- **`app-sidebar.tsx:99-103`** shows a hardcoded "Admin"/"owner"/"A" user block — wire it to the real session user.

## 4.3 — LOW (batch these)

- `agents/[id]/page.tsx:42` uses `redirect("/agents")` on unknown id — use `notFound()`.
- Dead theming: `.dark` and `:root` in `globals.css` are byte-identical (light theme never used) while `ThemeProvider` implies a toggle — remove the dead toggle or implement light mode.
- Malformed Tailwind `bg-cyan-400/10/20` (`projects-client.tsx:622`) renders no background.
- Literal `\n` in a textarea placeholder (`customers-client.tsx:188` — single-quoted string).
- Internal jargon leaking to UI ("dead_letter" raw at `projects-client.tsx:526`, "MCP endpoint", "Context Pack / RAG contract").
- Ops admin tables without pagination (`ops/companies`, `ops/users`).
- Hardcoded stat values (`settings-client.tsx:133` "Runtimes" = 2).
- Consolidate duplicated ad-hoc `SummaryCard`/`Chip`/`StatusDot` reimplementations into shared components.

---

# PHASE 5 — Repo hygiene & project scaffolding

Make it read like a real open-source project, not a working directory.

- **Clean the repo root.** Remove/relocate loose dev files: `check-db.ts`, `check-remote-db.sh`, `test-api.ts`, `test-auth.ts`, `test-chat-communication.ts`, `test-helper.ts`, `test-post.js`, `test-resolve.ts`, `openclaw-test.ts`, `simulate-openclaw.ts`, `generate_test_token.ts`, `manual-migrate.ts`, `tmp_migrate.ts`, `edit_resources.py`, `install.ps1`/`install.sh` (rewrite for OSS or drop), `run.sh`, `USER.md`. Keep the root to config + a handful of docs.
- **De-personalize the OpenClaw plugin story.** The `@malecu/emperor-claw-os-plugin` namespace and `emperorclaw.malecu.eu` appear in `src/app/(app)/settings/settings-client.tsx:282`, `src/components/onboarding-tour.tsx:97`, README, and throughout `src/content/docs/**` + `docs/**`. Parameterize the install host/namespace or replace with placeholders + a "publish your own plugin" doc.
- **`CONTRIBUTING.md`** already exists — update it: local dev setup, the storage-adapter extension point (invite S3/MinIO adapters as good first issues), test/lint expectations, commit conventions.
- **Docs:** keep `OPENCLAW_ALIGNMENT.md` (good architecture context); review `IMPLEMENTATION_PLAN.md`, `RETHINK.md` for internal/personal content before publishing (or move to a `docs/design/` folder). `docs/v1.1/*` needs the personal-path + credential scrub from Phase 0.
- **Remove external telemetry defaults:** `next.config.ts:16,20` allowlists Google Tag Manager + Analytics in the CSP. Strip these or make them opt-in via env — self-hosters shouldn't ship the author's analytics.
- **CSP/security headers:** `docs/security-headers-nginx.md` is nginx-specific for the old domain. Provide a generic reverse-proxy example.

---

# PHASE 6 — CI, tests, and release

- **CI test gate.** The only workflow (`.github/workflows/deploy.yml`) runs on push to `main` and goes straight to `npm ci → db:migrate → build → pm2 restart` against **production**, with no test/lint/typecheck. Split into:
  - `ci.yml` (on PR + push): `npm ci`, `npm run lint`, `tsc --noEmit`, `npm test`, `docker compose` smoke build.
  - Deploy stays separate and manual/tagged — and **stop running `db:migrate` against prod on every push**.
- **Add integration tests for the security-critical paths.** Existing `npm test` is 6 architecture/smoke `.cjs` files — none would catch the Phase 3 HIGH bugs. Add route tests for: tenant isolation (the notes route, artifact IDOR), path-traversal rejection, idempotency under concurrency, auth on every mutating route.
- **Pin Node version** (`.nvmrc` / `engines` in `package.json`) — the custom server + `tsx` runtime needs Node 20+.
- **Release checklist file** (`docs/RELEASE.md`): env validated, migrations clean from empty DB, `docker compose up` verified on a clean machine, secret scan clean, both storage backends smoke-tested.

---

# Suggested execution order (dependency-aware)

1. **Phase 0** — security gate. Nothing public until done. (Rotate → scrub tree → scrub history → verify.)
2. **Phase 3.2** (path traversal sanitizer) — needed before local storage exists.
3. **Phase 2** — local storage backend + env selection. Delivers the headline "run locally without Bunny."
4. **Phase 1** — `.env.example`, Docker Compose, migration consolidation, non-destructive bootstrap, README. Delivers "easy install."
5. **Phase 3.1, 3.3, 3.5–3.7** — remaining security/correctness.
6. **Phase 4** — UI/UX punch list (HIGH first: error boundaries, tactics deletion, destructive-action confirms, unbounded fetch, a11y).
7. **Phase 5** — repo hygiene + de-personalization.
8. **Phase 6** — CI, tests, release checklist.

# Definition of done

- Fresh machine: `git clone` → `cp .env.example .env` → `docker compose up` → working app at `localhost:3000` with **local** storage, no Bunny account, no external services beyond the bundled Postgres.
- Secret scan over full history: **zero** hits. All leaked creds rotated.
- No hardcoded `malecu`/personal hosts/paths anywhere in the tree.
- Both storage backends smoke-tested; path traversal rejected by test.
- Every mutating API route authenticated and tenant-scoped; the three HIGH bugs closed with regression tests.
- CI runs lint + typecheck + tests on PR; no auto-migrate-to-prod.
- No white screen on error (`error.tsx`/`not-found.tsx` present); no fake-data pages; destructive actions confirmed and give feedback.
```