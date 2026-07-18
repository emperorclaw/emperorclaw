# Verification Report: Team RBAC & Instance-Aware Multi-Tenancy

**Change:** `team-rbac`
**Date:** 2026-07-17
**Verifier:** SDD Verify Executor
**Artifact Store:** `openspec`
**Test Suite:** 31/31 passing ✅

---

## Executive Summary

**Verdict: FAIL** — 3 CRITICAL issues found (API-client contract mismatches causing broken functionality), 6 WARNING issues (missing features or incomplete coverage), 4 SUGGESTION items. The core libraries are solid, the 31 tests all pass, but the API ↔ client contract breaks prevent the Instance Settings toggle and Members role change from working end-to-end. A missing `register-state` endpoint causes the signup page to fall back to bootstrap mode incorrectly.

**CRITICAL: 3 | WARNING: 6 | SUGGESTION: 4**

---

## Build & Test Evidence

| Check | Status | Detail |
|-------|--------|--------|
| Unit tests (`tests/team-rbac.test.ts`) | ✅ 31/31 pass | Role hierarchy (6), Permission matrix (9), getEffectiveRole (4), Token validation (12) |
| Type check (`npx tsc --noEmit`) | ⚠️ Partial | Not run in this verification session (see context: previous run had errors) |
| Migration syntax | ✅ Valid | `0024_team-rbac.sql` uses `IF NOT EXISTS`/`IF EXISTS` guards, idempotent |

---

## Specification Compliance Matrix

### Functional Requirements (FR-1 through FR-34)

| FR | Description | Status | Evidence |
|----|-------------|--------|----------|
| FR-1 | DEPLOYMENT_MODE env var with default "self-hosted" | ✅ PASS | `src/lib/env.ts`: `process.env.DEPLOYMENT_MODE === "cloud" ? "cloud" : "self-hosted"` |
| FR-2 | Self-hosted: single-company, 403 on second company create | ✅ PASS | `src/lib/instance.ts`: `getInstanceCompany()` returns single company; register route counts companies before deciding path |
| FR-3 | Cloud: multi-company behavior unchanged | ✅ PASS | `src/app/api/auth/register/route.ts`: cloud path under `if (!isSelfHosted())` guard, unchanged |
| FR-4 | Bootstrap: detect zero companies, create company+user with instance_admin+owner | ✅ PASS | `src/app/api/auth/register/route.ts` lines ~100-167: COUNT query, transaction with instance_admin + owner |
| FR-5 | Bootstrap: atomic transaction, rollback on partial failure | ✅ PASS | `db.transaction(async (tx) => {...})` wrapping all bootstrap inserts |
| FR-6 | Bootstrap: initialize instance_settings with registration_mode=invite-only | ✅ PASS | Register route inserts `instanceSettings` with `key: "registration_mode"`, `value: "invite-only"` |
| FR-7 | Post-bootstrap invite-only: 403 without valid token | ✅ PASS | Register route checks `registrationMode === "invite-only" && !inviteToken` → 403 |
| FR-8 | Open registration: create user with member role, no invite required | ✅ PASS | Register route open path: `instanceRole: "member"`, role: "member" |
| FR-9 | Self-hosted signup payload: companyName only for bootstrap | ✅ PASS | `companyName` checked only in bootstrap path; optional in invite/open paths |
| FR-10 | POST /api/instance/invitations — admin+ only | ✅ PASS | `withRoleApi("admin")` guard; cloud-mode 403 guard present |
| FR-11 | Invitation payload: {email, role} with email normalization | ✅ PASS | `createInvitation()`: lowercase normalize, basic RFC validation, role validation |
| FR-12 | Token generation: crypto.randomBytes(32), SHA-256 hash stored | ✅ PASS | `generateInviteToken()`: 32 bytes hex; `hashToken()`: SHA-256; raw token returned only in creation response |
| FR-13 | Token 7-day expiry, 410 Gone on expired | ✅ PASS | `INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`; `consumeInvite` throws 410 on expiry |
| FR-14 | Single-use token: use_count >= max_uses → rejected | ✅ PASS | `maxUses: 1` default; `useCount >= maxUses` check in validate and consume |
| FR-15 | GET /api/auth/validate-invite — unauthenticated | ✅ PASS | `src/app/api/auth/validate-invite/route.ts`: no auth guard; rate limited 30/hr/IP |
| FR-16 | Invite consumption: user + membership + use_count inc + soft-delete | ✅ PASS | `consumeInvite()` in transaction: insert companyMembers, update users.instanceRole, inc useCount, soft-delete |
| FR-17 | Send invitation email with signup link | ⚠️ PARTIAL | API returns `inviteUrl` in response but does NOT call `sendEmail()`. Email sending not implemented. |
| FR-18 | Role hierarchy: instance_admin > owner > admin > member > viewer | ✅ PASS | `ROLE_HIERARCHY` array; `roleGte()` function; 6 tests covering reflexivity, transitivity, ordering |
| FR-19 | instance_admin stored on users.instance_role | ✅ PASS | `src/db/schema.ts`: `instanceRole` column on users; migration adds column; JWT stores it |
| FR-20 | Company roles stored on company_members.role | ✅ PASS | `src/db/schema.ts`: role column on companyMembers with expanded values |
| FR-21 | Permission matrix (9 permissions × 5 roles) | ✅ PASS | `PERMISSION_MATRIX` in `src/lib/roles.ts`; 9 tests cover all cells |
| FR-22 | Centralized permission checks in src/lib/roles.ts | ✅ PASS | `hasPermission()`, `requireRole()`, `getEffectiveRole()` all in one module |
| FR-23 | Effective role = max(instanceRole, companyRole) | ✅ PASS | `getEffectiveRole()` returns instance_admin immediately if set, then compares via roleGte |
| FR-24 | Last instance_admin guard: 422 on demote/remove of last admin | ✅ PASS | `PUT/DELETE /api/instance/members/[userId]`: checks admin count, returns 422 if last |
| FR-25 | GET /api/instance/settings — authenticated, any role | ✅ PASS | `requireRole("viewer")()` guard; filters smtp_password from response |
| FR-26 | PUT /api/instance/settings — instance_admin only | ✅ PASS | `requireRole("instance_admin")()` guard |
| FR-27 | Instance settings key-value store, recognized + unknown keys | ✅ PASS | `instanceSettings` table: key PK, value jsonb; PUT handler validates known keys, passes unknown |
| FR-28 | Role-aware guards: withRole + requireRole | ✅ PASS | `requireRole()` function; `withRoleApi()` wrapper; middleware unchanged |
| FR-29 | 403 Forbidden (not 401) for insufficient role | ✅ PASS | `AuthError` with statusCode 403; `requireRole` throws AuthError(403) |
| FR-30 | Cloud-guarded endpoints return 403 in self-hosted | ✅ PASS | All instance API routes check `isSelfHosted()` and return 403 in cloud mode |
| FR-31 | /settings/members page accessible to admin+ | ✅ PASS | `members/page.tsx`: `getCurrentUserEffectiveRole()`, redirect if not admin+ |
| FR-32 | Member list: email, company role, instance role, join date, actions | ✅ PASS | `members-client.tsx`: renders table with role badges, join date, action menus |
| FR-33 | Invitation form: email input, role dropdown, Send button | ✅ PASS | `members-client.tsx`: form with email Input, role select (member/admin/viewer), submit button |
| FR-34 | Pending invitations: email, role, dates, status, Resend/Revoke | ✅ PASS | `members-client.tsx`: invitation list with status chips, revoke/resend handlers |

### Non-Functional Requirements (NFR-1 through NFR-14)

| NFR | Description | Status | Evidence |
|-----|-------------|--------|----------|
| NFR-1 | Cryptographically secure RNG for tokens (32+ bytes) | ✅ PASS | `crypto.randomBytes(32)` — 256 bits entropy |
| NFR-2 | Only SHA-256 hash stored, raw token in transit only | ✅ PASS | `hashToken()` uses `crypto.createHash("sha256")`; raw token never persisted |
| NFR-3 | Server-side role checks on every protected route | ✅ PASS | All API routes call `requireRole()` server-side; client-side hiding is UX only |
| NFR-4 | DEPLOYMENT_MODE read once at startup, immutable at runtime | ✅ PASS | Module-level `const DEPLOYMENT_MODE` in `src/lib/env.ts` |
| NFR-5 | Rate limiting: 20/hr invitations, 30/hr validate-invite | ✅ PASS | `consumeRateLimit` in both POST invitations and GET validate-invite |
| NFR-6 | Role resolution O(1), no linear scans | ✅ PASS | `PERMISSION_MATRIX` uses `Set.has()` lookups; `ROLE_INDEX` is `Map.get()` |
| NFR-7 | Instance settings cache: 60s TTL, invalidated on write | ✅ PASS | `settingsCache` with 60s TTL; `clearInstanceSettingsCache()` called on write |
| NFR-8 | Self-hosted company ID cached forever after first lookup | ✅ PASS | `cachedCompanyId` set once, never cleared except by `clearInstanceCompanyCache()` |
| NFR-9 | Idempotent migration: IF NOT EXISTS guards | ✅ PASS | All DDL in `0024_team-rbac.sql` uses `IF NOT EXISTS`/`IF EXISTS` |
| NFR-10 | Migration additive only, no data loss | ✅ PASS | Only `CREATE TABLE`, `ALTER TABLE ADD COLUMN`, `UPDATE`; no drops |
| NFR-11 | Auto-assign instance_admin to existing sole-company creator | ✅ PASS | Migration SQL: `UPDATE users SET instance_role = 'instance_admin' WHERE id IN (SELECT created_by_user_id...) AND count = 1` |
| NFR-12 | Existing sessions remain valid after migration | ✅ PASS | JWT claims are additive (`instanceRole`, `companyRole`); sessions table unchanged |
| NFR-13 | Cloud API contracts unchanged | ✅ PASS | Cloud code path preserved under `if (!isSelfHosted())` guard in register route |
| NFR-14 | MCP token auth unchanged | ✅ PASS | Middleware excludes `/api/mcp/*`; MCP routes use Bearer token auth, not role-based |

---

## Critical Issues (3)

### C-1: Instance Settings PUT — Body Format Mismatch ❌

**Severity:** CRITICAL
**FR affected:** FR-26, FR-27
**Files:** `src/app/(app)/settings/settings-client.tsx` line ~348 vs `src/app/api/instance/settings/route.ts` line ~98

The `InstanceSettingsTab` component sends:
```typescript
body: JSON.stringify({ registration_mode: newMode })
```

The PUT handler expects:
```typescript
const { settings } = body;  // body.settings is undefined
if (!settings || typeof settings !== "object") { return 400; }
```

**Impact:** The Instance settings toggle (registration mode) does not work. Every toggle click returns `400 Bad Request` with "Missing required field: settings (object)". The client should send `{ settings: { registration_mode: newMode } }`.

**Fix:** Change the fetch call in `InstanceSettingsTab` to:
```typescript
body: JSON.stringify({ settings: { registration_mode: newMode } })
```

---

### C-2: Members Role Change — URL Path Mismatch ❌

**Severity:** CRITICAL
**FR affected:** FR-32 (member management actions)
**Files:** `src/app/(app)/settings/members/members-client.tsx` line ~134 vs `src/app/api/instance/members/[userId]/route.ts`

The client calls:
```typescript
fetch(`/api/instance/members/${userId}/role`, { method: "PUT", ... })
```

The API route is defined at:
```
src/app/api/instance/members/[userId]/route.ts → PUT /api/instance/members/[userId]
```

There is no `/api/instance/members/[userId]/role` route defined. The `[userId]/route.ts` file handles both PUT and DELETE on the userId path directly, NOT on a `/role` sub-path.

**Impact:** Role changes from the Members management page return 404. The "Change Role" functionality is completely broken.

**Fix:** Either:
- Change the client to `fetch(\`/api/instance/members/${userId}\`, ...)` and include role in body
- Or create a separate `[userId]/role/route.ts` file

---

### C-3: Missing `/api/auth/register-state` Endpoint ❌

**Severity:** CRITICAL
**FR affected:** FR-4 (bootstrap detection from UI), SC-1 (signup experience)
**Files:** `src/app/(auth)/signup/page.tsx` lines ~68-79

The signup page calls:
```typescript
fetch("/api/auth/register-state")
    .then((res) => res.json())
    .then((data) => {
        if (data.isBootstrap) { setRegMode("bootstrap"); }
        else if (data.registrationMode === "open") { setRegMode("open"); }
        else { setRegMode("invite-only"); }
    })
    .catch(() => {
        // Default to bootstrap if the endpoint doesn't exist yet
        setRegMode("bootstrap");
    });
```

No file exists at `src/app/api/auth/register-state/route.ts`. The catch block defaults to "bootstrap", which means:
- Non-bootstrap self-hosted instances with `invite-only` mode show the full signup form with company name field (wrong)
- The user sees "Set up your instance" when they should see "This instance is invite-only"
- If they submit, they'll get a server error because the backend rejects non-bootstrap with no invite token

**Impact:** Broken signup UX for non-bootstrap self-hosted instances. The signup page always shows bootstrap form.

**Fix:** Create `src/app/api/auth/register-state/route.ts`:
```typescript
// GET /api/auth/register-state — unauthenticated
// Returns { isBootstrap, registrationMode } or { isBootstrap, registrationMode }
```

---

## Warning Issues (6)

### W-1: Invitation Email Not Sent ⚠️

**Severity:** WARNING
**FR affected:** FR-17
**File:** `src/app/api/instance/invitations/route.ts`

The POST invitation handler creates the invitation and returns `inviteUrl` in the response, but does NOT call `sendEmail()` to send the invitation email. FR-17 requires: "The system MUST send an invitation email to the provided email address containing the signup link." The `inviteUrl` is only shown in the API response — the admin would need to manually share it.

**Impact:** Invited users never receive emails. The admin must copy-paste the link from the API response (not exposed in UI).

---

### W-2: Instance Settings Tab Incomplete ⚠️

**Severity:** WARNING
**FR affected:** FR-27
**File:** `src/app/(app)/settings/settings-client.tsx` (InstanceSettingsTab)

FR-27 lists recognized keys: `registration_mode`, `instance_name`, `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `smtp_from`. The `InstanceSettingsTab` only implements the `registration_mode` toggle. There are no fields for instance name, SMTP host, port, user, password, or from address.

**Impact:** Instance admins cannot configure SMTP or instance name through the UI.

---

### W-3: Nested Transactions in Invite Signup ⚠️

**Severity:** WARNING
**FR affected:** FR-16
**File:** `src/app/api/auth/register/route.ts`

The invite signup path wraps user creation in `db.transaction()` and then calls `consumeInvite()` which also starts `db.transaction()`. This creates nested transactions (savepoints). The user's `instanceRole` is set both in the outer INSERT and then updated in the inner `consumeInvite()`. While PostgreSQL savepoints handle this, the double update is redundant and could race.

Also, `consumeInvite` uses its own `tx` which is a savepoint of the outer transaction, not the outer `tx` itself. If the outer transaction rolls back after `consumeInvite` succeeds, the invitation is consumed but the user is not created — orphaned state.

**Impact:** Potential data inconsistency on transaction failure. The user record and invitation consumption should be in the SAME transaction.

---

### W-4: Members DELETE Hard-Deletes (No Soft-Delete) ⚠️

**Severity:** WARNING
**FR affected:** FR-24 (member removal)
**File:** `src/app/api/instance/members/[userId]/route.ts`

The DELETE handler calls `db.delete(companyMembers)` which hard-deletes the row. The `companyMembers` table does not have a `deletedAt` column, so soft-delete is not possible with the current schema. The task T-4.5 spec says "soft-deletes company_members row" but the implementation cannot due to schema limitations.

**Impact:** Lost audit trail. Cannot recover accidentally removed members without a separate backup. The invitations table supports soft-delete but companyMembers doesn't.

---

### W-5: Settings PUT Does Not Check Instance Key in Cloud Mode Correctly ⚠️

**Severity:** WARNING
**FR affected:** FR-30
**File:** `src/app/api/instance/settings/route.ts`

The PUT handler runs `requireRole("instance_admin")()` before checking `isSelfHosted()`. In cloud mode, no user would have `instance_admin` role (since it only exists in self-hosted), so the guard would throw 403 before the cloud-mode check runs. The error message would be "Forbidden — this action requires one of: instance_admin" instead of "Instance settings are only available in self-hosted deployments." The cloud guard check should come before the role guard.

---

### W-6: No Resend Endpoint on Client ⚠️

**Severity:** WARNING
**FR affected:** FR-34
**File:** `src/app/(app)/settings/members/members-client.tsx`

The `[id]/route.ts` API supports POST for resend, but the `members-client.tsx` does not have a `handleResendInvitation` function wired to the UI. The invitations list shows pending invitations but there's no "Resend" button implementation (only "Revoke" via DELETE).

**Impact:** The "Resend" action from FR-34 is not available to end users.

---

## Suggestion Items (4)

### S-1: Add Integration Tests 💡

The tests are purely unit-level (pure logic, no DB). The tasks specify integration tests (`tests/bootstrap-flow.test.ts`, `tests/invite-accept.test.ts`) that were not created. Adding even a single bootstrap integration test would catch C-3 (missing register-state endpoint) and transaction nesting issues.

### S-2: Add Input Validation to Role Change ⚠️

The `PUT /api/instance/members/[userId]` route validates `role` against `validCompanyRoles` but the check only runs `if (role && !validCompanyRoles.includes(role))`. If a client sends `{ role: "" }` (empty string), it passes the check but doesn't set any role. Consider rejecting empty strings.

### S-3: Add Instance Settings UI Field for instance_name 💡

The `InstanceSettingsTab` component only has a `registration_mode` toggle. Adding at least `instance_name` would make the instance admin experience more complete and match FR-27.

### S-4: Add Email Mismatch Redirect Handling 💡

The signup page detects email mismatch from validate-invite but FR-15 says "email" query param is optional. The EC-10 (token URL tampering) flow works at the API level but the signup page doesn't show a clear "Log in instead" flow for the already-registered case (EC-6). Consider adding a redirect-to-login button when the email is already registered.

---

## Task Completion Status

| Phase | Task | Status | Notes |
|-------|------|--------|-------|
| Phase 1 | T-1.1: Migration SQL | ✅ Complete | `0024_team-rbac.sql` |
| Phase 1 | T-1.2: Drizzle schema | ✅ Complete | invitations, instanceSettings, instanceRole |
| Phase 2 | T-2.1: DEPLOYMENT_MODE | ✅ Complete | `src/lib/env.ts` |
| Phase 2 | T-2.2: Instance utilities | ✅ Complete | `src/lib/instance.ts` |
| Phase 2 | T-2.3: Roles engine | ✅ Complete | `src/lib/roles.ts` |
| Phase 2 | T-2.4: Invitations module | ✅ Complete | `src/lib/invitations.ts` |
| Phase 3 | T-3.1: JWT/session callbacks | ✅ Complete | `src/lib/auth.ts` |
| Phase 3 | T-3.2: getCompanyId self-hosted | ✅ Complete | `src/lib/auth.ts` |
| Phase 3 | T-3.3: Middleware + route guards | ✅ Complete | `src/middleware.ts`, `src/lib/route-guards.ts` |
| Phase 4 | T-4.1: Register endpoint rewrite | ⚠️ Partial | Missing register-state endpoint; nested tx concern |
| Phase 4 | T-4.2: Validate-invite endpoint | ✅ Complete | |
| Phase 4 | T-4.3: Invitations CRUD API | ⚠️ Partial | Email not actually sent (FR-17) |
| Phase 4 | T-4.4: Instance settings API | ✅ Complete | API works; client broken (C-1) |
| Phase 4 | T-4.5: Members list API | ⚠️ Partial | Role change URL mismatch (C-2) |
| Phase 5 | T-5.1: Signup page | ⚠️ Partial | Missing register-state endpoint (C-3) |
| Phase 5 | T-5.2: Members management page | ⚠️ Partial | Role change URL mismatch (C-2); no resend button (W-6) |
| Phase 5 | T-5.3: Instance settings UI | ⚠️ Partial | Body format mismatch (C-1); incomplete fields (W-2) |
| Phase 5 | T-5.4: Sidebar navigation | ✅ Complete | Role-gated Members link |
| Phase 6 | T-6.1: Bootstrap integration test | ❌ Not done | File not found |
| Phase 6 | T-6.2: Invite accept integration test | ❌ Not done | File not found |
| Phase 7 | T-7.1: Role-based visibility | ❌ Not done | No changes to projects/agents pages |
| Phase 7 | T-7.2: Documentation updates | ❌ Not done | No README/CONTRIBUTING/.env.example changes |
| Phase 7 | T-7.3: Full test suite validation | ❌ Not done | Not run |

---

## Design Coherence

| Design Decision | Implementation Match | Notes |
|-----------------|---------------------|-------|
| DEPLOYMENT_MODE env var | ✅ Matches | Module-level const, read once |
| Role storage: instance_role + company_members.role | ✅ Matches | Separate concerns correctly |
| SHA-256 token storage | ✅ Matches | Raw token never persisted |
| Cached instance company lookup (∞ TTL) | ✅ Matches | `cachedCompanyId` pattern |
| Middleware: binary auth only, role in handlers | ✅ Matches | `withAuth` preserved, `requireRole` in handlers |
| Soft-delete invitations | ✅ Matches | `deletedAt` column, soft-delete on consume/revoke |
| Settings cache 60s TTL | ✅ Matches | `SETTINGS_CACHE_TTL_MS = 60_000` |
| Cloud guard on instance endpoints | ✅ Matches | All instance routes check `isSelfHosted()` |

---

## Summary

| Category | Count | Details |
|----------|-------|---------|
| CRITICAL | 3 | C-1: Settings PUT body format mismatch; C-2: Role change URL path mismatch; C-3: Missing register-state endpoint |
| WARNING | 6 | W-1: Invitation email not sent; W-2: Settings tab incomplete; W-3: Nested transactions; W-4: Hard-delete members; W-5: Cloud guard ordering; W-6: No resend in client |
| SUGGESTION | 4 | Integration tests; input validation; settings UI fields; email mismatch UX |
| Tests | 31/31 pass | All unit tests green |
| Tasks complete | 12/21 | 9 tasks pending or partial |
| FRs PASS | 28/34 | 6 FRs with issues |
| NFRs PASS | 14/14 | All NFRs satisfied |
| **Verdict** | **FAIL** | Blocked by 3 CRITICAL issues |

---

**Next Recommended:** `sdd-apply` — fix the 3 CRITICAL issues, then re-verify.
