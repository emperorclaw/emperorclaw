import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { companyTokens } from "@/db/schema";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { normalizeCompanyTokenScope, serializeCompanyToken } from "@/lib/mcp";
import { prepareCallbackUrl } from "@/lib/agent-requests";

/** Set or clear a requests token's callback URL: { callbackUrl: string | null }. */
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const [token] = await db.select().from(companyTokens).where(and(
        eq(companyTokens.companyId, ctx.companyId), eq(companyTokens.id, id), isNull(companyTokens.revokedAt),
    )).limit(1).catch(() => []);
    if (!token) return NextResponse.json({ error: "Token not found" }, { status: 404 });
    if (normalizeCompanyTokenScope(token.scope) !== "requests") {
        return NextResponse.json({ error: "Only requests tokens have a callback URL" }, { status: 400 });
    }
    let values: { callbackUrlEncrypted: string | null; callbackUrlHint: string | null } = { callbackUrlEncrypted: null, callbackUrlHint: null };
    if (body.callbackUrl !== null && body.callbackUrl !== "") {
        const prepared = prepareCallbackUrl(body.callbackUrl);
        if ("error" in prepared) return NextResponse.json({ error: prepared.error }, { status: 400 });
        values = { callbackUrlEncrypted: prepared.encrypted, callbackUrlHint: prepared.hint };
    }
    const [updated] = await db.update(companyTokens).set(values).where(eq(companyTokens.id, token.id)).returning();
    return NextResponse.json({ token: serializeCompanyToken(updated) });
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }
    const companyId = ctx.companyId;

    const { id } = await params;

    try {
        const [existingToken] = await db.select().from(companyTokens).where(and(
            eq(companyTokens.companyId, companyId),
            eq(companyTokens.id, id),
            isNull(companyTokens.revokedAt),
        )).limit(1);

        if (!existingToken) {
            return NextResponse.json({ error: "Token not found" }, { status: 404 });
        }

        const [revokedToken] = await db.update(companyTokens).set({
            revokedAt: new Date(),
        }).where(eq(companyTokens.id, existingToken.id)).returning();

        await broadcastMcpEvent(companyId, {
            type: "company_token_revoked",
            token: serializeCompanyToken(revokedToken),
        });

        return NextResponse.json({ token: serializeCompanyToken(revokedToken) });
    } catch (err) {
        console.error("Error revoking token:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
