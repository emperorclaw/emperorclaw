import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyTokens } from "@/db/schema";
import { randomBytes, createHash } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireRole, AuthError, roleGte } from "@/lib/roles";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { isCompanyTokenScope, serializeCompanyToken } from "@/lib/mcp";

// Company tokens grant programmatic access to every agent and (at mcp_danger)
// to decrypted integration/resource secrets, so minting and listing them is an
// admin action — never something any member can do.
export async function GET() {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }
    const companyId = ctx.companyId;

    try {
        const tokens = await db.select().from(companyTokens)
            .where(and(
                eq(companyTokens.companyId, companyId),
                isNull(companyTokens.revokedAt),
            ))
            .orderBy(desc(companyTokens.createdAt));

        return NextResponse.json({ tokens: tokens.map(serializeCompanyToken) });
    } catch (err) {
        console.error("Error fetching tokens:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }
    const companyId = ctx.companyId;

    try {
        const body = await req.json();
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const requestedScope = body.scope;

        if (!name) return NextResponse.json({ error: "Token name is required" }, { status: 400 });
        if (requestedScope !== undefined && !isCompanyTokenScope(requestedScope)) {
            return NextResponse.json({ error: "Invalid token scope" }, { status: 400 });
        }

        // mcp_danger can lease decrypted integration/resource secrets, so keep it
        // reserved for owners (and instance admins) rather than any admin.
        if (requestedScope === "mcp_danger" && !roleGte(ctx.role, "owner")) {
            return NextResponse.json({ error: "Only owners can create mcp_danger tokens" }, { status: 403 });
        }

        const scope = requestedScope ?? "mcp_full";

        const rawToken = `ec_${randomBytes(24).toString('hex')}`;
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        const [newToken] = await db.insert(companyTokens).values({
            companyId,
            name,
            scope,
            tokenHash,
        }).returning();

        await broadcastMcpEvent(companyId, {
            type: "company_token_created",
            token: serializeCompanyToken(newToken),
        });

        return NextResponse.json({ token: serializeCompanyToken(newToken), secret: rawToken }, { status: 201 });

    } catch (err) {
        console.error("Error creating token:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
