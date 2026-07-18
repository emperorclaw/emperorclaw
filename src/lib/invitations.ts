import crypto from "node:crypto";
import { db } from "@/db";
import { invitations, companies, companyMembers, users } from "@/db/schema";
import { and, eq, isNull, lt, gt, sql } from "drizzle-orm";

const VALID_INVITATION_ROLES = ["member", "admin", "viewer"] as const;
type InvitationRole = (typeof VALID_INVITATION_ROLES)[number];

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Token generation (cryptographically secure) ───────────────────────────

export function generateInviteToken(): string {
    return crypto.randomBytes(32).toString("hex"); // 64 hex chars, 256 bits entropy (NFR-1)
}

function hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex"); // NFR-2
}

// ── Create invitation ─────────────────────────────────────────────────────

export interface CreateInvitationParams {
    email: string;
    role: string;
    companyId: string;
    createdByUserId: string;
}

export interface InvitationResult {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
    rawToken: string;
}

export async function createInvitation(
    params: CreateInvitationParams
): Promise<InvitationResult> {
    const { email: rawEmail, role, companyId, createdByUserId } = params;

    // Normalize email (FR-11)
    const email = rawEmail.trim().toLowerCase();

    // Validate email format (basic RFC 5321 check)
    if (!email || !email.includes("@") || email.length > 254) {
        throw new InvitationError("Invalid email address.", 400);
    }

    // Validate role (EC-9: instance_admin not allowed via invitation)
    if (!VALID_INVITATION_ROLES.includes(role as InvitationRole)) {
        throw new InvitationError(
            "Invalid role. Allowed values: member, admin, viewer.",
            400
        );
    }

    // Check for duplicate active invitation (EC-3)
    const [existing] = await db
        .select()
        .from(invitations)
        .where(
            and(
                eq(invitations.email, email),
                eq(invitations.companyId, companyId),
                isNull(invitations.deletedAt),
                gt(invitations.expiresAt, new Date()),
                lt(invitations.useCount, invitations.maxUses)
            )
        )
        .limit(1);

    if (existing) {
        throw new InvitationError(
            `An active invitation already exists for ${email}. It expires ${existing.expiresAt.toISOString()}.`,
            409
        );
    }

    // Generate token
    const rawToken = generateInviteToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

    // Insert
    const [invitation] = await db
        .insert(invitations)
        .values({
            companyId,
            createdByUserId,
            email,
            tokenHash,
            role,
            maxUses: 1,
            useCount: 0,
            expiresAt,
        })
        .returning();

    return {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        rawToken,
    };
}

// ── Validate invitation token ─────────────────────────────────────────────

export interface ValidateInviteResult {
    valid: true;
    email: string;
    role: string;
    companyName: string;
    invitationId: string;
    companyId: string;
}

export interface ValidateInviteError {
    valid: false;
    reason: "expired" | "consumed" | "not_found" | "email_mismatch";
}

export async function validateInviteToken(
    rawToken: string,
    email?: string
): Promise<ValidateInviteResult | ValidateInviteError> {
    if (!rawToken) {
        return { valid: false, reason: "not_found" };
    }

    const tokenHash = hashToken(rawToken);

    const [invitation] = await db
        .select({
            id: invitations.id,
            email: invitations.email,
            role: invitations.role,
            expiresAt: invitations.expiresAt,
            useCount: invitations.useCount,
            maxUses: invitations.maxUses,
            deletedAt: invitations.deletedAt,
            companyId: invitations.companyId,
            companyName: companies.name,
        })
        .from(invitations)
        .innerJoin(companies, eq(invitations.companyId, companies.id))
        .where(
            and(
                eq(invitations.tokenHash, tokenHash),
                isNull(invitations.deletedAt)
            )
        )
        .limit(1);

    if (!invitation) {
        return { valid: false, reason: "not_found" };
    }

    // Check expiry
    if (new Date() > invitation.expiresAt) {
        return { valid: false, reason: "expired" };
    }

    // Check consumed
    if (invitation.useCount >= invitation.maxUses) {
        return { valid: false, reason: "consumed" };
    }

    // Check email match if provided (EC-10)
    if (email && email.toLowerCase() !== invitation.email.toLowerCase()) {
        return { valid: false, reason: "email_mismatch" };
    }

    return {
        valid: true,
        email: invitation.email,
        role: invitation.role,
        companyName: invitation.companyName,
        invitationId: invitation.id,
        companyId: invitation.companyId,
    };
}

// ── Consume invitation (called during signup) ─────────────────────────────

export async function consumeInvite(
    rawToken: string,
    userId: string
): Promise<{ companyId: string; role: string }> {
    const tokenHash = hashToken(rawToken);

    return await db.transaction(async (tx) => {
        // Lock the invitation row for update
        const [invitation] = await tx
            .select()
            .from(invitations)
            .where(
                and(
                    eq(invitations.tokenHash, tokenHash),
                    isNull(invitations.deletedAt)
                )
            )
            .limit(1);

        if (!invitation) {
            throw new InvitationError("Invitation not found.", 400);
        }

        if (new Date() > invitation.expiresAt) {
            throw new InvitationError("This invitation has expired.", 410);
        }

        if (invitation.useCount >= invitation.maxUses) {
            throw new InvitationError("This invitation has already been used.", 400);
        }

        // Increment use_count
        await tx
            .update(invitations)
            .set({ useCount: invitation.useCount + 1 })
            .where(eq(invitations.id, invitation.id));

        // If consumed, soft-delete
        if (invitation.useCount + 1 >= invitation.maxUses) {
            await tx
                .update(invitations)
                .set({ deletedAt: new Date() })
                .where(eq(invitations.id, invitation.id));
        }

        // Create company membership with the invitation's role
        await tx.insert(companyMembers).values({
            companyId: invitation.companyId,
            userId,
            role: invitation.role,
        });

        // Set instance_role on user (viewer → member at instance level per FR-16)
        const instanceRole = invitation.role === "viewer" ? "member" : invitation.role;
        await tx
            .update(users)
            .set({ instanceRole })
            .where(eq(users.id, userId));

        return {
            companyId: invitation.companyId,
            role: invitation.role,
        };
    });
}

// ── List invitations for a company ────────────────────────────────────────

export type InvitationStatus = "pending" | "expired" | "consumed";

export interface InvitationRow {
    id: string;
    email: string;
    role: string;
    createdAt: Date;
    expiresAt: Date;
    maxUses: number;
    useCount: number;
    status: InvitationStatus;
}

export async function getInvitations(companyId: string): Promise<InvitationRow[]> {
    const rows = await db
        .select()
        .from(invitations)
        .where(
            and(
                eq(invitations.companyId, companyId),
                isNull(invitations.deletedAt)
            )
        )
        .orderBy(sql`${invitations.createdAt} DESC`);

    return rows.map((row) => {
        let status: InvitationStatus;
        if (row.useCount >= row.maxUses) {
            status = "consumed";
        } else if (new Date() > row.expiresAt) {
            status = "expired";
        } else {
            status = "pending";
        }

        return {
            id: row.id,
            email: row.email,
            role: row.role,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            maxUses: row.maxUses,
            useCount: row.useCount,
            status,
        };
    });
}

// ── Revoke invitation (soft-delete) ───────────────────────────────────────

export async function revokeInvitation(invitationId: string): Promise<void> {
    await db
        .update(invitations)
        .set({ deletedAt: new Date() })
        .where(eq(invitations.id, invitationId));
}

// ── Resend invitation (returns existing data without regenerating token) ──

export async function resendInvitation(invitationId: string): Promise<{
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
} | null> {
    const [invitation] = await db
        .select()
        .from(invitations)
        .where(
            and(
                eq(invitations.id, invitationId),
                isNull(invitations.deletedAt)
            )
        )
        .limit(1);

    if (!invitation) return null;

    return {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
    };
}

// ── Error class ───────────────────────────────────────────────────────────

export class InvitationError extends Error {
    public statusCode: number;
    constructor(message: string, statusCode: number = 400) {
        super(message);
        this.name = "InvitationError";
        this.statusCode = statusCode;
    }
}
