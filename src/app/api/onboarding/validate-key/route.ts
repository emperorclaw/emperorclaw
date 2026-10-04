import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { validateLlmKey } from "@/lib/onboarding";
import { consumeRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Check a model API key with its provider before agents start with it. The key is not stored. */
export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("owner", "admin")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }
    if (!consumeRateLimit({ key: `validate-key:${ctx.userId}`, limit: 20, windowMs: 60_000 }).allowed) {
        return NextResponse.json({ error: "Too many checks; wait a minute." }, { status: 429 });
    }
    const body = await req.json().catch(() => ({}));
    const result = await validateLlmKey(typeof body.provider === "string" ? body.provider : "", typeof body.apiKey === "string" ? body.apiKey : "");
    return NextResponse.json(result);
}
