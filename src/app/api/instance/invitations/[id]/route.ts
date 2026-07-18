import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { revokeInvitation, resendInvitation } from "@/lib/invitations";
import { isSelfHosted } from "@/lib/instance";

// ── DELETE: Revoke invitation (admin+) ────────────────────────────────────

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const guard = requireRole("admin");
        await guard();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance-level invitations are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const { id } = await params;
        await revokeInvitation(id);
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
        await guard();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance-level invitations are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const { id } = await params;
        const invitation = await resendInvitation(id);

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
