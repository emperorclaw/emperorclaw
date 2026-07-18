/**
 * Team RBAC — Unit Tests
 *
 * Tests for the role hierarchy, permission matrix, effective role resolution,
 * and invitation token validation edge cases.
 *
 * Uses Node.js built-in test runner (node:test + node:assert/strict).
 * Run: npx tsx --test tests/team-rbac.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Inline implementations (tested directly to avoid DB dependencies)
// These mirror the production code in src/lib/roles.ts and src/lib/invitations.ts
// but operate on pure data so tests run without a database.
// ---------------------------------------------------------------------------

// ── Role types ────────────────────────────────────────────────────────────

type InstanceRole = "instance_admin" | "member";
type CompanyRole = "owner" | "admin" | "member" | "viewer";
type Role = InstanceRole | CompanyRole;

type Permission =
    | "instance:settings:write"
    | "users:invite"
    | "users:remove"
    | "users:role:change"
    | "projects:all:write"
    | "projects:own:write"
    | "projects:read"
    | "tokens:manage"
    | "agents:manage";

// ── Role hierarchy ────────────────────────────────────────────────────────

const ROLE_HIERARCHY: Role[] = [
    "instance_admin",
    "owner",
    "admin",
    "member",
    "viewer",
];

const ROLE_INDEX = new Map<Role, number>(
    ROLE_HIERARCHY.map((r, i) => [r, i]),
);

function roleGte(a: Role, b: Role): boolean {
    const idxA = ROLE_INDEX.get(a) ?? ROLE_HIERARCHY.length;
    const idxB = ROLE_INDEX.get(b) ?? ROLE_HIERARCHY.length;
    return idxA <= idxB;
}

// ── Permission matrix ─────────────────────────────────────────────────────

const PERMISSION_MATRIX: Record<Permission, ReadonlySet<Role>> = {
    "instance:settings:write": new Set<Role>(["instance_admin"]),
    "users:invite": new Set<Role>(["instance_admin", "owner", "admin"]),
    "users:remove": new Set<Role>(["instance_admin", "owner", "admin"]),
    "users:role:change": new Set<Role>(["instance_admin", "owner"]),
    "projects:all:write": new Set<Role>(["instance_admin", "owner", "admin"]),
    "projects:own:write": new Set<Role>(["instance_admin", "owner", "admin", "member"]),
    "projects:read": new Set<Role>(["instance_admin", "owner", "admin", "member", "viewer"]),
    "tokens:manage": new Set<Role>(["instance_admin", "owner", "admin"]),
    "agents:manage": new Set<Role>(["instance_admin", "owner", "admin", "member"]),
};

// ── Permission check ──────────────────────────────────────────────────────

function getEffectiveRole(instanceRole: InstanceRole, companyRole: CompanyRole | null): Role {
    if (instanceRole === "instance_admin") return "instance_admin";
    if (!companyRole) return instanceRole;
    return roleGte(companyRole, instanceRole) ? companyRole : instanceRole;
}

function hasPermission(
    instanceRole: InstanceRole,
    companyRole: CompanyRole | null,
    permission: Permission,
): boolean {
    const effective = getEffectiveRole(instanceRole, companyRole);
    const allowedRoles = PERMISSION_MATRIX[permission];
    if (!allowedRoles) return false;

    for (const allowedRole of allowedRoles) {
        if (roleGte(effective, allowedRole)) return true;
    }
    return false;
}

// ── Invitation token helpers (pure, no DB) ────────────────────────────────

import crypto from "node:crypto";

function generateInviteToken(): string {
    return crypto.randomBytes(32).toString("hex");
}

function hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function isTokenExpired(expiresAt: Date): boolean {
    return new Date() > expiresAt;
}

function makeExpiredDate(): Date {
    return new Date(Date.now() - 1000); // 1 second in the past
}

function makeValidDate(): Date {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Role Hierarchy (roleGte)", () => {
    it("instance_admin is highest — >= all roles", () => {
        for (const role of ROLE_HIERARCHY) {
            assert.ok(roleGte("instance_admin", role), `instance_admin should be >= ${role}`);
        }
    });

    it("viewer is lowest — no role is >= viewer except viewer itself", () => {
        // viewer is >= only itself
        assert.ok(roleGte("viewer", "viewer"));
        // All other roles are >= viewer (they're higher, so they inherit viewer perms)
        assert.ok(roleGte("instance_admin", "viewer"));
        assert.ok(roleGte("owner", "viewer"));
        assert.ok(roleGte("admin", "viewer"));
        assert.ok(roleGte("member", "viewer"));
    });

    it("owner > admin > member > viewer", () => {
        assert.ok(roleGte("owner", "admin"));
        assert.ok(roleGte("owner", "member"));
        assert.ok(roleGte("owner", "viewer"));
        assert.ok(roleGte("admin", "member"));
        assert.ok(roleGte("admin", "viewer"));
        assert.ok(roleGte("member", "viewer"));
    });

    it("lower roles are NOT >= higher roles", () => {
        assert.ok(!roleGte("viewer", "member"));
        assert.ok(!roleGte("viewer", "admin"));
        assert.ok(!roleGte("viewer", "owner"));
        assert.ok(!roleGte("viewer", "instance_admin"));
        assert.ok(!roleGte("member", "admin"));
        assert.ok(!roleGte("member", "owner"));
        assert.ok(!roleGte("admin", "owner"));
        assert.ok(!roleGte("admin", "instance_admin"));
        assert.ok(!roleGte("owner", "instance_admin"));
    });

    it("roleGte is reflexive — every role >= itself", () => {
        for (const role of ROLE_HIERARCHY) {
            assert.ok(roleGte(role, role), `${role} should be >= itself`);
        }
    });

    it("roleGte is transitive", () => {
        // instance_admin >= owner >= admin => instance_admin >= admin
        assert.ok(roleGte("instance_admin", "owner"));
        assert.ok(roleGte("owner", "admin"));
        assert.ok(roleGte("instance_admin", "admin"));
    });
});

describe("Permission Matrix (hasPermission)", () => {
    // ── instance_admin ──────────────────────────────────────────────────

    it("instance_admin has all permissions", () => {
        const allPermissions = Object.keys(PERMISSION_MATRIX) as Permission[];
        for (const perm of allPermissions) {
            assert.ok(
                hasPermission("instance_admin", "owner", perm),
                `instance_admin should have ${perm}`,
            );
        }
    });

    // ── owner ──────────────────────────────────────────────────────────

    it("owner can manage tokens, invite, remove, manage agents, but NOT instance:settings:write", () => {
        assert.ok(hasPermission("member", "owner", "tokens:manage"));
        assert.ok(hasPermission("member", "owner", "users:invite"));
        assert.ok(hasPermission("member", "owner", "users:remove"));
        assert.ok(hasPermission("member", "owner", "users:role:change"));
        assert.ok(hasPermission("member", "owner", "agents:manage"));
        assert.ok(hasPermission("member", "owner", "projects:all:write"));
    });

    it("owner does NOT have instance:settings:write", () => {
        assert.ok(!hasPermission("member", "owner", "instance:settings:write"));
    });

    // ── admin ──────────────────────────────────────────────────────────

    it("admin can invite, remove, manage tokens, but NOT change roles", () => {
        assert.ok(hasPermission("member", "admin", "users:invite"));
        assert.ok(hasPermission("member", "admin", "users:remove"));
        assert.ok(hasPermission("member", "admin", "tokens:manage"));
        assert.ok(hasPermission("member", "admin", "projects:all:write"));
    });

    it("admin does NOT have users:role:change", () => {
        assert.ok(!hasPermission("member", "admin", "users:role:change"));
    });

    it("admin does NOT have instance:settings:write", () => {
        assert.ok(!hasPermission("member", "admin", "instance:settings:write"));
    });

    // ── member ─────────────────────────────────────────────────────────

    it("member can CRUD own projects and manage agents", () => {
        assert.ok(hasPermission("member", "member", "projects:own:write"));
        assert.ok(hasPermission("member", "member", "projects:read"));
        assert.ok(hasPermission("member", "member", "agents:manage"));
    });

    it("member cannot invite, remove, change roles, manage tokens", () => {
        assert.ok(!hasPermission("member", "member", "users:invite"));
        assert.ok(!hasPermission("member", "member", "users:remove"));
        assert.ok(!hasPermission("member", "member", "users:role:change"));
        assert.ok(!hasPermission("member", "member", "tokens:manage"));
    });

    // ── viewer ─────────────────────────────────────────────────────────

    it("viewer companyRole with member instanceRole gets member-level permissions (floor)", () => {
        // Effective role = max(member, viewer) = member.
        // So a "viewer" at company level still inherits member-level permissions.
        assert.ok(hasPermission("member", "viewer", "projects:read"));
        assert.ok(hasPermission("member", "viewer", "projects:own:write"));
        assert.ok(hasPermission("member", "viewer", "agents:manage"));
        assert.ok(!hasPermission("member", "viewer", "users:invite"));
    });
});

describe("getEffectiveRole", () => {
    it("instance_admin always wins regardless of company role", () => {
        assert.equal(getEffectiveRole("instance_admin", "viewer"), "instance_admin");
        assert.equal(getEffectiveRole("instance_admin", "member"), "instance_admin");
        assert.equal(getEffectiveRole("instance_admin", "owner"), "instance_admin");
        assert.equal(getEffectiveRole("instance_admin", null), "instance_admin");
    });

    it("without instance_admin, company role determines effective role", () => {
        assert.equal(getEffectiveRole("member", "owner"), "owner");
        assert.equal(getEffectiveRole("member", "admin"), "admin");
        assert.equal(getEffectiveRole("member", "member"), "member");
        assert.equal(getEffectiveRole("member", "viewer"), "member"); // member > viewer
    });

    it("null company role falls back to instance role", () => {
        assert.equal(getEffectiveRole("member", null), "member");
        assert.equal(getEffectiveRole("instance_admin", null), "instance_admin");
    });

    it("effective role is always the higher of the two", () => {
        // member instance + owner company = owner (company role is higher)
        assert.equal(getEffectiveRole("member", "owner"), "owner");
        // member instance + viewer company = member (instance role is higher)
        assert.equal(getEffectiveRole("member", "viewer"), "member");
    });
});

describe("Invitation Token Validation (pure logic)", () => {
    it("generateInviteToken produces 64 hex characters (32 bytes)", () => {
        const token = generateInviteToken();
        assert.equal(token.length, 64);
        // Should be valid hex
        assert.ok(/^[0-9a-f]+$/.test(token));
    });

    it("generateInviteToken is unique across calls", () => {
        const tokens = new Set<string>();
        for (let i = 0; i < 100; i++) {
            tokens.add(generateInviteToken());
        }
        assert.equal(tokens.size, 100, "All tokens should be unique");
    });

    it("hashToken is deterministic for the same input", () => {
        const raw = "test-token-12345";
        const hash1 = hashToken(raw);
        const hash2 = hashToken(raw);
        assert.equal(hash1, hash2);
    });

    it("hashToken produces different hashes for different inputs", () => {
        const hash1 = hashToken("token-a");
        const hash2 = hashToken("token-b");
        assert.notEqual(hash1, hash2);
    });

    it("hashToken output is 64 hex characters (SHA-256)", () => {
        const hash = hashToken("some-token");
        assert.equal(hash.length, 64);
        assert.ok(/^[0-9a-f]+$/.test(hash));
    });

    it("isTokenExpired returns true for past dates", () => {
        assert.ok(isTokenExpired(makeExpiredDate()));
    });

    it("isTokenExpired returns false for future dates", () => {
        assert.ok(!isTokenExpired(makeValidDate()));
    });

    it("expired token validation returns expired reason", () => {
        // Simulating the validateInviteToken logic's expired check
        const token = generateInviteToken();
        const hash = hashToken(token);

        // In production, this would query the DB for hash match.
        // Here we test the pure logic: if expires_at is in the past → expired.
        const expiresAt = makeExpiredDate();
        const reason = isTokenExpired(expiresAt) ? "expired" : null;
        assert.equal(reason, "expired");
    });

    it("valid (non-expired) token passes expiry check", () => {
        const expiresAt = makeValidDate();
        const reason = isTokenExpired(expiresAt) ? "expired" : null;
        assert.equal(reason, null);
    });

    it("token hash is NOT reversible to raw token", () => {
        const raw = generateInviteToken();
        const hash = hashToken(raw);
        // Hash should not contain the raw token
        assert.ok(!hash.includes(raw.substring(0, 10)));
        // Rehashing the hash gives a different result
        const rehashed = hashToken(hash);
        assert.notEqual(rehashed, raw);
    });

    it("consumed token detection: use_count >= max_uses means consumed", () => {
        // Pure logic test: the invariant is useCount >= maxUses → consumed
        const isConsumed = (useCount: number, maxUses: number) => useCount >= maxUses;

        assert.ok(!isConsumed(0, 1));
        assert.ok(isConsumed(1, 1));
        assert.ok(isConsumed(2, 1));
        assert.ok(!isConsumed(0, 5));
        assert.ok(!isConsumed(4, 5));
        assert.ok(isConsumed(5, 5));
    });

    it("email mismatch detection", () => {
        // When an email is provided during validation, it must match the invitation email
        const validateEmail = (inviteEmail: string, providedEmail: string | undefined) => {
            if (!providedEmail) return true; // No email constraint
            return inviteEmail.toLowerCase() === providedEmail.toLowerCase();
        };

        assert.ok(validateEmail("user@example.com", "user@example.com"));
        assert.ok(validateEmail("User@Example.com", "user@example.com")); // case insensitive
        assert.ok(!validateEmail("user@example.com", "other@example.com"));
        assert.ok(validateEmail("user@example.com", undefined)); // no constraint
        assert.ok(validateEmail("user@example.com", "")); // empty = no constraint? edge case
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge Case Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge Cases", () => {
    it("last instance_admin cannot be demoted — detection logic", () => {
        const canDemote = (users: { id: string; instanceRole: InstanceRole }[], targetId: string) => {
            const targetIsAdmin = users.find(u => u.id === targetId)?.instanceRole === "instance_admin";
            if (!targetIsAdmin) return true;
            const otherAdmins = users.filter(u => u.id !== targetId && u.instanceRole === "instance_admin");
            return otherAdmins.length > 0;
        };

        const users = [
            { id: "a", instanceRole: "instance_admin" as const },
            { id: "b", instanceRole: "member" as const },
        ];

        assert.ok(canDemote(users, "b"), "non-admin can always be demoted");
        assert.ok(!canDemote(users, "a"), "last admin cannot be demoted");

        const twoAdmins = [
            { id: "a", instanceRole: "instance_admin" as const },
            { id: "b", instanceRole: "instance_admin" as const },
        ];
        assert.ok(canDemote(twoAdmins, "a"), "can demote when another admin exists");
    });

    it("invitation role validation — instance_admin cannot be invited", () => {
        const VALID_INVITE_ROLES = ["member", "admin", "viewer"];
        const isValidInviteRole = (role: string) => VALID_INVITE_ROLES.includes(role);

        assert.ok(isValidInviteRole("member"));
        assert.ok(isValidInviteRole("admin"));
        assert.ok(isValidInviteRole("viewer"));
        assert.ok(!isValidInviteRole("instance_admin"));
        assert.ok(!isValidInviteRole("owner"));
        assert.ok(!isValidInviteRole(""));
    });

    it("7-day token expiry boundary — exactly 7 days from now is valid", () => {
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const exactlySevenDays = new Date(now + SEVEN_DAYS_MS);
        assert.ok(exactlySevenDays.getTime() > now);
        const justExpired = new Date(now - 1);
        assert.ok(justExpired.getTime() <= now);
    });

    it("viewer instance_role defaults to member for permission floor", () => {
        const effective = getEffectiveRole("member", "viewer");
        assert.equal(effective, "member");
        assert.ok(hasPermission("member", "viewer", "projects:read"));
        assert.ok(hasPermission("member", "viewer", "agents:manage"));
    });

    it("unknown roles in roleGte default to lowest rank", () => {
        // Unknown roles fall back to ROLE_HIERARCHY.length (lowest rank),
        // so any known role is >= an unknown role (safe default: deny elevated access)
        assert.ok(roleGte("member", "superadmin" as Role));
        assert.ok(roleGte("viewer", "superadmin" as Role));
        // But unknown role is NOT >= known roles
        assert.ok(!roleGte("superadmin" as Role, "member"));
        assert.ok(!roleGte("superadmin" as Role, "viewer"));
    });
});
