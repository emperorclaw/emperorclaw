/**
 * Pause / resume every agent at once (Home's "Pause all agents").
 *
 * It is the single-agent pause, repeated: the same column PATCH
 * /api/agents/[id] writes (`budgetStatus`: "paused" stops the runtime's
 * preflight via readAgentBudget().executionAllowed, "active" lets it run
 * again) and the same activity entry (recordAgentChange -> agent.paused /
 * agent.resumed), one per agent. Agents outside the caller's company or
 * member scope are never touched.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { humanActor, recordAgentChange } from "@/lib/audit";
import { memberAgentCondition, type MemberScope } from "@/lib/member-scope";

export type PauseAllCaller = { companyId: string; userId: string | null; scope: MemberScope | null };

export type PauseAllResult = {
    /** Agents whose state changed. */
    changed: string[];
    /** Agents already in the requested state (left alone, nothing recorded). */
    unchanged: string[];
};

/** Home's banner state, from each visible agent's budget status. */
export function pauseSummary(rows: readonly { budgetStatus: string | null | undefined }[]): { total: number; paused: number; allPaused: boolean } {
    const total = rows.length;
    const paused = rows.filter((row) => row.budgetStatus === "paused").length;
    return { total, paused, allPaused: total > 0 && paused === total };
}

/** The request body: `{ paused: boolean }`, nothing else accepted. */
export function parsePauseAllBody(body: unknown): { paused: boolean } | { error: string } {
    if (!body || typeof body !== "object" || typeof (body as { paused?: unknown }).paused !== "boolean") {
        return { error: "Send { paused: true } to pause every agent, or { paused: false } to resume them." };
    }
    return { paused: (body as { paused: boolean }).paused };
}

export async function setAllAgentsPaused(caller: PauseAllCaller, paused: boolean): Promise<PauseAllResult> {
    const visible = await db.select().from(agents).where(and(
        eq(agents.companyId, caller.companyId),
        isNull(agents.deletedAt),
        memberAgentCondition(caller.scope, agents.id),
    ));
    const target = paused ? "paused" : "active";
    const changed: string[] = [];
    const unchanged: string[] = [];
    const actor = humanActor(caller.userId);
    for (const before of visible) {
        // Resume only lifts a pause; a "warning" agent stays as it is when pausing is undone.
        const needsChange = paused ? before.budgetStatus !== "paused" : before.budgetStatus === "paused";
        if (!needsChange) {
            unchanged.push(before.id);
            continue;
        }
        const [after] = await db.update(agents)
            .set({ budgetStatus: target })
            .where(and(eq(agents.id, before.id), eq(agents.companyId, caller.companyId), isNull(agents.deletedAt)))
            .returning();
        if (!after) continue;
        changed.push(after.id);
        await recordAgentChange(caller.companyId, actor, before, after);
    }
    return { changed, unchanged };
}
