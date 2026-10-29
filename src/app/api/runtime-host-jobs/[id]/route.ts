import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { getJob, serializeJob } from "@/lib/runtime-hosts/store";

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
