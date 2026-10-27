import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { revokeInvitation, resendInvitation } from "@/lib/invitations";
import { isSelfHosted } from "@/lib/instance";
import { humanActor, recordAudit } from "@/lib/audit";

// ── DELETE: Revoke invitation (admin+) ────────────────────────────────────

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const guard = requireRole("admin");
        const ctx = await guard();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance-level invitations are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const { id } = await params;
        const revoked = await revokeInvitation(ctx.companyId, id);
        if (!revoked) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
        await recordAudit({ companyId: ctx.companyId, actor: humanActor(ctx.userId), action: "invitation.revoked", target: { type: "invitation", id: revoked.id }, before: { email: revoked.email, role: revoked.role }, meta: { label: revoked.email } });
        return NextResponse.json({ success: true }, { status: 200 });
    } catch (err: any) {
        if (err?.statusCode) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Revoke invitation error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// ── POST: Resend invitation (admin+) ─────────────────────────────────────

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const guard = requireRole("admin");
        const ctx = await guard();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance-level invitations are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const { id } = await params;
        const invitation = await resendInvitation(ctx.companyId, id);

        if (!invitation) {
            return NextResponse.json(
                { error: "Invitation not found." },
                { status: 404 }
            );
        }

        return NextResponse.json({ invitation }, { status: 200 });
    } catch (err: any) {
        if (err?.statusCode) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Resend invitation error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
