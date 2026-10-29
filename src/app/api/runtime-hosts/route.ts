import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createPairing, listHosts } from "@/lib/runtime-hosts/store";
import { serializeHostEntry } from "@/lib/runtime-hosts/serialize";

/** GET /api/runtime-hosts: the company's paired hosts with their agents (owners and admins). */
export async function GET() {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const hosts = await listHosts(access.ctx.companyId);
    return NextResponse.json({ hosts: hosts.map(serializeHostEntry) });
}

/** POST /api/runtime-hosts: a new one-time pairing code (10 minutes). */
export async function POST() {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const limit = consumeRateLimit({ key: `runtime-hosts:pairing:${access.ctx.companyId}`, limit: 30, windowMs: 3_600_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Too many pairing codes; try again later" }, { status: 429 });
    const pairing = await createPairing(access.ctx.companyId, access.ctx.userId);
    return NextResponse.json({ code: pairing.code, expiresAt: pairing.expiresAt.toISOString() }, { status: 201 });
}
