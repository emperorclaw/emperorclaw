import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentRuns, chatResponsePreviews } from "@/db/schema";
import type { ChatPreview, ResponseSnapshot } from "./response-contract";

/** Client polish can be disabled separately from response preview transport. */
export function chatExperienceEnabled(companyId: string): boolean {
    if (process.env.EMPEROR_CHAT_EXPERIENCE === "0") return false;
    const allow = (process.env.EMPEROR_CHAT_EXPERIENCE_COMPANIES ?? "").split(",").map(value => value.trim()).filter(Boolean);
    return allow.length === 0 || allow.includes(companyId);
}

/** Explicit rollout allow-list, or all companies with EMPEROR_CHAT_STREAMING=1. */
export function chatStreamingEnabled(companyId: string): boolean {
    if (process.env.EMPEROR_CHAT_STREAMING !== "1") return false;
    const companies = (process.env.EMPEROR_CHAT_STREAMING_COMPANIES ?? "").split(",").map(value => value.trim()).filter(Boolean);
    return companies.length === 0 || companies.includes(companyId);
}

export async function saveResponseSnapshot(run: { id: string; companyId: string; threadId: string; agentId: string }, input: ResponseSnapshot) {
    const now = new Date();
    // Serialize a run's writers so segment count/aggregate size cannot race.
    return db.transaction(async tx => {
        const locked = await tx.execute(sql`SELECT status, reply_message_id FROM agent_runs WHERE id = ${run.id}::uuid AND company_id = ${run.companyId}::uuid FOR UPDATE`);
        const current = locked.rows[0] as { status: string; reply_message_id: string | null } | undefined;
        if (!current || current.status !== "running" || current.reply_message_id) return null;
        const [bytes] = await tx.select({ size: sql<number>`coalesce(sum(octet_length(${chatResponsePreviews.text})), 0)::int` })
            .from(chatResponsePreviews).where(and(eq(chatResponsePreviews.runId, run.id), sql`${chatResponsePreviews.responseId} <> ${input.responseId}::uuid`));
        if ((bytes?.size ?? 0) + Buffer.byteLength(input.text, "utf8") > 512 * 1024) return null;
        const [stored] = await tx.insert(chatResponsePreviews).values({ ...input, companyId: run.companyId, threadId: run.threadId, agentId: run.agentId, runId: run.id,
            updatedAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000),
        }).onConflictDoUpdate({ target: chatResponsePreviews.responseId, set: {
            revision: input.revision, text: input.text, state: input.state, updatedAt: now,
            expiresAt: new Date(now.getTime() + 15 * 60_000),
        }, setWhere: and(eq(chatResponsePreviews.runId, run.id), eq(chatResponsePreviews.segmentIndex, input.segmentIndex),
            lt(chatResponsePreviews.revision, input.revision),
            sql`(${chatResponsePreviews.state} = 'streaming' OR ${chatResponsePreviews.state} = ${input.state})`),
        }).returning();
        // Bounded indexed maintenance, not a full-table delete on every token.
        await tx.execute(sql`DELETE FROM chat_response_previews WHERE response_id IN (SELECT response_id FROM chat_response_previews WHERE expires_at < now() ORDER BY expires_at LIMIT 32)`);
        return stored ?? null;
    });
}

/** Call only after the ordinary chat GET has authorized this exact thread. */
export async function readResponsePreviews(companyId: string, threadId: string): Promise<ChatPreview[]> {
    if (!chatStreamingEnabled(companyId)) return [];
    const rows = await db.select({ responseId: chatResponsePreviews.responseId, runId: chatResponsePreviews.runId,
        agentId: chatResponsePreviews.agentId, agentName: agents.name, segmentIndex: chatResponsePreviews.segmentIndex,
        revision: chatResponsePreviews.revision, text: chatResponsePreviews.text, state: chatResponsePreviews.state,
        updatedAt: agentRuns.startedAt, runStatus: agentRuns.status, finalMessageId: agentRuns.replyMessageId,
    }).from(chatResponsePreviews).innerJoin(agentRuns, eq(agentRuns.id, chatResponsePreviews.runId))
        .innerJoin(agents, eq(agents.id, chatResponsePreviews.agentId))
        .where(and(eq(chatResponsePreviews.companyId, companyId), eq(chatResponsePreviews.threadId, threadId),
            gt(chatResponsePreviews.expiresAt, new Date())))
        .orderBy(asc(agentRuns.startedAt), asc(chatResponsePreviews.segmentIndex)).limit(64);
    return rows.map(row => ({ ...row, state: row.state as ChatPreview["state"], updatedAt: row.updatedAt.toISOString() }));
}
