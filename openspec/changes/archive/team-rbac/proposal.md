# Proposal: Team RBAC & Instance-Aware Multi-Tenancy

**Change:** `team-rbac`
**Status:** proposed
**Date:** 2026-07-17

---

## 1. Summary

Emperor Claw currently treats every signup as a new company — a SaaS multi-tenant pattern. For the open-source self-hosted release, this is broken: the instance IS the company, and subsequent users must join it, not create competing companies. This change introduces (a) a `DEPLOYMENT_MODE` switch separating self-hosted from cloud behavior, (b) a proper RBAC role hierarchy with instance-level and company-level roles, and (c) an invitation system so admins can onboard team members.

## 2. Motivation

### Current behavior (broken for self-hosted)

```
User A signs up → Company "Acme" created, User A = owner ✓
User B signs up → Company "Beta" created, User B = owner ✗ (WRONG)
```

In a self-hosted deployment, User B should join "Acme" — not create a separate silo. There is no way to add a second person to your instance today.

### Why now

The `OPEN_SOURCE_PLAN.md` Phase 1 targets "make it installable." But installability without team access means the first user is forever alone. The open-source launch is imminent, and this is a **blocking architectural gap** — it's not a polish item, it's a correctness issue for the primary use case.

### License protection

The repo already ships under **FSL-1.1-Apache-2.0** (Functional Source License). Anyone can self-host, modify, and redistribute. They cannot offer Emperor Claw as a competing cloud/SaaS service for 2 years, at which point each version converts to Apache 2.0. This protects the future cloud business without compromising open-source freedoms.

## 3. Scope

### In scope

| Item | Description |
|------|-------------|
| `DEPLOYMENT_MODE` env var | `self-hosted` (default) vs `cloud` — gates signup behavior |
| Instance bootstrap flow | First user creates company, becomes `instance_admin` |
| Self-hosted signup | Invite-only by default; admin can toggle open registration |
| Invitation system | Admin generates time-limited, role-scoped invite tokens; invited users sign up and auto-join |
| RBAC roles | `instance_admin`, `owner`, `admin`, `member`, `viewer` with permission matrix |
| Instance settings | Key-value config for registration mode, instance name, etc. |
| Migration | Existing deployments (single user + single company) auto-migrate: user becomes `instance_admin` |
| Middleware guards | Role-aware route protection replacing the binary auth check |
| UI for member management | Admin dashboard: invite users, change roles, remove members |

### Out of scope (future)

| Item | Why deferred |
|------|-------------|
| Cloud multi-company membership | Requires company switcher UI, cross-company session — significant scope |
| Cloud-specific billing/Stripe | Only relevant when cloud launches |
| SSO / OAuth / SAML | Not needed for v1 self-hosted; common enterprise request, separate change |
| Org chart / team hierarchies | Flat roles sufficient for v1 |
| Audit log for role changes | Nice-to-have, not blocking |

## 4. Approach

### 4.1 Deployment mode switching

```typescript
// src/lib/env.ts
export const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE === 'cloud' 
  ? 'cloud' 
  : 'self-hosted'; // default
```

The default is `self-hosted` because (a) that's the open-source use case, (b) it's the safer default — a cloud deployer must explicitly opt in.

All behavioral branches check `DEPLOYMENT_MODE` directly. No feature flags, no dynamic toggling at runtime. This is an architectural constant, not a setting.

### 4.2 Instance bootstrap (self-hosted)

```
First request to /signup:
  → Query: SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL
  → Result = 0 → "Create your instance" form (company name + admin email + password)
  → Creates company + user + instance_admin membership
  
Subsequent requests to /signup:
  → Registration check:
      invite-only (default): redirect to /login, flash "Contact your admin for an invite"
      open: show signup form → creates user + member membership in existing company
  → Invite flow: /signup?invite=<token> → validates token → creates user + assigned role
```

### 4.3 Role hierarchy

```
instance_admin  ←  exists only in self-hosted mode
  └── owner      ←  company creator (cloud: per-company; self-hosted: same as instance_admin)
       └── admin  ←  can manage members, projects, settings
            └── member  ←  default for invited users, full CRUD on own work
                 └── viewer  ←  read-only
```

**Permission matrix:**

| Permission | instance_admin | owner | admin | member | viewer |
|---|---|---|---|---|---|
| Instance settings (registration, SMTP, etc.) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite/remove users | ✅ | ✅ | ✅ | ❌ | ❌ |
| Change member roles | ✅ | ✅ | ❌ | ❌ | ❌ |
| Full CRUD all projects/tasks | ✅ | ✅ | ✅ | ❌ | ❌ |
| CRUD own tasks | ✅ | ✅ | ✅ | ✅ | ❌ |
| View all projects/tasks | ✅ | ✅ | ✅ | ✅ | ✅ |
| API/MCP token management | ✅ | ✅ | ✅ | ❌ | ❌ |
| Agent management | ✅ | ✅ | ✅ | ✅ | ❌ |

### 4.4 Invitation system

```
POST /api/instance/invitations (admin only)
  Body: { email, role: "member"|"admin"|"viewer" }
  → Generates invite token (SHA-256 hashed, stored)
  → Sends email with /signup?invite=<token>&email=<email>
  → Token: 7-day expiry, single-use

GET /api/auth/validate-invite?token=<token>
  → Validates token exists, not expired, not exceeded max uses
  → Returns { valid: true, email, role, companyName }

POST /api/auth/register (with invite token)
  → Validates invite
  → Creates user
  → Creates company_members row with role from invite
  → Deletes used invite
  → Does NOT create a new company
```

### 4.5 Database changes

**New tables:**

- `invitations`: id, company_id, created_by_user_id, email (nullable for open invites), token_hash, role, max_uses, use_count, expires_at, created_at
- `instance_settings`: key (text PK), value (jsonb), updated_at

**Modified tables:**

- `users`: add `instance_role` (text, default `'member'`, values: `'instance_admin'` | `'member'`)
- `company_members`: role expands from `'owner'` to `'owner' | 'admin' | 'member' | 'viewer'`

**Migration strategy:**

Existing rows auto-migrate: any user who is the sole member of a company and `created_by_user_id` matches gets `instance_role = 'instance_admin'`. The existing `role = 'owner'` is preserved on `company_members`.

### 4.6 Middleware & auth utilities

- `src/lib/roles.ts` — new module: `hasPermission(user, permission)`, `requireRole(...roles)`, `getEffectiveRole(user, companyId)`
- `src/lib/instance.ts` — new module: `getInstanceSettings()`, `isSelfHosted()`, `isCloud()`
- `src/middleware.ts` — refactored: route-specific role checks, not just binary auth
- `src/lib/auth.ts` — `getCompanyId()` updated to handle self-hosted (always returns the one company)

## 5. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Migration breaks existing single-user deployments | High | Migration is idempotent and non-destructive; tested against current production DB snapshot |
| Invite token leakage (email in plain text) | Medium | Token is SHA-256 hashed in DB; email is part of the URL for UX but invite validation checks both token AND email match |
| Self-hosted admin locks themselves out | Low | `instance_admin` cannot be demoted below admin; at least one admin must always exist (enforced in API) |
| Cloud code paths accidentally activate in self-hosted | Medium | `DEPLOYMENT_MODE` is checked at the API route level, not just UI; self-hosted routes reject cloud-only operations with 403 |
| Existing API consumers (MCP tokens) break | Low | MCP tokens are company-scoped and continue working; RBAC only gates UI routes and new API endpoints |

## 6. Alternatives Considered

### Separate branches for self-hosted vs cloud

**Rejected.** Long-lived branches diverge, making it impossible to share bug fixes and features. Every mature open-core company (Supabase, PostHog, Cal.com, Plane) uses a single codebase with deployment-mode gating. The `DEPLOYMENT_MODE` env var is the industry standard pattern.

### License-only protection (MIT + "don't compete")

**Rejected.** MIT allows anyone to offer a competing SaaS. The FSL is already in place and provides real legal protection. No additional code-level obfuscation needed.

### "Just add RBAC, keep multi-company always"

**Rejected.** In self-hosted mode, allowing arbitrary company creation creates confusion (why are there 5 companies on my personal instance?) and security issues (User A's company is invisible to User B, but both are on the same DB). Forcing single-company in self-hosted is a feature, not a limitation.

## 7. Success Criteria

1. **Self-hosted bootstrap**: First user creates instance, becomes `instance_admin`. Second user CANNOT create a new company via normal signup.
2. **Invitation flow**: Admin generates invite → invited user signs up → auto-joined with correct role → invite consumed.
3. **Role enforcement**: A `viewer` cannot create tasks. A `member` cannot invite users. Only `instance_admin` can change registration settings.
4. **Cloud path preserved**: Setting `DEPLOYMENT_MODE=cloud` restores the original multi-company signup behavior. No code removed, only gated.
5. **Zero-downtime migration**: Existing deployments upgrade without data loss. Existing sessions remain valid.
6. **Tests pass**: Unit tests for role resolution, invitation validation, signup flow branching. Integration smoke test for the self-hosted bootstrap flow.
