import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { companyRouteAccess } from "@/lib/company-access";
import { JobActionError, cancelRemoval, dismissRemoval, getJob, retryRemoval, serializeJob } from "@/lib/runtime-hosts/store";

/** GET /api/runtime-host-jobs/[id]?afterSeq=N: a job and its progress lines after seq N (the UI polls this while it runs). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const afterRaw = Number(req.nextUrl.searchParams.get("afterSeq") ?? 0);
    const afterSeq = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
    const found = await getJob(access.ctx.companyId, id, afterSeq);
    if (!found) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({
        job: serializeJob(found.job),
        events: found.events.map((e) => ({ seq: e.seq, at: e.at, step: e.step, line: e.line })),
    });
}

const actionSchema = z.object({ action: z.enum(["retry", "dismiss", "cancel"]) }).strict();

/**
 * POST /api/runtime-host-jobs/[id] {action}: follow up a removal (0.22).
 * retry: run a removal that did not succeed again. dismiss: take it off the
 * host card. cancel: drop a removal still waiting for its host (the agent's
 * profile then stays on the machine). Owners/admins only; audited.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    const parsed = actionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    try {
        const { companyId, userId } = access.ctx;
        const job = parsed.data.action === "retry" ? await retryRemoval(companyId, id, userId)
            : parsed.data.action === "dismiss" ? await dismissRemoval(companyId, id, userId)
            : await cancelRemoval(companyId, id, userId);
        return NextResponse.json({ job: serializeJob(job) }, { status: parsed.data.action === "retry" ? 201 : 200 });
    } catch (error) {
        if (error instanceof JobActionError) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
}
