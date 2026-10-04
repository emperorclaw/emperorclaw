import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { dicebearUrl, isAvatarStyle, parseDicebearUrl } from "@/lib/avatar";

export const dynamic = "force-dynamic";

/**
 * Give every agent the same avatar style: { style }. Each keeps its seed, so
 * the team gets one look and every agent still looks different. Custom
 * (non-DiceBear) pictures are left alone.
 */
export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }
    const body = await req.json().catch(() => ({}));
    if (!isAvatarStyle(body.style)) return NextResponse.json({ error: "Unknown avatar style" }, { status: 400 });
    const rows = await db.select({ id: agents.id, avatarUrl: agents.avatarUrl }).from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), isNull(agents.deletedAt)));
    let updated = 0;
    for (const row of rows) {
        const parsed = parseDicebearUrl(row.avatarUrl);
        if (row.avatarUrl && !parsed) continue;
        await db.update(agents).set({ avatarUrl: dicebearUrl(body.style, parsed?.seed ?? row.id) }).where(eq(agents.id, row.id));
        updated += 1;
    }
    return NextResponse.json({ updated });
}
