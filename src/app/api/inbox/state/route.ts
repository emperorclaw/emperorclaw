import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { attentionAccessFromGuard } from "@/lib/attention";
import { parseInboxStateRequest, setInboxItemState } from "@/lib/inbox-state";

export const dynamic = "force-dynamic";

/**
 * Your own inbox state: { items: [{ key, fingerprint }], action: read | unread | archive | unarchive }.
 * Only items you can see right now are changed (recomputed for you, server
 * side); other keys come back in `skipped`. At most 200 items.
 */
export async function POST(req: NextRequest) {
    const guard = await companyRouteAccess("viewer");
    if (guard.response) return guard.response;
    const limit = consumeRateLimit({ key: `inbox-state:${guard.ctx.companyId}:${guard.ctx.userId}`, limit: 120, windowMs: 60_000 });
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many inbox updates. Try again in a moment." }, { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
    }
    const parsed = parseInboxStateRequest(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
        const result = await setInboxItemState(guard.ctx.companyId, attentionAccessFromGuard(guard.ctx), parsed.value);
        return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[/api/inbox/state] POST error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
