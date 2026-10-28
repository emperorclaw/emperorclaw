import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { attentionAccessFromGuard } from "@/lib/attention";
import { markAllInboxRead } from "@/lib/inbox-state";

export const dynamic = "force-dynamic";

/** Mark everything in your inbox read, as it is right now. A later change makes an item unread again. */
export async function POST() {
    const guard = await companyRouteAccess("viewer");
    if (guard.response) return guard.response;
    const limit = consumeRateLimit({ key: `inbox-read-all:${guard.ctx.companyId}:${guard.ctx.userId}`, limit: 120, windowMs: 60_000 });
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many inbox updates. Try again in a moment." }, { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
    }
    try {
        const result = await markAllInboxRead(guard.ctx.companyId, attentionAccessFromGuard(guard.ctx));
        return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[/api/inbox/read-all] POST error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
