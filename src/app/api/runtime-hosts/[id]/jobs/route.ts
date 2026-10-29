import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";
import { planHostCommand } from "@/lib/runtime-hosts/commands";
import { getHost, listJobs, queueJob, serializeJob } from "@/lib/runtime-hosts/store";

type Params = { params: Promise<{ id: string }> };

/** GET /api/runtime-hosts/[id]/jobs: the host's latest jobs. */
export async function GET(_req: NextRequest, { params }: Params) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const host = await getHost(access.ctx.companyId, id);
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });
    const jobs = await listJobs(access.ctx.companyId, id, 20);
    return NextResponse.json({ jobs: jobs.map(serializeJob) });
}

const bodySchema = z.object({
    command: z.string().max(40),
    agentId: z.string().uuid().optional(),
    target: z.enum(["bridge", "gateway"]).optional(),
    // Only when the admin explicitly chose "restart now even if busy" (a shared
    // gateway restart otherwise always waits for its agents to be idle).
    force: z.literal(true).optional(),
    idempotencyKey: z.string().min(8).max(100).regex(/^[\w:.-]+$/).optional(),
}).strict(); // unknown fields (a topology, an idle policy) are refused, not ignored


/**
 * POST /api/runtime-hosts/[id]/jobs: queue a command for the host. 0.21 runs
 * restart_agent (an agent on this host; its profile comes from the server,
 * never the caller) and refresh_inventory; anything else is refused. The
 * server never states a topology or idle policy: the host's own record
 * decides whether the agent is on a shared gateway, and a shared gateway
 * restart waits for idle unless `force: true`. A host that is offline gets
 * the job when it reconnects. Owners/admins only; it does not need "who can
 * use this agent" access (an operations action that reads no content; audited).
 */
export async function POST(req: NextRequest, { params }: Params) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const body = parsed.data;
    const host = await getHost(access.ctx.companyId, id);
    if (!host || host.revokedAt) return NextResponse.json({ error: "Host not found" }, { status: 404 });

    let agentId: string | null = null;
    let args: Record<string, unknown> = {};
    if (body.command === "restart_agent") {
        if (!body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 400 });
        const [agent] = await db.select({ id: agents.id, runtimeHostId: agents.runtimeHostId, runtimeProfile: agents.runtimeProfile }).from(agents).where(and(
            eq(agents.id, body.agentId), eq(agents.companyId, access.ctx.companyId), isNull(agents.deletedAt),
        )).limit(1);
        if (!agent || agent.runtimeHostId !== host.id || !agent.runtimeProfile) {
            return NextResponse.json({ error: "That agent does not run on this host" }, { status: 400 });
        }
        agentId = agent.id;
        args = { profile: agent.runtimeProfile, target: body.target ?? "bridge", ...(body.force ? { force: true } : {}) };
    }
    const plan = planHostCommand(body.command, args);
    if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: plan.status });

    const queued = await queueJob({
        companyId: access.ctx.companyId, hostId: host.id, agentId, command: plan.command, args: plan.args,
        idempotencyKey: body.idempotencyKey ?? null, userId: access.ctx.userId,
    });
    if (queued.conflict) return NextResponse.json({ error: "This idempotency key was already used for another command" }, { status: 409 });
    return NextResponse.json({ job: serializeJob(queued.job), created: queued.created }, { status: queued.created ? 201 : 200 });
}
