import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, companies, companyMembers, instanceSettings, invitations } from "@/db/schema";
import { hash } from "argon2";
import { eq, isNull, sql, and } from "drizzle-orm";
import { sendEmail, getEmailVerificationEmailHtml } from "@/lib/email";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { issueEmailVerificationToken } from "@/lib/email-verification";
import { getAppUrl } from "@/lib/env";
import { createHash } from "node:crypto";
import { recordOpsError } from "@/lib/ops-events";
import {
    isSelfHosted,
    getRegistrationMode,
    clearInstanceCompanyCache,
} from "@/lib/instance";
import { validateInviteToken, InvitationError } from "@/lib/invitations";

interface RegisterRequestBody {
    email: string;
    password: string;
    companyName?: string;
    inviteToken?: string;
    acceptBetaDisclaimer?: boolean;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeCompanyName(value: unknown): string {
    return String(value ?? "").trim().replace(/\s+/g, " ");
}

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json()) as RegisterRequestBody;
        const email = normalizeEmail(body.email);
        const password = String(body.password ?? "");
        const companyName = normalizeCompanyName(body.companyName || "");
        const inviteToken = String(body.inviteToken ?? "").trim();
        const acceptBetaDisclaimer = body.acceptBetaDisclaimer === true;

        // ── Rate limiting ────────────────────────────────────────────────
        const rateLimit = consumeRateLimit({
            key: `auth:register:${getClientIp(req)}:${email || "unknown"}`,
            limit: 5,
            windowMs: 15 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many signup attempts. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                },
            );
        }

        // ── Basic field validation ───────────────────────────────────────
        if (!email || !password) {
            return NextResponse.json({ error: "Missing required fields: email, password" }, { status: 400 });
        }

        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
        }

        if (password.length < 8 || password.length > 128) {
            return NextResponse.json({ error: "Password must be between 8 and 128 characters." }, { status: 400 });
        }

        // Check if user already exists
        const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existingUser) {
            return NextResponse.json({ error: "Email already in use" }, { status: 400 });
        }

        const passwordHash = await hash(password);

        // ═══════════════════════════════════════════════════════════════════
        // SELF-HOSTED PATH
        // ═══════════════════════════════════════════════════════════════════

        if (isSelfHosted()) {
            // Count existing non-deleted companies
            const [countResult] = await db
                .select({ count: sql<number>`COUNT(*)::int` })
                .from(companies)
                .where(isNull(companies.deletedAt));

            const companyCount = countResult?.count ?? 0;

            // ── Bootstrap: first user creates the instance (FR-4, FR-5, FR-6) ──
            if (companyCount === 0) {
                if (!companyName) {
                    return NextResponse.json(
                        { error: "Company name is required to set up your instance." },
                        { status: 400 }
                    );
                }
                if (!acceptBetaDisclaimer) {
                    return NextResponse.json({
                        error: "You must acknowledge the beta data disclaimer before creating a workspace."
                    }, { status: 400 });
                }
                if (companyName.length < 2 || companyName.length > 120) {
                    return NextResponse.json({
                        error: "Company name must be between 2 and 120 characters."
                    }, { status: 400 });
                }

                const result = await db.transaction(async (tx) => {
                    const [newUser] = await tx
                        .insert(users)
                        .values({
                            email,
                            passwordHash,
                            instanceRole: "instance_admin",
                            // Auto-verify the first user: they own the instance and SMTP
                            // likely isn't configured yet. Requiring email verification
                            // at bootstrap creates a chicken-and-egg lockout.
                            emailVerifiedAt: new Date(),
                        })
                        .returning();

                    const [newCompany] = await tx
                        .insert(companies)
                        .values({ name: companyName, createdByUserId: newUser.id })
                        .returning();

                    await tx.insert(companyMembers).values({
                        companyId: newCompany.id,
                        userId: newUser.id,
                        role: "owner",
                    });

                    // Initialize instance settings with invite-only default (FR-6)
                    await tx.insert(instanceSettings).values({
                        key: "registration_mode",
                        value: "invite-only",
                        updatedAt: new Date(),
                    });

                    return { user: { id: newUser.id, email: newUser.email }, company: newCompany };
                });

                clearInstanceCompanyCache();

                return NextResponse.json({
                    message: "Instance created! You can now log in.",
                    instanceCreated: true,
                    data: {
                        email,
                        companyId: result.company.id,
                        companyName: result.company.name,
                    },
                }, { status: 201 });
            }

            // ── Post-bootstrap: check registration mode ─────────────────
            const registrationMode = await getRegistrationMode();

            // Invite-only without token → reject (FR-7)
            if (registrationMode === "invite-only" && !inviteToken) {
                return NextResponse.json(
                    { error: "This instance is invite-only. Contact your administrator for an invitation." },
                    { status: 403 }
                );
            }

            // ── Invited signup path (FR-16) ──────────────────────────────
            if (inviteToken) {
                const validation = await validateInviteToken(inviteToken, email);
                if (!validation.valid) {
                    const reasonMessages: Record<string, string> = {
                        expired: "This invitation has expired. Please contact your administrator for a new one.",
                        consumed: "This invitation has already been used.",
                        not_found: "Invalid or expired invitation token.",
                        email_mismatch: "This invitation is for a different email address.",
                    };
                    return NextResponse.json(
                        { error: reasonMessages[validation.reason] || "Invalid invitation." },
                        { status: validation.reason === "expired" ? 410 : 400 }
                    );
                }

                const newUserResult = await db.transaction(async (tx) => {
                    const [newUser] = await tx
                        .insert(users)
                        .values({
                            email,
                            passwordHash,
                            instanceRole: validation.role === "viewer" ? "member" : validation.role,
                        })
                        .returning();

                    // consumeInvite uses its own transaction — pass the tx to avoid nested tx issues
                    const tokenHash = createHash("sha256").update(inviteToken).digest("hex");
                    const [invitation] = await tx
                        .select()
                        .from(invitations)
                        .where(
                            and(eq(invitations.tokenHash, tokenHash), isNull(invitations.deletedAt))
                        )
                        .limit(1);

                    if (!invitation) throw new Error("Invitation not found");
                    if (new Date() > invitation.expiresAt) throw new Error("Invitation expired");
                    if (invitation.useCount >= invitation.maxUses) throw new Error("Invitation already used");

                    await tx.insert(companyMembers).values({
                        companyId: invitation.companyId,
                        userId: newUser.id,
                        role: invitation.role,
                    });

                    await tx
                        .update(invitations)
                        .set({ useCount: invitation.useCount + 1 })
                        .where(eq(invitations.id, invitation.id));

                    if (invitation.useCount + 1 >= invitation.maxUses) {
                        await tx
                            .update(invitations)
                            .set({ deletedAt: new Date() })
                            .where(eq(invitations.id, invitation.id));
                    }

                    return {
                        user: { id: newUser.id, email: newUser.email },
                        companyId: invitation.companyId,
                        role: invitation.role,
                    };
                });

                const [company] = await db
                    .select({ name: companies.name })
                    .from(companies)
                    .where(eq(companies.id, newUserResult.companyId))
                    .limit(1);

                const invitedCompanyName = company?.name ?? "the workspace";

                const { rawToken: verifyToken } = await issueEmailVerificationToken(newUserResult.user.id);
                const verificationUrl = `${getAppUrl(req)}/signup/verify?token=${verifyToken}&email=${encodeURIComponent(email)}`;

                await sendEmail({
                    to: email,
                    subject: "Verify your Emperor Claw email",
                    html: getEmailVerificationEmailHtml(email, verificationUrl, invitedCompanyName),
                });

                return NextResponse.json({
                    message: "Account created. Check your inbox to verify your email before logging in.",
                    data: {
                        email,
                        companyId: newUserResult.companyId,
                        companyName: invitedCompanyName,
                        role: newUserResult.role,
                    },
                }, { status: 201 });
            }

            // ── Open registration path (FR-8) ────────────────────────────
            const [existingCompany] = await db
                .select()
                .from(companies)
                .where(isNull(companies.deletedAt))
                .limit(1);

            if (!existingCompany) {
                return NextResponse.json(
                    { error: "No company found. Please contact your administrator." },
                    { status: 500 }
                );
            }

            const openResult = await db.transaction(async (tx) => {
                const [newUser] = await tx
                    .insert(users)
                    .values({ email, passwordHash, instanceRole: "member" })
                    .returning();

                await tx.insert(companyMembers).values({
                    companyId: existingCompany.id,
                    userId: newUser.id,
                    role: "member",
                });

                return { user: { id: newUser.id, email: newUser.email }, company: existingCompany };
            });

            const { rawToken: openVerifyToken } = await issueEmailVerificationToken(openResult.user.id);
            const openVerifyUrl = `${getAppUrl(req)}/signup/verify?token=${openVerifyToken}&email=${encodeURIComponent(email)}`;

            await sendEmail({
                to: email,
                subject: "Verify your Emperor Claw email",
                html: getEmailVerificationEmailHtml(email, openVerifyUrl, openResult.company.name),
            });

            return NextResponse.json({
                message: "Account created. Check your inbox to verify your email before logging in.",
                data: {
                    email,
                    companyId: openResult.company.id,
                    companyName: openResult.company.name,
                    role: "member",
                },
            }, { status: 201 });
        }

        // ═══════════════════════════════════════════════════════════════════
        // CLOUD PATH (unchanged — existing behavior preserved, FR-3, NFR-13)
        // ═══════════════════════════════════════════════════════════════════

        if (!companyName) {
            return NextResponse.json({ error: "Company name is required" }, { status: 400 });
        }

        if (!acceptBetaDisclaimer) {
            return NextResponse.json({
                error: "You must acknowledge the beta data disclaimer before creating a workspace."
            }, { status: 400 });
        }

        if (companyName.length < 2 || companyName.length > 120) {
            return NextResponse.json({
                error: "Company name must be between 2 and 120 characters."
            }, { status: 400 });
        }

        const result = await db.transaction(async (tx) => {
            const [newUser] = await tx.insert(users).values({
                email,
                passwordHash,
            }).returning();

            const [newCompany] = await tx.insert(companies).values({
                name: companyName,
                createdByUserId: newUser.id,
            }).returning();

            await tx.insert(companyMembers).values({
                companyId: newCompany.id,
                userId: newUser.id,
                role: "owner",
            });

            return { user: { id: newUser.id, email: newUser.email }, company: newCompany };
        });

        const { rawToken } = await issueEmailVerificationToken(result.user.id);
        const verificationUrl = `${getAppUrl(req)}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;

        await sendEmail({
            to: email,
            subject: "Verify your Emperor Claw email",
            html: getEmailVerificationEmailHtml(email, verificationUrl, result.company.name),
        });

        return NextResponse.json({
            message: "Account created. Check your inbox to verify your email before logging in.",
            data: {
                email,
                companyId: result.company.id,
                companyName: result.company.name,
            },
        }, { status: 201 });

    } catch (err: unknown) {
        if (err instanceof InvitationError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Registration error:", err);
        void recordOpsError({
            category: "auth",
            source: "auth.register",
            fallbackMessage: "Registration failed",
            error: err,
            route: "/api/auth/register",
            method: "POST",
        });
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
