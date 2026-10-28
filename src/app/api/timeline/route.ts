import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { taskViewerFromGuard } from "@/lib/task-story-reads";
import { MAX_WINDOW_DAYS } from "@/lib/work-timeline";
import { loadWorkTimeline } from "@/lib/work-timeline-reads";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sane bounds for a window edge: not before 2000, not more than a year ahead. */
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_AHEAD_MS = 366 * DAY_MS;

function parseMs(value: string | null): number | null {
    // Whole epoch milliseconds; a fractional part (from a zoomed range) is dropped.
    if (!value || !/^\d{1,16}(\.\d{1,6})?$/.test(value)) return null;
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : null;
}

/** An optional id filter: absent → null, a UUID → itself, anything else → "invalid". */
function parseId(value: string | null): string | null | "invalid" {
    if (value == null || value === "") return null;
    return UUID_RE.test(value) ? value : "invalid";
}

/** GET /api/timeline?from&to&agentId&projectId&customerId — the company Gantt, member-scoped and privacy-filtered. */
export async function GET(req: NextRequest) {
    const guard = await companyRouteAccess("viewer", { module: "timeline" });
    if (guard.response) return guard.response;
    const companyId = guard.ctx.companyId;
    try {
        const params = req.nextUrl.searchParams;
        const fromMs = parseMs(params.get("from"));
        const toMs = parseMs(params.get("to"));
        if (fromMs == null || toMs == null) {
            return NextResponse.json({ error: "from and to are required (epoch milliseconds)" }, { status: 400 });
        }
        if (fromMs < MIN_MS || toMs > Date.now() + MAX_AHEAD_MS) {
            return NextResponse.json({ error: "from and to must be within a sane range" }, { status: 400 });
        }
        if (toMs <= fromMs) {
            return NextResponse.json({ error: "to must be after from" }, { status: 400 });
        }
        if (toMs - fromMs > MAX_WINDOW_DAYS * DAY_MS) {
            return NextResponse.json({ error: `window must be at most ${MAX_WINDOW_DAYS} days` }, { status: 400 });
        }
        const agentId = parseId(params.get("agentId"));
        const projectId = parseId(params.get("projectId"));
        const customerId = parseId(params.get("customerId"));
        if (agentId === "invalid" || projectId === "invalid" || customerId === "invalid") {
            return NextResponse.json({ error: "agentId, projectId and customerId must be UUIDs" }, { status: 400 });
        }
        const viewer = await taskViewerFromGuard(guard.ctx);
        const timeline = await loadWorkTimeline(companyId, viewer, { fromMs, toMs, agentId, projectId, customerId });
        return NextResponse.json(timeline, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[/api/timeline] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
