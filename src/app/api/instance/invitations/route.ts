import { NextRequest, NextResponse } from "next/server";
import { withRoleApi } from "@/lib/route-guards";
import {
    createInvitation,
    getInvitations,
    InvitationError,
} from "@/lib/invitations";
import { isSelfHosted } from "@/lib/instance";
import { getAppUrl } from "@/lib/env";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { eq } from "drizzle-orm";

// ── POST: Create invitation (admin+) ──────────────────────────────────────

export const POST = withRoleApi("admin")(async (req, ctx) => {
    try {
        // Cloud guard (FR-30, EC-8)
        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance-level invitations are only available in self-hosted deployments. Use company-level invitations instead." },
                { status: 403 }
            );
        }

        const body = await req.json();
        const { email, role } = body;

        if (!email || !role) {
            return NextResponse.json(
                { error: "Missing required fields: email, role" },
                { status: 400 }
            );
        }

        // Rate limit: 20/hr per admin user (NFR-5)
        const rateLimit = consumeRateLimit({
            key: `invitations:create:${ctx.userId}`,
            limit: 20,
            windowMs: 60 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many invitations. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                }
            );
        }

        const result = await createInvitation({
            email,
            role,
            companyId: ctx.companyId,
            createdByUserId: ctx.userId,
        });

        const appUrl = getAppUrl(req);
        const inviteUrl = `${appUrl}/signup?invite=${result.rawToken}&email=${encodeURIComponent(result.email)}`;

        // Send invitation email (FR-17)
        const [company] = await db.select({ name: companies.name })
            .from(companies)
            .where(eq(companies.id, ctx.companyId))
            .limit(1);
        const companyName = company?.name ?? "the workspace";

        await sendEmail({
            to: result.email,
            subject: `You're invited to join ${companyName} on Emperor Claw`,
            html: `<p>You've been invited to join <strong>${companyName}</strong> as a <strong>${result.role}</strong>.</p><p><a href="${inviteUrl}">Click here to accept the invitation</a></p><p>This invitation expires on ${result.expiresAt.toLocaleDateString()}.</p>`,
        });

        return NextResponse.json(
            {
                id: result.id,
                email: result.email,
                role: result.role,
                expiresAt: result.expiresAt.toISOString(),
                inviteUrl,
            },
            { status: 201 }
        );
    } catch (err) {
        if (err instanceof InvitationError) {
            return NextResponse.json(
                { error: err.message },
                { status: err.statusCode }
            );
        }
        console.error("Create invitation error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
});

// ── GET: List invitations (admin+) ────────────────────────────────────────

export const GET = withRoleApi("admin")(async (_req, ctx) => {
    try {
        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance-level invitations are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const invitationsList = await getInvitations(ctx.companyId);
        return NextResponse.json({ invitations: invitationsList }, { status: 200 });
    } catch (err) {
        console.error("List invitations error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
});
