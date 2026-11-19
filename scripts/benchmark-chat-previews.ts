/** Disposable-database load probe. Never run against a production database. */
import { db } from "../src/db";
import { users, companies, agents, agentRuns, messageThreads } from "../src/db/schema";
import { saveResponseSnapshot } from "../src/lib/chat/responses";
import { broadcastMcpEvent } from "../src/lib/pubsub";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

async function main() {
    const url = new URL(process.env.POSTGRES_CONNECTION_STRING ?? "postgres://invalid/invalid");
    if (!/(_test|_bench)$/.test(url.pathname)) throw new Error("Use a disposable database ending in _test or _bench");
    const [user] = await db.insert(users).values({ email: `chat-bench-${randomUUID()}@example.invalid`, passwordHash: "disabled" }).returning();
    const [company] = await db.insert(companies).values({ name: "Disposable chat load probe", createdByUserId: user.id }).returning();
    try {
        const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Preview load probe", llmModel: "test", monthlyBudgetCents: 0 }).returning();
        const [thread] = await db.insert(messageThreads).values({ companyId: company.id, type: "team", createdByType: "system" }).returning();
        for (const count of [1, 10, 50, 100]) {
            const runs = Array.from({ length: count }, () => ({ id: randomUUID(), companyId: company.id, threadId: thread.id, agentId: agent.id }));
            await db.insert(agentRuns).values(runs);
            const ids = runs.map(() => randomUUID());
            const latencies: number[] = [];
            const walStart = await db.execute(sql`SELECT pg_current_wal_lsn()::text AS lsn`);
            const started = performance.now();
            for (let revision = 1; revision <= 8; revision++) {
                const round = performance.now();
                await Promise.all(runs.map(async (run, i) => {
                    const at = performance.now();
                    await saveResponseSnapshot(run, { responseId: ids[i], segmentIndex: 0, revision, text: "A cumulative paragraph. ".repeat(10 * revision), state: "streaming" });
                    await broadcastMcpEvent(company.id, { type: "chat_response_updated", threadId: thread.id, agentId: agent.id });
                    latencies.push(performance.now() - at);
                }));
                await new Promise(resolve => setTimeout(resolve, Math.max(0, 250 - (performance.now() - round))));
            }
            const elapsed = performance.now() - started;
            const wal = await db.execute(sql`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), ${String(walStart.rows[0].lsn)}::pg_lsn)::bigint AS bytes`);
            latencies.sort((a, b) => a - b);
            console.log(JSON.stringify({ activeReplies: count, snapshots: latencies.length, snapshotsPerSecond: Math.round(latencies.length * 1000 / elapsed),
                storageAndFanoutP95Ms: Math.round(latencies[Math.floor(latencies.length * .95)]), maxMs: Math.round(latencies.at(-1)!), walBytes: String(wal.rows[0].bytes) }));
            await db.delete(agentRuns).where(eq(agentRuns.companyId, company.id));
        }
    } finally {
        await db.delete(companies).where(eq(companies.id, company.id));
        await db.delete(users).where(eq(users.id, user.id));
    }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
