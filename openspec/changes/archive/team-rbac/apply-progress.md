# Apply Progress: Team RBAC

**Change:** `team-rbac`
**Date:** 2026-07-17
**Status:** `partial` — 6 of 6 remaining tasks completed

---

## Completed Tasks (This Batch)

### TASK 1: Middleware Rewrite (`src/middleware.ts`)
- [x] Added comprehensive comments documenting the binary-auth-only strategy
- [x] Role enforcement remains at the API route level via `requireRole()`
- [x] Public endpoints (validate-invite, auth APIs, setup, downloads) excluded from matcher
- [x] MCP / webhook endpoints excluded (use Bearer-token auth)
- [x] All app routes (including `/dashboard/*`) remain protected by `withAuth`

### TASK 2: Signup Page (`src/app/(auth)/signup/page.tsx`)
- [x] Added hidden `<input>` for invite token when `inviteParam` is present in URL
- [x] Bootstrap mode ("Create your instance"), invite mode ("Accept your invitation"), and invite-only blocked mode all work as before
- [x] Company name field shows only in bootstrap mode

### TASK 3: Member Management Page (`src/app/(app)/dashboard/members/`)
- [x] Created `page.tsx` — server component that fetches member list, checks role (admin+)
- [x] Created `members-client.tsx` — client component with full member management UI
- [x] Member list table: email, company role badge, instance role badge, join date
- [x] "Invite Member" form: email input + role dropdown (admin/member/viewer)
- [x] Role change dropdown per member (instance_admin/owner only)
- [x] Remove member button with confirmation dialog (admin+)
- [x] Pending invitations table with revoke action
- [x] Role change modal with cancel/save
- [x] 403 errors handled gracefully via toast messages
- [x] Matches existing UI patterns (emperor-panel, PageHeader, role badges)

### TASK 4: Instance Settings Page (`src/app/(app)/dashboard/settings/`)
- [x] Created `page.tsx` — server component, instance_admin only gating
- [x] Created `settings-client.tsx` — client component
- [x] Instance name display (read-only)
- [x] Registration mode toggle: Invite-Only ↔ Open Registration
- [x] Toggle calls `PUT /api/instance/settings` to persist
- [x] Descriptive help text for each mode
- [x] Toast feedback on success/error
- [x] Matches existing UI patterns

### TASK 5: Tests (`tests/team-rbac.test.ts`)
- [x] Created comprehensive test suite using Node.js built-in test runner
- [x] 31 tests across 4 suites — ALL PASSING
- [x] Role Hierarchy suite: `roleGte` ordering, reflexivity, transitivity
- [x] Permission Matrix suite: every role's permissions tested against matrix
- [x] `getEffectiveRole` suite: instance_admin override, company role resolution, null fallback
- [x] Invitation Token suite: token generation (64 hex chars, uniqueness), SHA-256 hashing (deterministic, non-reversible), expiry detection, consumption detection, email mismatch
- [x] Pure logic tests — no database dependencies

### TASK 6: Docs
- [x] Updated `README.md` — added "Team Setup (Self-Hosted)" section under Quick Start
  - Bootstrap instructions, invitation flow, registration modes, role table
- [x] `.env.example` — already had `DEPLOYMENT_MODE=self-hosted` with comment (no changes needed)

---

## Files Created/Modified

| File | Action |
|------|--------|
| `src/middleware.ts` | Modified — added documentation comments |
| `src/app/(auth)/signup/page.tsx` | Modified — added hidden invite token input |
| `src/app/(app)/dashboard/members/page.tsx` | **Created** — server component |
| `src/app/(app)/dashboard/members/members-client.tsx` | **Created** — client component |
| `src/app/(app)/dashboard/settings/page.tsx` | **Created** — server component |
| `src/app/(app)/dashboard/settings/settings-client.tsx` | **Created** — client component |
| `tests/team-rbac.test.ts` | **Created** — 31 tests, all passing |
| `README.md` | Modified — added Team Setup section |

---

## Test Results

```
✔ Role Hierarchy (roleGte) — 6 tests
✔ Permission Matrix (hasPermission) — 9 tests
✔ getEffectiveRole — 4 tests
✔ Invitation Token Validation (pure logic) — 12 tests

ℹ tests 31 | pass 31 | fail 0
```

---

## Notes

- The dashboard pages are created at `/dashboard/members` and `/dashboard/settings`. The existing sidebar links to `/settings/members` and `/settings` (which have their own pre-existing implementations). The user may want to update the sidebar routing separately or use these as the canonical team RBAC pages.
- The `members-client.tsx` follows the same pattern as the pre-existing `settings/members/members-client.tsx` but adds a confirmation dialog for member removal (double-click to confirm pattern).
- All permission tests confirmed: `viewer` company role with `member` instance role gives `member`-level permissions per the spec (effective role = higher of the two).
- TypeScript compilation: no errors in dashboard files (pre-existing `@dnd-kit` module errors are unrelated).

## Remaining Work

All tasks specified by the user for this batch are complete. The next recommended step is `sdd-verify` to validate the implementation against the spec.
