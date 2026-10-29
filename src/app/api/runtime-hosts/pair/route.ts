import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { consumePairing } from "@/lib/runtime-hosts/store";
import { HOST_PROTOCOL } from "@/lib/runtime-hosts/protocol";

const pairSchema = z.object({
    code: z.string().min(8).max(20),
    hostFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    hostname: z.string().min(1).max(255),
    os: z.string().max(80).nullish(),
    arch: z.string().max(40).nullish(),
});

/**
 * POST /api/runtime-hosts/pair: `emperor-hermes host connect` trades a
 * one-time pairing code for its host token. No session: the code is the
 * credential, so the route is rate limited per IP before anything else and
 * every failure looks the same (expired, used and unknown codes alike).
 */
export async function POST(req: NextRequest) {
    const ip = getClientIp(req);
    const limit = consumeRateLimit({ key: `runtime-hosts:pair:${ip}`, limit: 10, windowMs: 10 * 60_000 });
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many attempts; try again later" }, { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
    }
    const body = await req.json().catch(() => null);
    const parsed = pairSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const result = await consumePairing(parsed.data);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({
        hostId: result.host.id,
        hostToken: result.token,
        name: result.host.name,
        protocol: HOST_PROTOCOL,
        socketPath: "/api/hosts/ws",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
