import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { companyRouteAccess } from "@/lib/company-access";
import { getHost, listHosts, listJobs, renameHost, revokeHost, serializeJob } from "@/lib/runtime-hosts/store";
import { serializeHost, serializeHostEntry } from "@/lib/runtime-hosts/serialize";

type Params = { params: Promise<{ id: string }> };

/** GET /api/runtime-hosts/[id]: one host with its agents, bridges and recent jobs. */
export async function GET(_req: NextRequest, { params }: Params) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const entry = (await listHosts(access.ctx.companyId)).find((h) => h.host.id === id);
    if (!entry) return NextResponse.json({ error: "Host not found" }, { status: 404 });
    const jobs = await listJobs(access.ctx.companyId, id, 20);
    return NextResponse.json({ host: serializeHostEntry(entry), jobs: jobs.map(serializeJob) });
}

const patchSchema = z.object({ name: z.string().trim().min(1).max(63).regex(/^[\w .()-]+$/, "Use letters, numbers, spaces, dots and dashes") });

/** PATCH /api/runtime-hosts/[id]: rename. */
export async function PATCH(req: NextRequest, { params }: Params) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid name" }, { status: 400 });
    const host = await renameHost(access.ctx.companyId, id, parsed.data.name, access.ctx.userId);
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });
    return NextResponse.json({ host: serializeHost(host) });
}

/**
 * DELETE /api/runtime-hosts/[id]: revoke. The token stops working and the socket closes (4401).
 * Pending removals are canceled; `leftProfiles` lists the profiles they leave on the machine.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const existing = await getHost(access.ctx.companyId, id);
    if (!existing) return NextResponse.json({ error: "Host not found" }, { status: 404 });
    if (existing.revokedAt) return NextResponse.json({ host: serializeHost(existing) });
    const host = await revokeHost(access.ctx.companyId, id, access.ctx.userId);
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });
    // Removals that were still pending will never run: those agents' profiles stay on the machine.
    return NextResponse.json({ host: serializeHost(host), leftProfiles: host.leftProfiles });
}
