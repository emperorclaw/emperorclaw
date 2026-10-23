import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { resolveBoundAgentId, verifyMcpToken } from "@/lib/mcp";
import { mcpTokenMayUseMessageId } from "@/lib/thread-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { clampRunTimestamp, computeRunDurationMs, finishRunSchema, finishUsageColumns, payloadTooLarge, truncateRunError } from "@/lib/run-ledger";

const RUNS_PER_MINUTE = 2_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/mcp/agents/runs/[id] — finish a run.
 *
 * Idempotent: a repeat finish of a terminal run is a no-op. A finish for an
 * unknown id creates the row (the start was lost). `lost` is the only terminal
 * state a late finish may overwrite.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;
    // A token bound to an agent may only finish that agent's runs. A company-wide
    // token (agentId null) keeps the previous behaviour. Same resolver POST uses.
    const boundAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, null);

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });

    const raw = await req.text();
    if (payloadTooLarge(raw)) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
    const parsed = finishRunSchema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue && issue.path.length > 0 ? issue.path.join(".") : "body";
        return NextResponse.json({ error: `Invalid request body — ${path}: ${issue?.message ?? "invalid"}` }, { status: 400 });
    }
    const input = parsed.data;
    // The reply a run names must not be a message in a private thread this token may not use.
    if (!(await mcpTokenMayUseMessageId(companyId, auth.companyToken!.agentId ?? null, input.replyMessageId))) {
        return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    const limit = consumeRateLimit({
        key: `mcp:runs:finish:${auth.companyToken!.agentId ?? companyId}`,
        limit: RUNS_PER_MINUTE,
        windowMs: 60_000,
    });
    if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

    // Clamped to [now − 48h, now + 5min]; an out-of-range end falls back to now.
    const endedAt = clampRunTimestamp(input.endedAt);
    const error = truncateRunError(input.error ?? null);

    try {
        // Normal finish: only a running (or lost) run may be moved. Anything
        // already terminal is left untouched, so this is idempotent.
        const [updated] = await db
            .update(agentRuns)
            .set({
                status: input.status,
                endedAt,
                durationMs: input.durationMs != null
                    ? input.durationMs
                    : sql`(extract(epoch from (${endedAt}::timestamptz - ${agentRuns.startedAt}::timestamptz)) * 1000)::int`,
                inputTokens: input.inputTokens ?? undefined,
                outputTokens: input.outputTokens ?? undefined,
                costCents: input.costCents ?? undefined,
                toolCalls: input.toolCalls ?? undefined,
                replyMessageId: input.replyMessageId ?? undefined,
                error: error ?? undefined,
                ...finishUsageColumns(input),
                // Added to the server's own cap drops (events endpoint).
                ...(input.eventsDropped ? { eventsDropped: sql`coalesce(${agentRuns.eventsDropped}, 0) + ${input.eventsDropped}` } : {}),
            })
            .where(and(
                eq(agentRuns.id, id),
                eq(agentRuns.companyId, companyId),
                inArray(agentRuns.status, ["running", "lost"]),
                // A bound token can only move a run it owns.
                ...(boundAgentId ? [eq(agentRuns.agentId, boundAgentId)] : []),
            ))
            .returning();
        if (updated) return NextResponse.json({ run: updated });

        // Unknown id (start lost): create the row from what the finish carries.
        const startedAt = new Date(endedAt.getTime() - (input.durationMs ?? 0));
        const [inserted] = await db
            .insert(agentRuns)
            .values({
                id,
                companyId,
                // A bound token attributes the recovered run to its own agent.
                agentId: boundAgentId,
                status: input.status,
                startedAt,
                endedAt,
                durationMs: computeRunDurationMs(startedAt, endedAt, input.durationMs),
                inputTokens: input.inputTokens ?? null,
                outputTokens: input.outputTokens ?? null,
                costCents: input.costCents ?? null,
                toolCalls: input.toolCalls ?? null,
                replyMessageId: input.replyMessageId ?? null,
                error,
                ...finishUsageColumns(input),
                eventsDropped: input.eventsDropped ?? null,
            })
            .onConflictDoNothing({ target: agentRuns.id })
            .returning();
        if (inserted) return NextResponse.json({ run: inserted });

        // Lost the race with a concurrent start/finish. The row now exists:
        // return it (terminal no-op) or report a cross-company id collision.
        const [existing] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
        if (!existing || existing.companyId !== companyId) {
            return NextResponse.json({ error: "Run id is already in use" }, { status: 409 });
        }
        if (boundAgentId && existing.agentId !== boundAgentId) {
            return NextResponse.json(
                { error: "Access denied: this token is bound to a different agent" },
                { status: 403 },
            );
        }
        return NextResponse.json({ run: existing });
    } catch (err) {
        console.error("runs finish error:", err);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
