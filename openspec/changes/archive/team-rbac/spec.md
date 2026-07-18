# Team RBAC & Instance-Aware Multi-Tenancy — Specification

**Change:** `team-rbac`
**Spec Version:** 1.0
**Date:** 2026-07-17

---

## 1. Functional Requirements

### Deployment Mode

**FR-1** — The system MUST read a `DEPLOYMENT_MODE` environment variable at startup. Accepted values are `"cloud"` and `"self-hosted"`. Any other value or absence of the variable MUST default to `"self-hosted"`.

**FR-2** — When `DEPLOYMENT_MODE` is `"self-hosted"`, the system MUST enforce single-company semantics: exactly one company MAY exist per instance. Any endpoint or code path that would create a second company MUST return a `403 Forbidden` error.

**FR-3** — When `DEPLOYMENT_MODE` is `"cloud"`, the system MUST preserve the existing multi-company signup behavior unchanged. No cloud code paths SHALL be removed.

### Instance Bootstrap (Self-Hosted)

**FR-4** — On the first signup request to `POST /api/auth/register` in self-hosted mode, the system MUST detect that zero non-deleted companies exist. If true, the system MUST create the company, the user, and assign the user the `instance_admin` role AND the `owner` company-level role.

**FR-5** — The bootstrap flow MUST succeed atomically: if any part of creating the user, company, or membership fails, the entire transaction MUST roll back, leaving no partial state.

**FR-6** — After bootstrap completes, the system MUST initialize a default `instance_settings` row with `registration_mode = 'invite-only'`.

### Self-Hosted Signup (Post-Bootstrap)

**FR-7** — After bootstrap, `POST /api/auth/register` in self-hosted mode MUST reject requests that do not include a valid invitation token when `registration_mode` is `invite-only`. The rejection MUST return `403 Forbidden` with a message directing the user to contact their administrator.

**FR-8** — When `registration_mode` is `open`, `POST /api/auth/register` in self-hosted mode MUST accept signups without an invitation token. The new user MUST be assigned the `member` role at the company level and `member` at the instance level.

**FR-9** — The system MUST NOT require `companyName` in the registration payload for self-hosted signups that are not the bootstrap request. The payload MUST be: `{ email, password, inviteToken? }`. The `inviteToken` field is required when `registration_mode` is `invite-only`; it is optional when `open`.

### Self-Hosted Invitation System

**FR-10** — The system MUST provide `POST /api/instance/invitations` to create invitation tokens. This endpoint MUST be accessible only to users with role `instance_admin`, `owner`, or `admin`.

**FR-11** — The invitation payload MUST accept: `{ email: string, role: 'member' | 'admin' | 'viewer' }`. The `email` field MUST be a valid RFC 5321 email address and MUST be normalized to lowercase.

**FR-12** — On creation, the system MUST generate a cryptographically random token (minimum 32 bytes), store its SHA-256 hash in the `invitations` table, and return the raw token ONLY in the creation response. The raw token MUST NOT be stored.

**FR-13** — Every invitation token MUST have a 7-day expiry from creation (`expires_at = created_at + 7 days`). After expiry, the token MUST be rejected with `410 Gone` and a message indicating the invitation has expired.

**FR-14** — Each invitation token MUST be single-use by default (`max_uses = 1`). After `use_count >= max_uses`, the token MUST be rejected.

**FR-15** — The system MUST provide `GET /api/auth/validate-invite?token=<rawToken>` that validates whether a token is still usable. The response MUST include `{ valid: boolean, email: string, role: string, companyName: string }`. This endpoint MUST be unauthenticated.

**FR-16** — Upon successful registration with a valid invitation token, the system MUST (a) create the user, (b) create a `company_members` row with the role specified in the invitation, (c) set `instance_role` on the user to the invitation role (unless the invitation role is `viewer`, in which case `instance_role` is `member`), (d) increment `use_count` on the invitation, (e) delete the invitation row if `use_count >= max_uses`.

**FR-17** — The system MUST send an invitation email to the provided email address containing the signup link with the invitation token and email as query parameters: `/signup?invite=<rawToken>&email=<encodedEmail>`.

### Role Hierarchy

**FR-18** — The system MUST implement the following role hierarchy, where higher roles inherit all permissions of lower roles:

```
instance_admin
  └── owner
       └── admin
            └── member
                 └── viewer
```

**FR-19** — `instance_admin` is an instance-level role stored on the `users` table (`instance_role` column). It exists only in self-hosted mode and conveys full administrative authority over the entire instance.

**FR-20** — `owner`, `admin`, `member`, and `viewer` are company-level roles stored on the `company_members` table (`role` column).

**FR-21** — The system MUST enforce the following permission matrix:

| Permission | instance_admin | owner | admin | member | viewer |
|---|---|---|---|---|---|
| Manage instance settings (registration mode, SMTP, instance name) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite users | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remove users from company | ✅ | ✅ | ✅ | ❌ | ❌ |
| Change member roles (promote/demote) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Full CRUD on all projects/tasks (any owner) | ✅ | ✅ | ✅ | ❌ | ❌ |
| CRUD own projects/tasks | ✅ | ✅ | ✅ | ✅ | ❌ |
| View all projects/tasks | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manage API/MCP tokens | ✅ | ✅ | ✅ | ❌ | ❌ |
| Manage agents (create, configure, delete) | ✅ | ✅ | ✅ | ✅ | ❌ |

**FR-22** — Permission checks MUST be centralized in a single module (`src/lib/roles.ts`) exposing the following functions:

- `hasPermission(user, permission, companyId?)` → `boolean`
- `requireRole(...roles)` → middleware/guard that throws or redirects on insufficient role
- `getEffectiveRole(user, companyId?)` → resolves the highest applicable role for the user

**FR-23** — For the purpose of permission resolution, a user's effective role is the higher of their instance role (`instance_role`) and their company role (`company_members.role`), resolved as follows: `instance_admin` maps to highest priority; company roles map per the hierarchy in FR-18.

**FR-24** — The `instance_admin` role MUST NOT be demotable below `admin` at the company level. The system MUST enforce that at least one user retains `instance_admin` status at all times. Attempting to demote or remove the last `instance_admin` MUST return `422 Unprocessable Entity`.

### Instance Settings

**FR-25** — The system MUST provide `GET /api/instance/settings` to retrieve all instance settings. This endpoint MUST require authentication but no specific role.

**FR-26** — The system MUST provide `PUT /api/instance/settings` to update instance settings. This endpoint MUST require `instance_admin` role.

**FR-27** — Instance settings MUST be stored as key-value pairs in the `instance_settings` table. Recognized keys include:

- `registration_mode`: `'invite-only'` (default) | `'open'`
- `instance_name`: `string` — display name for the instance
- `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `smtp_from`: SMTP configuration

Unknown keys MUST be accepted and stored without validation to allow forward compatibility.

### Middleware & Route Protection

**FR-28** — The existing binary auth middleware (`withAuth` from next-auth) MUST be augmented with role-aware guards. Each protected API route MUST declare its minimum required role.

**FR-29** — Routes that require specific roles MUST return `403 Forbidden` (not `401 Unauthorized`) when the authenticated user has insufficient role. This distinguishes "you are not logged in" from "you lack permission."

**FR-30** — API routes gated to cloud-only operation MUST return `403 Forbidden` with body `{ error: "This operation is only available in cloud deployments." }` when `DEPLOYMENT_MODE` is `"self-hosted"`.

### Member Management UI

**FR-31** — The system MUST provide an admin dashboard page (`/settings/members`) accessible to users with role `instance_admin`, `owner`, or `admin`.

**FR-32** — The member list MUST display: user email, company role, instance role (in self-hosted mode), join date, and a contextual actions menu (change role, remove).

**FR-33** — The invitation form on the member management page MUST include: email input, role dropdown (`member`, `admin`, `viewer`), and a "Send Invitation" submit button.

**FR-34** — Pending invitations MUST be displayed in the member management UI with: invited email, invited role, creation date, expiry date, status (pending/expired/consumed), and a "Resend" / "Revoke" action.

---

## 2. Non-Functional Requirements

### Security

**NFR-1** — Invitation tokens MUST be generated using a cryptographically secure random number generator (`crypto.randomBytes` or equivalent) with a minimum of 32 bytes of entropy.

**NFR-2** — Only the SHA-256 hash of invitation tokens MUST be stored in the database. Raw tokens MUST exist only in memory during creation and in the invitation email/signup URL.

**NFR-3** — Role checks MUST be performed server-side on every protected API route. Client-side UI hiding of elements (e.g., hiding the "Invite" button from viewers) is a UX convenience and MUST NOT be relied upon for security.

**NFR-4** — The `DEPLOYMENT_MODE` environment variable MUST be read once at process startup and MUST NOT be mutable at runtime. No API endpoint SHALL allow changing the deployment mode.

**NFR-5** — Rate limiting MUST apply to invitation creation (max 20 per hour per admin user) and invitation validation (max 30 per hour per IP).

### Performance

**NFR-6** — Role resolution (FR-22) MUST execute in constant time with respect to the number of users in the company. No linear scans of the members table for permission checks.

**NFR-7** — The instance settings lookup MUST be cached in application memory with a 60-second TTL. Settings updates MUST invalidate the cache.

**NFR-8** — The self-hosted company ID lookup (needed on every request to resolve `companyId`) MUST be cached after first retrieval. The cache MUST be invalidated only on process restart (the company ID is immutable after bootstrap).

### Migration Safety

**NFR-9** — The migration MUST be idempotent. Running it multiple times MUST produce the same result. All DDL statements MUST use `IF NOT EXISTS` or equivalent guards.

**NFR-10** — The migration MUST NOT delete or alter any existing data. It MUST only add columns and tables. Existing `role = 'owner'` values in `company_members` MUST be preserved.

**NFR-11** — The migration MUST auto-detect the existing sole user + sole company and assign `instance_role = 'instance_admin'` to that user.

**NFR-12** — Existing sessions MUST remain valid after migration. The `sessions` table is unchanged. The JWT payload MUST be extended to include `instanceRole` and `companyRole` without invalidating existing tokens (new claims added; existing claims preserved).

### Backward Compatibility

**NFR-13** — All existing API endpoints that were publicly accessible (e.g., `POST /api/auth/register`, `POST /api/auth/[...nextauth]`) MUST maintain their existing request/response contracts when `DEPLOYMENT_MODE` is `"cloud"`.

**NFR-14** — Existing MCP token authentication MUST continue to work unchanged. MCP tokens are company-scoped and bypass the role-based middleware.

---

## 3. User Scenarios

### SC-1: Self-Hosted First-Time Bootstrap

**GIVEN** a fresh Emperor Claw installation with an empty database and `DEPLOYMENT_MODE=self-hosted`
**WHEN** Alice navigates to `/signup` and submits the registration form with `{ email: "alice@acme.com", password: "securePass123", companyName: "Acme Corp", acceptBetaDisclaimer: true }`
**THEN** the system creates:
- A `users` row for Alice with `instance_role = 'instance_admin'`
- A `companies` row named "Acme Corp" with `created_by_user_id = Alice's user ID`
- A `company_members` row linking Alice to Acme Corp with `role = 'owner'`
- An `instance_settings` row with `registration_mode = 'invite-only'`
**AND** Alice receives an email verification email
**AND** Alice, after verifying, can log in and access the admin dashboard at `/settings/members`
**AND** The signup form no longer shows a "Company Name" field for subsequent visitors

### SC-2: Admin Invites a Team Member

**GIVEN** Alice is logged in as `instance_admin` of "Acme Corp" in self-hosted mode with `registration_mode = 'invite-only'`
**WHEN** Alice navigates to `/settings/members`, clicks "Invite Member", fills in `{ email: "bob@acme.com", role: "member" }`, and submits
**THEN** the system:
- Creates an invitation row with `email = "bob@acme.com"`, `role = "member"`, `expires_at = now + 7 days`, and a hashed token
- Sends an email to bob@acme.com with a link: `https://<instance>/signup?invite=<rawToken>&email=bob%40acme.com`
- Displays the pending invitation in Alice's member list

**WHEN** Bob clicks the invitation link and arrives at `/signup?invite=<rawToken>&email=bob@acme.com`
**THEN** the system:
- Pre-populates the email field with bob@acme.com (read-only)
- Validates the invitation token is valid, unexpired, and unused
- Shows "You've been invited to join Acme Corp as a member"

**WHEN** Bob sets a password and submits the form
**THEN** the system:
- Creates a `users` row for Bob with `instance_role = 'member'`
- Creates a `company_members` row for Bob with `role = 'member'` and `company_id = Acme Corp`
- Increments `use_count` on the invitation to 1
- Since `use_count >= max_uses`, deletes the invitation row
- Bob can now log in and see Acme Corp's projects

### SC-3: Role-Based Access Enforcement

**GIVEN** Acme Corp has three members:
- Alice (`instance_admin` / `owner`)
- Bob (`member`)
- Carol (`viewer`)

**WHEN** Bob tries to access `POST /api/instance/invitations` to invite Dave
**THEN** the system returns `403 Forbidden` — Bob's `member` role does not include the "Invite users" permission

**WHEN** Carol tries to create a task via `POST /api/tasks`
**THEN** the system returns `403 Forbidden` — Carol's `viewer` role only allows read operations

**WHEN** Carol navigates to `/projects` (the project list page)
**THEN** the system renders the project list in read-only mode (no "New Project" button, no edit controls)

**WHEN** Alice accesses `PUT /api/instance/settings` to change `registration_mode` to `"open"`
**THEN** the system accepts the change — Alice's `instance_admin` role includes instance settings management
**AND** subsequent unauthenticated visitors to `/signup` see the full registration form (without needing an invite token)

**WHEN** Alice accesses `POST /api/instance/invitations` to invite Dave as an `admin`
**THEN** the system accepts — Alice's `instance_admin` role includes user invitation
**AND** Dave, upon accepting the invite, is created with `company_members.role = 'admin'` and `instance_role = 'member'`

---

## 4. Edge Cases

### EC-1: Expired Invitation

**GIVEN** an invitation token was created 8 days ago (past the 7-day expiry)
**WHEN** the invited user navigates to `/signup?invite=<expiredToken>`
**THEN** the system returns the signup page with an error banner: "This invitation has expired. Please contact your administrator for a new one."
**AND** `GET /api/auth/validate-invite?token=<expiredToken>` returns `{ valid: false, reason: "expired" }`

### EC-2: Already-Consumed Invitation

**GIVEN** an invitation token that was already used once (`use_count = 1, max_uses = 1`)
**WHEN** another user (or the same user) attempts to sign up with the same token
**THEN** the system returns `400 Bad Request` with `{ error: "This invitation has already been used." }`

### EC-3: Duplicate Email Invitation

**GIVEN** Alice the admin invites bob@acme.com as a `member`
**WHEN** Alice attempts to invite bob@acme.com again while the first invitation is still pending (not expired, not consumed)
**THEN** the system returns `409 Conflict` with `{ error: "An active invitation already exists for this email address." }`
**AND** the response includes the existing invitation's expiry date so Alice can decide whether to wait or revoke and reissue

### EC-4: Last Admin Leaves or Is Demoted

**GIVEN** Acme Corp has exactly one `instance_admin` (Alice) and Bob is an `admin`
**WHEN** Alice attempts to change her own role to `member` (or Bob attempts to demote Alice)
**THEN** the system returns `422 Unprocessable Entity` with `{ error: "Cannot remove the last instance admin. Promote another user to instance_admin first." }`

### EC-5: Self-Serve Role Change by Last Admin

**GIVEN** Alice is the sole `instance_admin`
**WHEN** Alice promotes Bob to `instance_admin` (so there are now two)
**THEN** the promotion succeeds
**AND** Alice can now safely demote herself to `member` because at least one `instance_admin` remains

### EC-6: Invitation Email Already Registered

**GIVEN** an invitation exists for bob@acme.com
**WHEN** Bob has already signed up independently (e.g., via `registration_mode = 'open'` before the invite was sent)
**AND** Bob clicks the invitation link
**THEN** the system detects that Bob's email already has a `users` row
**AND** instead of showing the signup form, it shows: "You already have an account. Log in to accept the invitation to Acme Corp."
**AND** after Bob logs in, the system creates the `company_members` row with the invited role and consumes the invitation

### EC-7: Bootstrap After Partial Rollback

**GIVEN** the bootstrap transaction failed partway through (e.g., DB connection dropped after user creation but before company creation)
**AND** the transaction rolled back, leaving no company but potentially other noise
**WHEN** the user retries bootstrap
**THEN** the system detects `SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL` returns 0 and initiates bootstrap again
**AND** because the previous user creation was rolled back, the email is available for re-use

### EC-8: Cloud Mode Invitation Endpoint

**GIVEN** `DEPLOYMENT_MODE=cloud`
**WHEN** a user accesses `POST /api/instance/invitations`
**THEN** the system returns `403 Forbidden` with `{ error: "Instance-level invitations are only available in self-hosted deployments. Use company-level invitations instead." }`
(Note: company-level invitations in cloud mode are out of scope for this change.)

### EC-9: Invitation Role Validation

**GIVEN** Alice creates an invitation
**WHEN** Alice sends `{ email: "eve@acme.com", role: "instance_admin" }`
**THEN** the system returns `400 Bad Request` with `{ error: "Invalid role. Allowed values: member, admin, viewer." }`
**AND** no invitation is created — `instance_admin` cannot be assigned via invitation; it is only assigned during bootstrap

### EC-10: Token URL Tampering

**GIVEN** an invitation for bob@acme.com with role `member`
**WHEN** an attacker manipulates the signup URL to `/signup?invite=<validToken>&email=attacker@evil.com`
**THEN** the system validates that the email in the URL matches the email stored on the invitation
**AND** on mismatch, returns `400 Bad Request` with `{ error: "Email does not match the invitation." }`

### EC-11: Invitation Token Brute-Force Protection

**GIVEN** an attacker attempts to guess invitation tokens at `GET /api/auth/validate-invite`
**WHEN** the attacker exceeds 30 validation attempts per hour from the same IP
**THEN** the system returns `429 Too Many Requests` and rate-limits further attempts

---

## 5. API Contracts

### 5.1 Modified: `POST /api/auth/register`

**Current behavior:** Accepts `{ email, password, companyName, acceptBetaDisclaimer }`. Creates user + new company + owner membership. Always.

**New behavior (self-hosted):**

**Bootstrap request (no company exists):**
```
POST /api/auth/register
Content-Type: application/json

{
  "email": "admin@acme.com",
  "password": "securePass123",
  "companyName": "Acme Corp",
  "acceptBetaDisclaimer": true
}
---
200 OK
{
  "message": "Instance created. Check your inbox to verify your email before logging in.",
  "instanceCreated": true
}
```

**Invited signup (company exists, invite-only mode):**
```
POST /api/auth/register
Content-Type: application/json

{
  "email": "bob@acme.com",
  "password": "securePass123",
  "inviteToken": "<raw-token>",
  "acceptBetaDisclaimer": true
}
---
200 OK
{
  "message": "Account created. Check your inbox to verify your email before logging in.",
  "companyName": "Acme Corp",
  "role": "member"
}
```

**Open registration signup (company exists, open mode):**
```
POST /api/auth/register
Content-Type: application/json

{
  "email": "bob@acme.com",
  "password": "securePass123",
  "acceptBetaDisclaimer": true
}
---
200 OK
{
  "message": "Account created. Check your inbox to verify your email before logging in.",
  "companyName": "Acme Corp",
  "role": "member"
}
```

**Error: invite-only without token:**
```
POST /api/auth/register
{ "email": "...", "password": "...", "acceptBetaDisclaimer": true }
---
403 Forbidden
{
  "error": "This instance is invite-only. Contact your administrator for an invitation."
}
```

**New behavior (cloud):** Unchanged. Accepts `{ email, password, companyName, acceptBetaDisclaimer }`. Creates user + new company + owner membership.

### 5.2 New: `POST /api/instance/invitations`

**Auth required:** `instance_admin | owner | admin`

```
POST /api/instance/invitations
Content-Type: application/json

{
  "email": "bob@acme.com",
  "role": "member"
}
---
201 Created
{
  "id": "<uuid>",
  "email": "bob@acme.com",
  "role": "member",
  "expiresAt": "2026-07-24T12:00:00.000Z",
  "inviteUrl": "https://instance.example.com/signup?invite=<rawToken>&email=bob%40acme.com"
}
```

**Validation errors:**
- `400` — Invalid email format
- `400` — Invalid role (must be `member`, `admin`, or `viewer`)
- `409` — Active invitation already exists for this email
- `429` — Rate limit exceeded (max 20/hour per admin)

### 5.3 New: `GET /api/auth/validate-invite`

**Auth required:** None

```
GET /api/auth/validate-invite?token=<rawToken>&email=bob@acme.com

---
200 OK
{
  "valid": true,
  "email": "bob@acme.com",
  "role": "member",
  "companyName": "Acme Corp"
}
```

**Invalid/expired:**
```
200 OK
{
  "valid": false,
  "reason": "expired" | "consumed" | "not_found" | "email_mismatch"
}
```

### 5.4 New: `GET /api/instance/settings`

**Auth required:** Any authenticated user

```
GET /api/instance/settings

---
200 OK
{
  "registration_mode": "invite-only",
  "instance_name": "Acme Corp",
  "smtp_host": "smtp.example.com",
  "smtp_port": "587",
  "smtp_user": "noreply@example.com",
  "smtp_from": "Emperor Claw <noreply@example.com>"
}
```

Note: `smtp_password` MUST NOT be returned in the response.

### 5.5 New: `PUT /api/instance/settings`

**Auth required:** `instance_admin`

```
PUT /api/instance/settings
Content-Type: application/json

{
  "registration_mode": "open",
  "instance_name": "Acme Corp (Production)"
}
---
200 OK
{
  "updated": ["registration_mode", "instance_name"]
}
```

**Error:**
```
403 Forbidden
{
  "error": "Only the instance admin can modify instance settings."
}
```

### 5.6 New: `GET /api/instance/members`

**Auth required:** `instance_admin | owner | admin`

```
GET /api/instance/members

---
200 OK
{
  "members": [
    {
      "userId": "<uuid>",
      "email": "alice@acme.com",
      "instanceRole": "instance_admin",
      "companyRole": "owner",
      "joinedAt": "2026-07-01T10:00:00.000Z"
    },
    {
      "userId": "<uuid>",
      "email": "bob@acme.com",
      "instanceRole": "member",
      "companyRole": "member",
      "joinedAt": "2026-07-15T14:30:00.000Z"
    }
  ],
  "pendingInvitations": [
    {
      "id": "<uuid>",
      "email": "carol@acme.com",
      "role": "viewer",
      "createdAt": "2026-07-17T09:00:00.000Z",
      "expiresAt": "2026-07-24T09:00:00.000Z",
      "status": "pending"
    }
  ]
}
```

### 5.7 New: `PATCH /api/instance/members/:userId/role`

**Auth required:** `instance_admin | owner`

```
PATCH /api/instance/members/<userId>/role
Content-Type: application/json

{
  "companyRole": "admin"
}
---
200 OK
{
  "userId": "<uuid>",
  "companyRole": "admin",
  "previousCompanyRole": "member"
}
```

**Error cases:**
- `403` — Caller lacks permission to change roles
- `422` — Attempting to demote the last `instance_admin`
- `404` — User is not a member of this instance's company

### 5.8 New: `DELETE /api/instance/members/:userId`

**Auth required:** `instance_admin | owner | admin`

```
DELETE /api/instance/members/<userId>

---
200 OK
{
  "removed": true
}
```

**Error cases:**
- `422` — Attempting to remove the last `instance_admin`
- `403` — Caller's role does not dominate the target user's role (e.g., `admin` cannot remove an `owner`)

### 5.9 New: `DELETE /api/instance/invitations/:invitationId`

**Auth required:** `instance_admin | owner | admin`

```
DELETE /api/instance/invitations/<invitationId>

---
200 OK
{
  "revoked": true
}
```

Revokes (deletes) a pending invitation so it can no longer be used.

### 5.10 New: `POST /api/instance/invitations/:invitationId/resend`

**Auth required:** `instance_admin | owner | admin`

```
POST /api/instance/invitations/<invitationId>/resend

---
200 OK
{
  "resent": true,
  "expiresAt": "2026-07-24T09:00:00.000Z"
}
```

Re-sends the invitation email. Does NOT extend the expiry. Does NOT generate a new token.

---

## 6. Database Schema Deltas

### 6.1 New Table: `instance_settings`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `key` | `text` | `PRIMARY KEY` | Setting key (e.g., `registration_mode`, `instance_name`) |
| `value` | `jsonb` | `NOT NULL` | Setting value stored as JSONB for type flexibility |
| `updated_at` | `timestamp` | `NOT NULL, DEFAULT now()` | Last update timestamp |

**Drizzle definition:**
```typescript
export const instanceSettings = pgTable("instance_settings", {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### 6.2 New Table: `invitations`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | Unique invitation identifier |
| `company_id` | `uuid` | `NOT NULL, REFERENCES companies(id) ON DELETE CASCADE` | Target company |
| `created_by_user_id` | `uuid` | `NOT NULL, REFERENCES users(id) ON DELETE CASCADE` | Admin who created the invitation |
| `email` | `text` | `NOT NULL` | Invited email address (normalized lowercase) |
| `token_hash` | `text` | `NOT NULL, UNIQUE` | SHA-256 hash of the raw invitation token |
| `role` | `text` | `NOT NULL, DEFAULT 'member'` | Invited role: `'member'`, `'admin'`, or `'viewer'` |
| `max_uses` | `integer` | `NOT NULL, DEFAULT 1` | Maximum times this token can be consumed |
| `use_count` | `integer` | `NOT NULL, DEFAULT 0` | Number of times this token has been consumed |
| `expires_at` | `timestamp` | `NOT NULL` | Token expiry timestamp (created_at + 7 days) |
| `created_at` | `timestamp` | `NOT NULL, DEFAULT now()` | Creation timestamp |

**Drizzle definition:**
```typescript
export const invitations = pgTable("invitations", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role").notNull().default("member"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### 6.3 Modified Table: `users`

**New column:**

| Column | Type | Constraints | Description |
|---|---|---|---|
| `instance_role` | `text` | `NOT NULL, DEFAULT 'member'` | Instance-level role: `'instance_admin'` or `'member'` |

No existing columns are modified or removed.

**Updated Drizzle definition (showing new field only):**
```typescript
export const users = pgTable("users", {
    // ... existing columns unchanged ...
    instanceRole: text("instance_role").notNull().default("member"),
});
```

**Constraint:** `instance_role` MUST be one of `'instance_admin'` or `'member'`. This is enforced at the application layer; a `CHECK` constraint is optional.

### 6.4 Modified Table: `company_members`

**Changed column:**

| Column | Old | New |
|---|---|---|
| `role` | `text NOT NULL DEFAULT 'owner'` (only value was `'owner'`) | `text NOT NULL DEFAULT 'member'` (valid values: `'owner'`, `'admin'`, `'member'`, `'viewer'`) |

The default changes from `'owner'` to `'member'` because new members joining via invitation or open registration default to `'member'`. The bootstrap flow explicitly sets `'owner'`.

No existing rows are modified by the column definition change. The migration only alters the default value.

**Updated Drizzle definition (showing changed field only):**
```typescript
export const companyMembers = pgTable("company_members", {
    // ... existing columns unchanged ...
    role: text("role").notNull().default("member"), // was default "owner"
});
```

**Constraint:** `role` MUST be one of `'owner'`, `'admin'`, `'member'`, or `'viewer'`. This is enforced at the application layer.

---

## 7. Migration Specification

### 7.1 Migration Name

`00XX_team-rbac.sql` (number to be assigned based on the next available migration sequence number; as of the last migration `0023_consolidate-artifact-storage-schema.sql`, this would be `0024`).

### 7.2 Migration SQL

```sql
-- Create instance_settings table
CREATE TABLE IF NOT EXISTS "instance_settings" (
    "key" text PRIMARY KEY,
    "value" jsonb NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Create invitations table
CREATE TABLE IF NOT EXISTS "invitations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
    "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "email" text NOT NULL,
    "token_hash" text NOT NULL UNIQUE,
    "role" text NOT NULL DEFAULT 'member',
    "max_uses" integer NOT NULL DEFAULT 1,
    "use_count" integer NOT NULL DEFAULT 0,
    "expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- Add instance_role column to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "instance_role" text NOT NULL DEFAULT 'member';

-- Change default role on company_members from 'owner' to 'member'
ALTER TABLE "company_members" ALTER COLUMN "role" SET DEFAULT 'member';
```

### 7.3 Data Migration (Post-DDL)

After the DDL changes above, the following data migration MUST run:

```sql
-- Promote the creator of the sole non-deleted company to instance_admin.
-- Only applies when there is exactly one non-deleted company.
DO $$
DECLARE
    v_company_id uuid;
    v_user_id uuid;
BEGIN
    -- Find the only non-deleted company
    SELECT id, created_by_user_id
    INTO v_company_id, v_user_id
    FROM companies
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1;

    -- If exactly one company exists, promote its creator
    IF v_company_id IS NOT NULL AND
       (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) = 1 THEN

        UPDATE users
        SET instance_role = 'instance_admin'
        WHERE id = v_user_id
          AND instance_role = 'member';  -- only if not already set

    END IF;
END $$;
```

### 7.4 Idempotency Guarantees

| Operation | Idempotency Mechanism |
|---|---|
| `CREATE TABLE instance_settings` | `IF NOT EXISTS` |
| `CREATE TABLE invitations` | `IF NOT EXISTS` |
| `ALTER TABLE users ADD COLUMN instance_role` | `ADD COLUMN IF NOT EXISTS` |
| `ALTER TABLE company_members ALTER COLUMN role SET DEFAULT` | Running multiple times is harmless (setting default to the same value) |
| Data migration (promote to instance_admin) | Guarded by `instance_role = 'member'` — only affects users not already promoted |

### 7.5 Migration Rollback

```sql
-- Rollback (only if needed; should not be required for this additive migration)
ALTER TABLE "users" DROP COLUMN IF EXISTS "instance_role";
ALTER TABLE "company_members" ALTER COLUMN "role" SET DEFAULT 'owner';
DROP TABLE IF EXISTS "invitations";
DROP TABLE IF EXISTS "instance_settings";
```

### 7.6 Session Continuity

Existing JWT tokens do NOT contain `instanceRole` or `companyRole` claims. After migration:

1. The NextAuth JWT callback MUST be updated to populate `instanceRole` and `companyRole` on new logins.
2. For existing valid sessions, the JWT callback MUST detect missing claims on token refresh and hydrate them from the database.
3. Middleware MUST treat a missing `instanceRole` claim as equivalent to `'member'` (safe default) until the token is refreshed.

### 7.7 Dry-Run Validation

Before applying the migration to production, the following validations MUST pass:

1. `SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL` returns 0 or 1 (for existing self-hosted instances; multi-company is valid only in cloud mode pre-migration).
2. No `instance_role` column currently exists on `users`.
3. No `instance_settings` or `invitations` tables currently exist.
4. The `company_members.role` default is currently `'owner'`.
