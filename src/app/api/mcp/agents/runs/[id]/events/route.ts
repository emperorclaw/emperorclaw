import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { resolveBoundAgentId, verifyMcpToken } from "@/lib/mcp";
import { consumeRateLimit } from "@/lib/rate-limit";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { updateAgentThreadParticipant } from "@/lib/control-plane";
import { insertRunStart, payloadTooLarge } from "@/lib/run-ledger";
import { mcpTokenMayStartRun, mcpTokenMayUseThreadId } from "@/lib/thread-access";
import {
    RUN_EVENTS_BATCH_MAX,
    RUN_EVENTS_BODY_MAX_BYTES,
    RUN_EVENTS_PER_MINUTE,
    RUN_EVENT_TYPING_TTL_MS,
    insertRunEvents,
    runEventBatchSchema,
    runEventsAcceptance,
    gateTypingEffect,
    runTypingTarget,
    typingEffectFor,
} from "@/lib/run-events";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/mcp/agents/runs/[id]/events — append a batch of live run events
 * (capability `run-events: 1`, docs/design/hermes-persistent-runtime.md §4.2).
 *
 * Idempotent: events conflicting on id or (run_id, seq) are counted as
 * duplicates. The optional `run` header is the start payload, inserted first
 * (ON CONFLICT DO NOTHING), so a batch never depends on the start POST having
 * landed. Without it an unknown run is 409 `run_not_found` and the bridge
 * retries with the header. A finished run takes late flushes for 10 minutes,
 * then 410. Side effect: the newest event drives the agent's typing row.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });

    const raw = await req.text();
    if (payloadTooLarge(raw, RUN_EVENTS_BODY_MAX_BYTES)) {
        return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
    const events = (body as { events?: unknown } | null)?.events;
    if (Array.isArray(events) && events.length > RUN_EVENTS_BATCH_MAX) {
        return NextResponse.json({ error: `At most ${RUN_EVENTS_BATCH_MAX} events per batch` }, { status: 413 });
    }
    const parsed = runEventBatchSchema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue && issue.path.length > 0 ? issue.path.join(".") : "body";
        return NextResponse.json({ error: `Invalid request body — ${path}: ${issue?.message ?? "invalid"}` }, { status: 400 });
    }
    const input = parsed.data;
    if (input.run && input.run.id.toLowerCase() !== id.toLowerCase()) {
        return NextResponse.json({ error: "run.id must match the run id in the path" }, { status: 400 });
    }

    // A token bound to an agent may only write that agent's runs. Same resolver
    // as POST /agents/runs; a company-wide token keeps the previous behaviour.
    let boundAgentId: string | null;
    try {
        boundAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, input.run?.agentId ?? null);
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Access denied";
        return NextResponse.json({ error: msg }, { status: msg.startsWith("Access denied") ? 403 : 404 });
    }

    const limit = consumeRateLimit({
        key: `mcp:runs:events:${boundAgentId ?? auth.companyToken!.agentId ?? companyId}`,
        limit: RUN_EVENTS_PER_MINUTE,
        windowMs: 60_000,
    });
    if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

    try {
        let [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, id), eq(agentRuns.companyId, companyId)));
        if (!run) {
            if (!input.run) return NextResponse.json({ error: "run_not_found" }, { status: 409 });
            if (!boundAgentId) return NextResponse.json({ error: "agentId is required" }, { status: 400 });
            // Same thread checks as POST /agents/runs.
            if (!(await mcpTokenMayStartRun(companyId, auth.companyToken!.agentId ?? null, input.run))) {
                return NextResponse.json({ error: "Thread not found" }, { status: 404 });
            }
            const started = await insertRunStart(companyId, boundAgentId, input.run);
            if (!started) return NextResponse.json({ error: "Run id is already in use" }, { status: 409 });
            run = started;
        }
        if (boundAgentId && run.agentId !== boundAgentId) {
            return NextResponse.json({ error: "Access denied: this token is bound to a different agent" }, { status: 403 });
        }
        // A run in a private thread only takes events from its own agent's token.
        if (!(await mcpTokenMayUseThreadId(companyId, auth.companyToken!.agentId ?? null, run.threadId))) {
            return NextResponse.json({ error: "Run not found" }, { status: 404 });
        }

        const now = new Date();
        if (runEventsAcceptance(run, now) === "gone") {
            return NextResponse.json({ error: "run_finished" }, { status: 410 });
        }

        const result = await insertRunEvents(run, input.events, now);
        const { stored, ...response } = result;

        // Realtime: a stored run event invalidates the run's thread and task
        // (browser sockets refetch their live rows) — best-effort, never fails
        // the batch. Runs in a private thread resolve their audience here, so
        // the invalidation reaches only the owner and the agent.
        if (stored.length > 0) {
            await broadcastMcpEvent(companyId, {
                type: "run_updated",
                runId: run.id,
                threadId: run.threadId ?? null,
                taskId: run.taskId ?? null,
                agentId: run.agentId ?? null,
            });
        }

        // Live status: the newest stored event sets (or clears) the agent's
        // typing row in the run's thread. Best-effort: never fail the batch.
        if (run.threadId && run.agentId && stored.length > 0) {
            const effect = gateTypingEffect(typingEffectFor(stored, run.status), run.status);
            const target = effect
                ? await runTypingTarget({
                    companyId, threadId: run.threadId, agentId: run.agentId, runId: run.id,
                    runStartedAt: run.startedAt, action: effect.action,
                }).catch(() => null)
                : null;
            if (effect && target) {
                const updates = effect.action === "clear"
                    ? { typingUntil: null, currentActivity: null }
                    : { typingUntil: new Date(now.getTime() + RUN_EVENT_TYPING_TTL_MS), currentActivity: effect.activity };
                try {
                    await updateAgentThreadParticipant(companyId, run.threadId, run.agentId, updates);
                    await broadcastMcpEvent(companyId, {
                        type: "participant_status",
                        threadId: run.threadId,
                        participantId: run.agentId,
                        typing: effect.action === "set",
                        currentActivity: updates.currentActivity,
                    });
                } catch (error) {
                    console.error("run events typing update failed:", error);
                }
            }
        }

        return NextResponse.json(response);
    } catch (error) {
        console.error("run events ingest error:", error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
