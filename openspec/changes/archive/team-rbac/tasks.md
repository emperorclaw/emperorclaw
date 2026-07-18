# Tasks: Team RBAC & Instance-Aware Multi-Tenancy

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,720 |
| Files to touch | 24 (13 new, 11 modified) |
| Chained PRs recommended | **Yes** |
| 400-line budget risk | **High** |
| Delivery strategy | `ask-on-risk` |
| Chain strategy | `pending` (user must choose: `stacked-to-main` or `feature-branch-chain`) |

**Decision needed before apply:** Yes — the 400-line budget is exceeded ~4×. The orchestrator MUST stop and ask whether to split into chained PRs or proceed with `size:exception`.

### Suggested Work Units (if chaining)

| PR | Scope | Est. Lines | Depends on |
|----|-------|------------|------------|
| PR #1 | Schema + Core Libs (Phases 1–2) | ~460 | — |
| PR #2 | Auth + Middleware + Register (Phases 3–4.1) | ~260 | PR #1 |
| PR #3 | API Routes (Phases 4.2–4.5) | ~360 | PR #2 |
| PR #4 | UI + Integration Tests + Docs (Phases 5–7) | ~640 | PR #3 |

---

## Task List

### Phase 1: Schema & Migration

- [ ] **T-1.1: Database migration SQL** — _Medium (1-3h)_
  - Files:
    - `src/db/migrations/0024_team-rbac.sql` (create)
  - Migration content:
    - `CREATE TABLE IF NOT EXISTS invitations` with all columns, indexes, and FKs per design §3
    - `CREATE TABLE IF NOT EXISTS instance_settings` with `key` PK and `value` jsonb
    - `ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_role` with default `'member'`
    - Idempotent `UPDATE users SET instance_role = 'instance_admin'` for existing sole-company creators (NFR-11)
    - All DDL uses `IF NOT EXISTS` / `IF EXISTS` guards (NFR-9)
    - No data deletion or column drops (NFR-10)
  - Tests:
    - `tests/env-deployment.test.cjs` — verify migration script is readable and contains expected DDL (no actual DB needed in unit test; just structural assertions like `company-brain.test.cjs`)
  - Depends on: —
  - Satisfies: FR-19, FR-20, FR-27, NFR-9, NFR-10, NFR-11

- [ ] **T-1.2: Update Drizzle schema definitions** — _Medium (1-3h)_
  - Files:
    - `src/db/schema.ts` (modify)
  - Changes:
    - Add `instanceRole` column to `users` table: `text("instance_role").notNull().default("member")`
    - Add `invitations` table definition per design §3
    - Add `instanceSettings` table definition per design §3
    - Change `companyMembers.role` default from `"owner"` to `"member"` (and update comment)
    - Export new tables at bottom of schema file
  - Tests:
    - `tests/env-deployment.test.cjs` — assert new table exports exist in schema module
  - Depends on: T-1.1
  - Satisfies: FR-19, FR-20, FR-27

### Phase 2: Core Libraries

- [ ] **T-2.1: Add DEPLOYMENT_MODE to env module** — _Small (<1h)_
  - Files:
    - `src/lib/env.ts` (modify)
  - Changes:
    - Add `export const DEPLOYMENT_MODE` reading from `process.env.DEPLOYMENT_MODE`
    - Default to `"self-hosted"` when unset or invalid (FR-1)
    - Read exactly once at module load (NFR-4)
  - Tests:
    - `tests/env-deployment.test.cjs` — test default fallback, `"cloud"` opt-in, invalid values → `"self-hosted"`, verify export is a string literal not a function
  - Depends on: T-1.2
  - Satisfies: FR-1, NFR-4

- [ ] **T-2.2: Instance utilities module** — _Medium (1-3h)_
  - Files:
    - `src/lib/instance.ts` (create)
  - Exports:
    - `isSelfHosted()` — `DEPLOYMENT_MODE === "self-hosted"`
    - `isCloud()` — `DEPLOYMENT_MODE === "cloud"`
    - `getInstanceCompany()` — cached (∞ TTL, immutable after bootstrap per NFR-8): query single non-deleted company, throw if 0 or >1 found in self-hosted mode
    - `getInstanceSettings()` — cached (60s TTL Map, NFR-7): `SELECT * FROM instance_settings`, return as `Record<string, unknown>`
    - `setInstanceSetting(key, value)` — `UPSERT instance_settings`, invalidate settings cache; must be called within an `instance_admin` guard context (the guard itself lives in roles.ts)
    - `getRegistrationMode()` — convenience: reads `registration_mode` from settings, defaults to `"invite-only"`
    - `isRegistrationOpen()` — convenience: `getRegistrationMode() === "open"`
  - Cache implementation: module-level `Map` for settings (60s TTL via `cachedAt` timestamp) and a single `companyId` variable (set once, never cleared)
  - Tests:
    - `tests/instance.test.ts` — test `isSelfHosted`/`isCloud` branching (mock DEPLOYMENT_MODE via module), test settings cache TTL and invalidation, test registration mode convenience functions
  - Depends on: T-2.1, T-1.2
  - Satisfies: FR-2, FR-3, FR-25, FR-26, NFR-7, NFR-8

- [ ] **T-2.3: Roles & permissions engine** — _Medium (1-3h)_
  - Files:
    - `src/lib/roles.ts` (create)
  - Types:
    - `InstanceRole = "instance_admin" | "member"`
    - `CompanyRole = "owner" | "admin" | "member" | "viewer"`
    - `Role = InstanceRole | CompanyRole`
    - `Permission = "instance:settings:write" | "users:invite" | "users:remove" | "users:role:change" | "projects:all:write" | "projects:own:write" | "projects:read" | "tokens:manage" | "agents:manage"` (or a simpler string enum per FR-21)
  - `ROLE_HIERARCHY` — ordered array: `["instance_admin", "owner", "admin", "member", "viewer"]`
  - `PERMISSION_MATRIX` — `Map<Permission, Set<Role>>` per FR-21
  - Functions:
    - `getEffectiveRole(user, companyRole)` — resolves max of `user.instanceRole` + `companyRole` per hierarchy (FR-22, FR-23)
    - `hasPermission(user, permission, companyRole?)` — `boolean` (FR-22)
    - `roleGte(a, b)` — returns `true` if role `a` is >= role `b` in hierarchy
    - `requireRole(...roles)` — returns an async guard function that throws `AuthError(401)` if no session, `AuthError(403)` if insufficient role (FR-28, FR-29)
    - `AuthError` class — extends `Error` with `statusCode` property (401/403)
  - Implementation note: permission checks are O(1) — Set lookups on the matrix, no DB scans (NFR-6)
  - Tests:
    - `tests/roles.test.cjs` — test hierarchy ordering: `instance_admin > owner > admin > member > viewer`; test `hasPermission` for every cell in the permission matrix; test `getEffectiveRole` resolution when instance role is higher than company role; test `requireRole` throws appropriate status codes; test `roleGte` reflexivity and transitivity
  - Depends on: T-1.2
  - Satisfies: FR-18, FR-19, FR-20, FR-21, FR-22, FR-23, FR-29, NFR-3, NFR-6

- [ ] **T-2.4: Invitations module** — _Medium (1-3h)_
  - Files:
    - `src/lib/invitations.ts` (create)
  - Functions:
    - `generateInviteToken()` — `crypto.randomBytes(32).toString("hex")`; SHA-256 hash via `crypto.createHash("sha256")` (FR-12, NFR-1, NFR-2)
    - `createInvitation({ email, role, companyId, createdByUserId })` — validates email (RFC 5321), normalizes to lowercase; checks for existing active invitation for same email+company (EC-3 → 409 Conflict); validates role is `member|admin|viewer` (EC-9); inserts into `invitations` table; returns `{ id, email, role, expiresAt, rawToken }`. Rate limited at 20/hr/admin (NFR-5).
    - `validateInviteToken(rawToken, email?)` — hashes raw token, queries `invitations` joined with `companies`; checks `deleted_at IS NULL`, `expires_at > now()`, `use_count < max_uses`; if `email` provided, validates match (EC-10); returns `{ valid: true, email, role, companyName }` or `{ valid: false, reason }`
    - `consumeInvite(rawToken, userId)` — in a DB transaction: look up invitation by token hash, validate, `UPDATE use_count = use_count + 1`, if `use_count >= max_uses` → soft-delete (`deleted_at = now()`), `INSERT company_members` for user with invited role, set `users.instance_role = invitation role` (or `'member'` if viewer per FR-16)
    - `getInvitations(companyId)` — returns all non-deleted invitations for a company, with status computed (pending/expired/consumed)
    - `revokeInvitation(invitationId)` — soft-delete: `UPDATE deleted_at = now()`
    - `resendInvitation(invitationId)` — re-sends email without regenerating token or extending expiry; returns existing invitation data
  - Tests:
    - `tests/invitations.test.cjs` — test token generation is 32+ bytes; test SHA-256 hashing is deterministic for same input; test `validateInviteToken` returns valid for fresh token; test expired token returns `{ valid: false, reason: "expired" }`; test consumed token returns `{ valid: false, reason: "consumed" }`; test email mismatch returns `{ valid: false, reason: "email_mismatch" }`; test `consumeInvite` increments use_count and soft-deletes when consumed; test duplicate email invitation returns 409 conflict data shape; test role validation rejects `instance_admin`
  - Depends on: T-1.2, T-2.1, T-2.2
  - Satisfies: FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-34, NFR-1, NFR-2, NFR-5, EC-1, EC-2, EC-3, EC-9, EC-10

### Phase 3: Auth & Middleware

- [ ] **T-3.1: Extend JWT and session callbacks** — _Small (<1h)_
  - Files:
    - `src/lib/auth.ts` (modify)
  - Changes:
    - In `jwt` callback: after user creation, also query `users.instance_role` and `company_members.role`; add `instanceRole` and `companyRole` to the JWT token (FR-19, FR-20)
    - New claims are additive — existing tokens without these claims continue working (NFR-12)
    - In `session` callback: expose `instanceRole` and `companyRole` on `session.user` (extend the `SessionWithUserId` type)
    - Add TypeScript declarations for the extended JWT and Session types
  - Tests:
    - `tests/roles.test.cjs` — (covered by role resolution tests, no separate test needed for callback shape; the unit test can validate the JWT type augmentation compiles)
  - Depends on: T-1.2, T-2.3
  - Satisfies: FR-19, FR-20, NFR-12

- [ ] **T-3.2: Update getCompanyId for self-hosted mode** — _Small (<1h)_
  - Files:
    - `src/lib/auth.ts` (modify)
  - Changes:
    - In `getCompanyId()`: if `isSelfHosted()`, use `getInstanceCompany()` from instance.ts (cached) instead of querying `companyMembers`
    - In cloud mode, preserve existing behavior (query `companyMembers` by userId)
    - Add `getCompanyRole(userId, companyId)` helper: query `companyMembers.role` for the user+company pair
  - Tests:
    - `tests/instance.test.ts` — extend to verify `getCompanyId` returns the cached company in self-hosted mode
  - Depends on: T-2.2, T-3.1
  - Satisfies: FR-2, FR-3, NFR-8, NFR-13

- [ ] **T-3.3: Middleware route protection overhaul** — _Medium (1-3h)_
  - Files:
    - `src/middleware.ts` (modify)
  - Changes:
    - Preserve existing `withAuth` for the `(app)` route group — zero breakage (NFR-13, NFR-14)
    - Add `/api/auth/validate-invite` to the public matcher exclusion list
    - Add `/api/instance/*` exclusion from blanket auth (these routes do their own `withRole` checks)
    - Document the pattern: middleware does binary auth only; API routes call `requireRole()` internally
    - Add `src/lib/route-guards.ts` (create) — optional helper that provides `withRoleApi(roles)` as a higher-order wrapper for Next.js route handlers
  - Tests:
    - `tests/security-boundary.test.cjs` — extend with tests validating that role-gated routes return 403 not 401; validate-invite is publicly accessible
  - Depends on: T-2.3, T-3.2
  - Satisfies: FR-28, FR-29, FR-30, NFR-3, NFR-13, NFR-14

### Phase 4: API Routes

- [ ] **T-4.1: Rewrite registration endpoint for self-hosted** — _Large (3-6h)_
  - Files:
    - `src/app/api/auth/register/route.ts` (modify)
  - Changes:
    - **Bootstrap path** (self-hosted, no companies exist): `SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL` → if 0: create user (`instance_role = 'instance_admin'`), company, `company_members` (`role = 'owner'`), `instance_settings` (`registration_mode = 'invite-only'`) — all in one transaction (FR-4, FR-5, FR-6). Response: `{ message, instanceCreated: true }`.
    - **Invited signup path** (self-hosted, companies exist, `inviteToken` present): call `validateInviteToken` + `consumeInvite` (FR-16). Do NOT create a new company. Response: `{ message, companyName, role }`.
    - **Open registration path** (self-hosted, companies exist, `registration_mode = 'open'`, no inviteToken): create user (`instance_role = 'member'`), add to existing company as `member` (FR-8). Response: `{ message, companyName, role }`.
    - **Invite-only rejection** (self-hosted, companies exist, `registration_mode = 'invite-only'`, no inviteToken): return 403 (FR-7).
    - **Cloud path**: completely unchanged — existing behavior preserved under `if (isCloud())` guard (FR-3, NFR-13).
    - `companyName` field: required ONLY for bootstrap; optional/ignored for subsequent signups (FR-9).
    - Email validation, password validation, rate limiting — all preserved from existing code.
  - Tests:
    - `tests/bootstrap-flow.test.ts` — integration test simulating bootstrap request and verifying user+company+membership+settings created; verify atomic rollback on partial failure (EC-7)
    - `tests/invite-accept.test.ts` — integration test: create invitation, then simulate signup with token, verify membership and token consumption
  - Depends on: T-2.1, T-2.2, T-2.4, T-3.2
  - Satisfies: FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-16, FR-17, NFR-13, EC-7, SC-1, SC-2

- [ ] **T-4.2: Invitation validation endpoint** — _Small (<1h)_
  - Files:
    - `src/app/api/auth/validate-invite/route.ts` (create)
  - Implementation:
    - `GET /api/auth/validate-invite?token=<raw>&email=<email>` — unauthenticated (FR-15)
    - Rate limited: 30/hr per IP (NFR-5, EC-11)
    - Calls `validateInviteToken(rawToken, email)` from invitations.ts
    - Returns `{ valid: true, email, role, companyName }` or `{ valid: false, reason }`
  - Tests:
    - `tests/invitations.test.cjs` — (already covered in T-2.4 tests; extend if needed for HTTP-level validation)
  - Depends on: T-2.4, T-3.3
  - Satisfies: FR-15, NFR-5, EC-1, EC-2, EC-10, EC-11

- [ ] **T-4.3: Invitations CRUD API** — _Medium (1-3h)_
  - Files:
    - `src/app/api/instance/invitations/route.ts` (create)
    - `src/app/api/instance/invitations/[id]/route.ts` (create)
  - Endpoints:
    - `POST /api/instance/invitations` — auth + role guard `admin+` via `requireRole("admin")`; body `{ email, role }`; calls `createInvitation()`; returns 201 with `{ id, email, role, expiresAt, inviteUrl }`; errors: 400, 403, 409, 429 (FR-10, FR-11, FR-12)
    - `GET /api/instance/invitations` — auth + role guard `admin+`; lists pending invitations for the company with status (FR-34)
    - `DELETE /api/instance/invitations/[id]` — auth + role guard `admin+`; soft-deletes invitation
    - `POST /api/instance/invitations/[id]/resend` — auth + role guard `admin+`; re-sends email without extending expiry
    - Cloud guard: all endpoints return 403 in cloud mode with descriptive message (FR-30, EC-8)
  - Tests:
    - `tests/invite-accept.test.ts` — extend with API-level tests for create, list, revoke, resend
  - Depends on: T-2.4, T-3.3
  - Satisfies: FR-10, FR-11, FR-12, FR-13, FR-14, FR-17, FR-30, FR-34, EC-3, EC-8, EC-9

- [ ] **T-4.4: Instance settings API** — _Small (<1h)_
  - Files:
    - `src/app/api/instance/settings/route.ts` (create)
  - Endpoints:
    - `GET /api/instance/settings` — auth required, any role; returns all settings except `smtp_password` (FR-25, spec §5.4)
    - `PUT /api/instance/settings` — auth + `requireRole("instance_admin")`; body `{ settings: { [key]: value } }`; UPSERT each key; invalidate cache (FR-26, spec §5.5)
    - Cloud guard: PUT returns 403 in cloud mode
  - Tests:
    - `tests/instance.test.ts` — extend with API-level tests for GET (all roles), PUT (instance_admin only, 403 for others), password filtering
  - Depends on: T-2.2, T-2.3, T-3.3
  - Satisfies: FR-25, FR-26, FR-27, FR-30, NFR-7

- [ ] **T-4.5: Members list API** — _Small (<1h)_
  - Files:
    - `src/app/api/instance/members/route.ts` (create)
  - Endpoints:
    - `GET /api/instance/members` — auth + role guard `admin+`; returns `{ members: [{ id, email, companyRole, instanceRole, joinedAt }] }` (FR-31, FR-32)
    - `PUT /api/instance/members/[userId]/role` — auth + `requireRole("instance_admin", "owner")`; body `{ role }`; validates last-admin constraint (FR-24, EC-4, EC-5); updates `company_members.role` and/or `users.instance_role`; returns updated member
    - `DELETE /api/instance/members/[userId]` — auth + `requireRole("instance_admin", "owner", "admin")`; soft-deletes `company_members` row; validates last-admin constraint; returns 204
    - Cloud guard: all endpoints return 403 in cloud mode
  - Tests:
    - `tests/roles.test.cjs` — extend with last-admin demotion rejection test
  - Depends on: T-2.3, T-2.4, T-3.3
  - Satisfies: FR-24, FR-31, FR-32, EC-4, EC-5

### Phase 5: UI Pages

- [ ] **T-5.1: Update signup page for self-hosted flows** — _Medium (1-3h)_
  - Files:
    - `src/app/(auth)/signup/page.tsx` (modify)
  - Changes:
    - Read `invite` and `email` query params from URL on mount
    - **Bootstrap state** (no company exists): show full form with `companyName` field, "Set up your instance" heading
    - **Invited state** (`invite` param present): call `GET /api/auth/validate-invite`, pre-fill email (read-only), hide company name field, show "You've been invited to join {companyName} as {role}" banner; on submission include `inviteToken` in payload
    - **Open registration state** (no invite param, registration is open): show form without company name field
    - **Invite-only blocked state**: show message "This instance is invite-only. Contact your administrator." with link to `/login`
    - Error handling: expired invite → error banner (EC-1); consumed invite → error banner with "Log in instead" link (EC-2, EC-6); email mismatch → error banner (EC-10)
  - Tests:
    - `tests/bootstrap-flow.test.ts` — extend with signup page state rendering tests
  - Depends on: T-4.1, T-4.2
  - Satisfies: FR-9, SC-1, SC-2, EC-1, EC-2, EC-6, EC-10

- [ ] **T-5.2: Member management page** — _Large (3-6h)_
  - Files:
    - `src/app/(app)/settings/members/page.tsx` (create)
    - `src/app/(app)/settings/members/members-client.tsx` (create)
  - Server component (`page.tsx`):
    - Check session + role: `requireRole("admin")` → redirect to `/` if insufficient
    - Fetch members via `GET /api/instance/members`
    - Fetch pending invitations via `GET /api/instance/invitations`
    - Pass data to client component
  - Client component (`members-client.tsx`):
    - **Member list** (FR-32): table with columns: email, company role badge, instance role badge (self-hosted only), join date, actions menu (change role, remove)
    - **Invite form** (FR-33): email input, role dropdown (`member` | `admin` | `viewer`), "Send Invitation" button; handles 400, 409, 429 errors
    - **Pending invitations** (FR-34): table with invited email, role, created date, expiry date, status chip (pending/expired/consumed), "Resend" and "Revoke" actions
    - **Role change dialog**: dropdown to select new role, with guard preventing last-admin demotion (EC-4, EC-5)
    - **Remove member dialog**: confirmation prompt
    - Uses existing UI patterns from `settings-client.tsx` (cards, toasts via sonner)
    - Loading states with skeleton placeholders
  - Tests:
    - `tests/operator-ux.test.cjs` — extend with member management UI structural assertions
  - Depends on: T-4.3, T-4.5
  - Satisfies: FR-31, FR-32, FR-33, FR-34, SC-3, EC-4, EC-5

- [ ] **T-5.3: Instance settings UI** — _Medium (1-3h)_
  - Files:
    - `src/app/(app)/settings/page.tsx` (modify)
    - `src/app/(app)/settings/settings-client.tsx` (modify)
  - Changes:
    - Add new tab "Instance" (visible only when `user.instanceRole === "instance_admin"`)
    - Instance settings tab: form with fields for `registration_mode` (toggle: invite-only / open), `instance_name` (text input), SMTP fields
    - `GET /api/instance/settings` to populate form
    - `PUT /api/instance/settings` to save changes
    - `smtp_password` field: password input, never pre-filled, only sent if user types something new
    - Success/error toasts via sonner
  - Tests:
    - `tests/operator-ux.test.cjs` — extend with instance settings tab visibility assertions
  - Depends on: T-4.4
  - Satisfies: FR-25, FR-26, FR-27, SC-3 (Alice changes registration_mode)

- [ ] **T-5.4: Sidebar navigation update** — _Small (<1h)_
  - Files:
    - `src/components/app-sidebar.tsx` (modify)
  - Changes:
    - Add conditional "Members" link (`href="/settings/members"`, icon: `Users` from lucide-react)
    - Visible only when user has role `admin` or higher (check via session's `companyRole` / `instanceRole`)
    - Follow existing link styling pattern (active state, icon, truncation)
  - Tests:
    - `tests/operator-ux.test.cjs` — extend with sidebar link visibility assertions
  - Depends on: T-3.1, T-5.2
  - Satisfies: FR-31 (navigation access to member management)

### Phase 6: Integration Tests

- [ ] **T-6.1: Bootstrap flow integration test** — _Medium (1-3h)_
  - Files:
    - `tests/bootstrap-flow.test.ts` (create)
  - Test cases:
    - Fresh DB: register → verify `instance_admin` role, company created, settings initialized
    - Fresh DB: register → verify response shape (`instanceCreated: true`)
    - Post-bootstrap: second registration without token → 403
    - Post-bootstrap: second registration with open mode → 201 with `member` role
    - Post-bootstrap: registration with valid invite token → 201, membership created, token consumed
    - Transaction rollback: simulate partial failure → verify no orphaned data (EC-7)
    - Cloud mode: register with `DEPLOYMENT_MODE=cloud` → existing multi-company behavior preserved
  - Test tool: `npx tsx --test` (TypeScript integration test)
  - Depends on: T-4.1
  - Satisfies: SC-1, SC-2, NFR-13, EC-7

- [ ] **T-6.2: Invite acceptance integration test** — _Medium (1-3h)_
  - Files:
    - `tests/invite-accept.test.ts` (create)
  - Test cases:
    - Create invitation → validate token → register with token → verify membership + token consumed
    - Expired token → validate returns `{ valid: false, reason: "expired" }` → register with expired token → 400
    - Consumed token → validate returns `{ valid: false, reason: "consumed" }` → register again → 400 (EC-2)
    - Email mismatch: valid token but wrong email → validate returns `{ valid: false, reason: "email_mismatch" }` (EC-10)
    - Already-registered user clicks invite link → signup detects existing user → prompts login (EC-6)
    - Rate limiting: exceed 30 validation attempts → 429 (EC-11)
  - Test tool: `npx tsx --test` (TypeScript integration test)
  - Depends on: T-4.1, T-4.2, T-4.3
  - Satisfies: SC-2, EC-1, EC-2, EC-6, EC-10, EC-11

### Phase 7: Docs & Final Polish

- [ ] **T-7.1: Role-based visibility in existing pages** — _Medium (1-3h)_
  - Files:
    - `src/app/(app)/projects/page.tsx` (modify)
    - `src/app/(app)/projects/projects-client.tsx` (modify)
    - `src/app/(app)/agents/*` (modify as needed)
    - `src/app/(app)/settings/page.tsx` (modify)
  - Changes:
    - Project list: hide "New Project" button for `viewer` role (SC-3)
    - Agent management: hide create/configure/delete actions for `viewer` (FR-21)
    - Settings page: hide token generation for `viewer` and `member` (FR-21)
    - All UI hiding is client-side only — server-side guards are the real enforcement (NFR-3)
    - Use session's `companyRole` exposed from T-3.1
  - Tests:
    - `tests/operator-ux.test.cjs` — extend with role-based visibility checks on key pages
  - Depends on: T-3.1, T-5.2
  - Satisfies: FR-21, NFR-3, SC-3

- [ ] **T-7.2: Documentation updates** — _Small (<1h)_
  - Files:
    - `README.md` (modify) — add `DEPLOYMENT_MODE` to environment variables table, document self-hosted vs cloud
    - `CONTRIBUTING.md` (modify) — add note about role-based middleware pattern for new API routes
    - `.env.example` (modify) — add `DEPLOYMENT_MODE=self-hosted` entry with comment
  - Tests: None (docs only)
  - Depends on: T-6.2 (all implementation done)
  - Satisfies: project documentation standards

- [ ] **T-7.3: Full test suite validation** — _Small (<1h)_
  - Run: `node --test tests/*.test.cjs && npx tsx --test tests/path-sanitizer.test.ts tests/instance.test.ts tests/bootstrap-flow.test.ts tests/invite-accept.test.ts`
  - Run: `npx tsc --noEmit` (type check)
  - Run: `npx eslint` (lint)
  - Fix any failures before marking the change ready for verify
  - Depends on: T-7.1, T-6.2
  - Satisfies: strict TDD mode gate

---

## Dependency Graph

```
T-1.1 ──► T-1.2 ──┬──► T-2.1 ──► T-2.2 ──┬──► T-3.2 ──► T-3.3 ──► T-4.1 ──┬──► T-5.1
                   │                       │                                   │
                   ├──► T-2.3 ─────────────┤                                   ├──► T-4.2
                   │                       │                                   │
                   └──► T-2.4 ─────────────┘                                   ├──► T-4.3 ──┬──► T-5.2 ──► T-5.4
                                                                               │            │
                                          T-3.1 ───────────────────────────────┤            └──► T-6.2
                                                                               │
                                                                               ├──► T-4.4 ──► T-5.3
                                                                               │
                                                                               ├──► T-4.5 ──► T-5.2
                                                                               │
                                                                               └──► T-6.1

T-5.2 + T-5.3 + T-5.4 + T-3.1 ──► T-7.1

T-6.1 + T-6.2 + T-7.1 ──► T-7.2 ──► T-7.3
```

### Parallelizable Groups

| Group | Tasks | Can run in parallel |
|-------|-------|---------------------|
| G1 | T-2.3, T-2.4 | After T-1.2 |
| G2 | T-3.1 | After T-1.2 + T-2.3 (independent of T-2.1/T-2.2 path) |
| G3 | T-4.2, T-4.3, T-4.4, T-4.5 | After T-3.3 (all independent of each other) |
| G4 | T-5.1, T-5.3 | After T-4.1 (signup) and T-4.4 (settings) respectively |
| G5 | T-6.1, T-6.2 | After T-4.1 and T-4.3 respectively |
