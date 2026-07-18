# Archive Report: Team RBAC & Instance-Aware Multi-Tenancy

**Change:** `team-rbac`
**Archived:** 2026-07-18
**Archive Mode:** `openspec`
**Archive Type:** **intentional-with-warnings** — archived with known unresolved issues per explicit orchestrator directive

---

## Executive Summary

The `team-rbac` change introduced a full RBAC system with instance-aware multi-tenancy gating for Emperor Claw's self-hosted deployments. The implementation spans 24 files (13 new, 11 modified) across the stack: database schema, core permission engine, auth middleware, API routes, and UI pages. All core libraries are functional, 36 unit tests pass, and end-to-end flows (bootstrap, invitation, token consumption) work on a fresh Docker Postgres instance.

The change was archived with **3 known CRITICAL issues** from the verification report that remain unresolved: an API-client body format mismatch on instance settings, a URL path mismatch on member role changes, and a missing `register-state` endpoint causing signup page fallback. These are noted below for post-archive remediation.

---

## What Was Accomplished

### Core Infrastructure

| Component | Status | Details |
|-----------|--------|---------|
| `DEPLOYMENT_MODE` env var | ✅ | `self-hosted` default, `cloud` opt-in; read once at startup |
| Role hierarchy engine (`src/lib/roles.ts`) | ✅ | 5-tier: `instance_admin > owner > admin > member > viewer` |
| Permission matrix | ✅ | 9 permissions × 5 roles, O(1) `Set.has()` lookups |
| Instance utilities (`src/lib/instance.ts`) | ✅ | Cached company lookup (∞ TTL), settings cache (60s TTL) |
| Invitations module (`src/lib/invitations.ts`) | ✅ | Token generation (SHA-256), validation, consumption, revocation |

### Database

| Artifact | Status | Details |
|----------|--------|---------|
| Migration `0024_team-rbac.sql` | ✅ | Idempotent, additive-only, `IF NOT EXISTS` guards |
| `invitations` table | ✅ | token_hash, role, max_uses, use_count, expires_at, soft-delete |
| `instance_settings` table | ✅ | key-value JSONB store |
| `users.instance_role` column | ✅ | `'instance_admin'` or `'member'` |
| Auto-migration of existing sole admin | ✅ | Existing sole-company creator → `instance_admin` |

### API Routes

| Route | Status | Details |
|-------|--------|---------|
| `POST /api/auth/register` (self-hosted) | ✅ | Bootstrap, invite signup, open registration, invite-only rejection |
| `GET /api/auth/validate-invite` | ✅ | Unauthenticated, rate-limited (30/hr/IP) |
| `POST /api/instance/invitations` | ✅ | Admin+ guard, email normalization, 7-day expiry |
| `GET /api/instance/invitations` | ✅ | List pending invitations with status |
| `DELETE /api/instance/invitations/[id]` | ✅ | Soft-delete revocation |
| `GET /api/instance/settings` | ✅ | Any authenticated role, smtp_password filtered |
| `PUT /api/instance/settings` | ✅ | instance_admin guard, cache invalidation |
| `GET /api/instance/members` | ✅ | Admin+ guard, role + join date |
| `PUT /api/instance/members/[userId]` | ✅ | Role change with last-admin guard (422) |
| `DELETE /api/instance/members/[userId]` | ✅ | Member removal with last-admin guard |

### Middleware & Auth

- `withAuth` preserved for all `(app)` routes — zero breakage
- `requireRole(...roles)` guard function with 401 vs 403 distinction
- JWT extended with `instanceRole` and `companyRole` claims (additive, backward-compatible)
- `getCompanyId()` uses cached single-company lookup in self-hosted mode
- Cloud-mode guards on all instance-level endpoints (403 in cloud mode)
- MCP/webhook endpoints excluded from role-based auth (unchanged)

### UI Pages

| Page | Route | Status |
|------|-------|--------|
| Signup page | `/signup` | Bootstrap / invite / invite-only blocked modes |
| Member management | `/dashboard/members` | Member list, invite form, role change, remove, pending invitations |
| Instance settings | `/dashboard/settings` | Registration mode toggle, instance name display |
| Sidebar navigation | `app-sidebar.tsx` | Role-gated "Members" link (admin+) |

### Testing

| Suite | Tests | Status |
|-------|-------|--------|
| Role hierarchy (`roleGte`) | 6 | ✅ All passing |
| Permission matrix (`hasPermission`) | 9 | ✅ All passing |
| Effective role resolution | 4 | ✅ All passing |
| Invitation token validation (pure logic) | 12 | ✅ All passing |
| **Total** | **31** (apply-progress) / **36** (user report) | ✅ All passing |

### Documentation

- `README.md`: Added "Team Setup (Self-Hosted)" section with bootstrap, invitation, and role instructions
- `.env.example`: Already had `DEPLOYMENT_MODE=self-hosted` entry

### Flow Validation

- ✅ Self-hosted bootstrap on fresh Docker Postgres: first user → `instance_admin`, company created, `registration_mode = invite-only`
- ✅ Invitation flow end-to-end: create → validate → consume → membership created → token soft-deleted
- ✅ Invite-only enforcement: unauthenticated signup without token → 403
- ✅ Invited signup: token consumed, user created with correct role, auto-joined to existing company

---

## Known Unresolved Issues (from Verification Report)

> **⚠️ ARCHIVE NOTE**: These 3 CRITICAL and 6 WARNING issues were present in the `verify-report.md` at archive time. The orchestrator explicitly directed this archive with full knowledge of these issues. They remain as post-archive remediation items.

### CRITICAL (3)

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| **C-1** | Instance Settings PUT body format mismatch — client sends `{ registration_mode: X }` but server expects `{ settings: { registration_mode: X } }` | Registration mode toggle returns 400 | `settings/settings-client.tsx` vs `api/instance/settings/route.ts` |
| **C-2** | Members Role Change URL path mismatch — client calls `/api/instance/members/${userId}/role` but API is at `/api/instance/members/${userId}` | Role change from UI returns 404 | `members/members-client.tsx` vs `api/instance/members/[userId]/route.ts` |
| **C-3** | Missing `GET /api/auth/register-state` endpoint — signup page calls this to detect bootstrap vs invite-only vs open mode; falls back to bootstrap on catch | Signup page always shows bootstrap form for non-bootstrap instances | `signup/page.tsx` — no corresponding route file exists |

### WARNING (6)

| ID | Issue |
|----|-------|
| **W-1** | Invitation email not actually sent — `sendEmail()` not called (FR-17) |
| **W-2** | Instance settings UI incomplete — only `registration_mode`, missing `instance_name`, SMTP fields (FR-27) |
| **W-3** | Nested transactions in invite signup — potential data inconsistency on partial failure |
| **W-4** | Members DELETE hard-deletes (no soft-delete on `companyMembers`) |
| **W-5** | Settings PUT runs role guard before cloud-mode check — wrong error message in cloud mode |
| **W-6** | No "Resend" button wired in member management UI (FR-34) |

### Incomplete Tasks (Phases 6–7)

| Task | Description | Status |
|------|-------------|--------|
| T-6.1 | Bootstrap flow integration test | ❌ Not done |
| T-6.2 | Invite acceptance integration test | ❌ Not done |
| T-7.1 | Role-based visibility in existing pages | ❌ Not done |
| T-7.2 | Documentation updates (README, CONTRIBUTING, .env.example) | ⚠️ Partial — README updated, .env.example already had entry |
| T-7.3 | Full test suite validation (`tsc --noEmit`, lint) | ❌ Not done |

---

## Artifacts Archived

| Artifact | Path |
|----------|------|
| Proposal | `openspec/changes/archive/team-rbac/proposal.md` |
| Spec | `openspec/changes/archive/team-rbac/spec.md` |
| Design | `openspec/changes/archive/team-rbac/design.md` |
| Tasks | `openspec/changes/archive/team-rbac/tasks.md` |
| Verify Report | `openspec/changes/archive/team-rbac/verify-report.md` |
| Apply Progress | `openspec/changes/archive/team-rbac/apply-progress.md` |
| State | `openspec/changes/archive/team-rbac/state.yaml` |
| **Archive Report** | `openspec/changes/archive/team-rbac/archive-report.md` |

### Source of Truth

No main specs existed at `openspec/specs/` prior to this change (only `.gitkeep`). The `spec.md` is a standalone full spec — no delta merge was performed. Future changes that touch RBAC/instance domains should create `openspec/specs/rbac/spec.md` or `openspec/specs/instance/spec.md` as main specs and use delta specs going forward.

---

## Post-Archive Checklist

- [ ] **Remove** `openspec/changes/team-rbac/` (the active change folder) — all artifacts now live in the archive
- [ ] **Fix C-1**: Align Instance Settings PUT body format between client and server
- [ ] **Fix C-2**: Align Members role change URL path between client and server
- [ ] **Fix C-3**: Create `src/app/api/auth/register-state/route.ts`
- [ ] **Fix W-1**: Wire `sendEmail()` in invitation creation handler
- [ ] **Complete Phases 6–7**: Integration tests, role-based visibility, full test suite validation

---

## SDD Cycle Status

| Phase | Status |
|-------|--------|
| Explore | ✅ Done |
| Propose | ✅ Done |
| Spec | ✅ Done |
| Design | ✅ Done |
| Tasks | ✅ Done |
| Apply | ✅ Done (partial — phases 6–7 incomplete) |
| Verify | ✅ Done (3 CRITICAL, 6 WARNING) |
| **Archive** | ✅ **Done** (intentional-with-warnings) |

---

*Archived by SDD Archive Executor on 2026-07-18. The change is closed. Remaining issues are documented above for post-archive remediation.*
