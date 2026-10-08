import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual, deliverWorkerAssignment, heartbeatWorker, pairingEnabled, type PairReport } from "@/lib/worker-pairing";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const MAX_WORKER_ID = 200;
const MAX_TOKEN = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Secrets never reach a response body or log line: no-store, generic errors. */
function json(body: unknown, status = 200) {
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/runtime/pair — the pairing endpoint a Hermes worker polls until it
 * is assigned an agent. Outside /api/mcp auth and exempt from the session
 * middleware (src/proxy.ts, this exact path only): authenticated ONLY by
 * constant-time comparison with EMPEROR_WORKER_PAIRING_SECRET, disabled
 * entirely (404) when that env var is unset, and rate-limited per client IP
 * before the secret is even checked. The freshly-minted token is returned
 * exactly once; secrets are never logged.
 */
export async function POST(req: NextRequest) {
    if (!pairingEnabled()) {
        return json({ error: "Not found" }, 404);
    }

    const ip = getClientIp(req);
    const limit = consumeRateLimit({ key: `pair:${ip}`, limit: 30, windowMs: 60_000 });
    if (!limit.allowed) {
        return json({ error: "Too many requests" }, 429);
    }

    const provided = req.headers.get("x-worker-pairing-secret") ?? "";
    const expected = process.env.EMPEROR_WORKER_PAIRING_SECRET?.trim() ?? "";
    if (!provided || !constantTimeEqual(provided.trim(), expected)) {
        return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const workerId = typeof body?.workerId === "string" ? body.workerId.trim() : "";
    if (!workerId || workerId.length > MAX_WORKER_ID) {
        return json({ error: "workerId is required" }, 400);
    }
    const report: PairReport = {};
    if (typeof body.agentId === "string" && UUID_RE.test(body.agentId)) report.agentId = body.agentId;
    if (body.release && typeof body.release === "object") {
        const token = typeof body.release.token === "string" && body.release.token.length <= MAX_TOKEN ? body.release.token : null;
        report.release = { token };
    }

    try {
        const worker = await heartbeatWorker(workerId);
        const delivery = await deliverWorkerAssignment(worker, report);
        return json(delivery);
    } catch (error) {
        // Log only the error class/message — never the request body or headers.
        console.error("Worker pairing failed:", error instanceof Error ? error.message : "unknown error");
        return json({ error: "Internal Server Error" }, 500);
    }
}
