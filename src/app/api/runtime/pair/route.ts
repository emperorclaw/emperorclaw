import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual, deliverWorkerAssignment, heartbeatWorker, pairingEnabled } from "@/lib/worker-pairing";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const MAX_WORKER_ID = 200;

/**
 * POST /api/runtime/pair — the pairing endpoint a Hermes worker polls until it
 * is assigned an agent. Outside /api/mcp auth: authenticated ONLY by constant-
 * time comparison with EMPEROR_WORKER_PAIRING_SECRET, disabled entirely when
 * that env var is unset, and rate-limited per client IP. Secrets are never
 * logged and only the freshly-minted token is returned (exactly once).
 */
export async function POST(req: NextRequest) {
    if (!pairingEnabled()) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const ip = getClientIp(req);
    const limit = consumeRateLimit({ key: `pair:${ip}`, limit: 30, windowMs: 60_000 });
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const provided = req.headers.get("x-worker-pairing-secret") ?? "";
    const expected = process.env.EMPEROR_WORKER_PAIRING_SECRET ?? "";
    if (!provided || !constantTimeEqual(provided, expected)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    if (!workerId || workerId.length > MAX_WORKER_ID) {
        return NextResponse.json({ error: "workerId is required" }, { status: 400 });
    }

    const worker = await heartbeatWorker(workerId);
    const delivery = await deliverWorkerAssignment(worker);
    return NextResponse.json(delivery);
}
