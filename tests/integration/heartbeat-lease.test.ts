/**
 * Heartbeat vs. lease: one agent, several sessions.
 *
 * The heartbeat used to refresh `lease_until` on *every* in_progress task of the
 * agent, so a session that died holding a lease kept the hold alive for as long
 * as any other session of the same agent kept beating. The lease never expired,
 * the watchdog never reclaimed the task and the live session got 409 forever
 * (task 9252039B). The same write also stamped `updated_at`, which is the
 * signal the stall sweep reads, so a genuinely stuck task was never nudged.
 *
 * This pins the replacement contract: a heartbeat renews only the hold it
 * represents (an unclaimed task, or the session it names), never `updated_at`,
 * and every terminal transition drops the whole lease.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, seedHuman, seedMcpToken } from "./_access-helper";
import { finalizeTaskForAgent } from "@/lib/openclaw/tasks";
import { DEFAULT_STALL_SWEEP_HOURS, stallStage } from "@/lib/stall-sweep";
import { runWatchdog } from "@/lib/watchdog";

const maybe = dbAvailable ? test : test.skip;

const auth = (bearerHeaders: Record<string, string>) => ({ ...bearerHeaders, "idempotency-key": randomUUID() });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function world() {
    await resetDb();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Solo" });

    const [project] = await db.insert(projects).values({
        companyId,
        goal: "Lease liveness",
        status: "active",
    }).returning();

    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state: "in_progress",
        assignedAgentId: agent.id,
        inputJson: { title: "Work under a lease" },
    }).returning();

    return { db, tasks, companyId, project, task, agent, token: bearer(await seedMcpToken(companyId, agent.id)) };
}

type World = Awaited<ReturnType<typeof world>>;
type Beat = { session?: string | null };

const heartbeatRoute = () => import("@/app/api/mcp/agents/heartbeat/route");
const leaseRoute = () => import("@/app/api/mcp/tasks/[id]/lease/route");

const beat = async (w: World, extra: Beat = {}) =>
    call((await heartbeatRoute()).POST, "/api/mcp/agents/heartbeat", {
        method: "POST",
        headers: auth(w.token),
        body: { agentId: w.agent.id, currentLoad: 0, ...extra },
    });

const claim = async (w: World, body: Record<string, unknown>) =>
    call((await leaseRoute()).POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST",
        headers: auth(w.token),
        params: { id: w.task.id },
        body,
    });

const rowOf = async (w: World) => (await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id)))[0];
const leaseOf = (row: { leaseOwner: string | null; leaseSession: string | null; leaseUntil: Date | null }) =>
    [row.leaseOwner, row.leaseSession, row.leaseUntil];
const emptyLease = [null, null, null];

maybe("a heartbeat cannot keep a dead session's lease alive", async () => {
    const w = await world();
    const granted = await claim(w, { owner: "session-a", ttlSeconds: 2 });
    assert.equal(granted.status, 200, granted.text);

    const claimed = await rowOf(w);
    assert.equal(claimed.leaseSession, "session-a");
    assert.ok(claimed.leaseUntil);

    // A beat from the same agent that names no session has nothing to renew.
    assert.equal((await beat(w)).status, 200);
    const afterBeat = await rowOf(w);
    assert.equal(
        afterBeat.leaseUntil!.getTime(),
        claimed.leaseUntil.getTime(),
        "the heartbeat extended a lease it does not hold",
    );
    assert.deepEqual(leaseOf(afterBeat), [w.agent.id, "session-a", claimed.leaseUntil], "the holder must survive untouched");

    // Once the TTL passes, a later beat must not resurrect it either.
    await sleep(2_200);
    assert.equal((await beat(w)).status, 200);
    const afterLateBeat = await rowOf(w);
    assert.equal(afterLateBeat.leaseUntil!.getTime(), claimed.leaseUntil.getTime(), "a late beat revived a lapsed lease");

    const lapsed = await w.db.execute(sql`select lease_until <= now() as lapsed from tasks where id = ${w.task.id}`);
    assert.equal((lapsed.rows[0] as { lapsed: boolean }).lapsed, true, "the dead session's hold must actually expire");

    // Which is the point: a live session can take the task over.
    const second = await claim(w, { owner: "session-b" });
    assert.equal(second.status, 200, second.text);
    assert.equal((await rowOf(w)).leaseSession, "session-b");
});

maybe("a heartbeat renews the lease of the session it names", async () => {
    const w = await world();
    assert.equal((await claim(w, { owner: "session-a", ttlSeconds: 120 })).status, 200);
    const granted = await rowOf(w);

    const res = await beat(w, { session: "session-a" });
    assert.equal(res.status, 200, res.text);

    const renewed = await rowOf(w);
    assert.ok(
        renewed.leaseUntil!.getTime() > granted.leaseUntil!.getTime() + 60_000,
        "the holder's own heartbeat must extend its lease",
    );
    assert.deepEqual(leaseOf(renewed), [w.agent.id, "session-a", renewed.leaseUntil], "and keep the same holder");
});

maybe("another session of the same agent cannot renew a lease it does not hold", async () => {
    const w = await world();
    assert.equal((await claim(w, { owner: "session-a", ttlSeconds: 120 })).status, 200);
    const granted = await rowOf(w);

    assert.equal((await beat(w, { session: "session-b" })).status, 200);

    const after = await rowOf(w);
    assert.equal(
        after.leaseUntil!.getTime(),
        granted.leaseUntil.getTime(),
        "a second session's heartbeat must not renew the holder's lease",
    );
    assert.equal(after.leaseSession, "session-a");
});

maybe("a heartbeat does not stamp updated_at, so the stall sweep still sees the task", async () => {
    const w = await world();
    assert.equal((await claim(w, { owner: "session-a", ttlSeconds: 900 })).status, 200);

    const silentSince = new Date(Date.now() - 6 * 3_600_000);
    await w.db.update(w.tasks).set({ updatedAt: silentSince }).where(eq(w.tasks.id, w.task.id));

    assert.equal((await beat(w, { session: "session-a" })).status, 200);

    const after = await rowOf(w);
    assert.equal(after.updatedAt.getTime(), silentSince.getTime(), "liveness must not look like progress");
    assert.equal(
        stallStage(Date.now(), after.updatedAt.getTime(), DEFAULT_STALL_SWEEP_HOURS, null, null),
        "nudge",
        "a six-hour silent task must still be nudged after a heartbeat",
    );
});

maybe("a heartbeat renews the platform marker on an unclaimed task without taking it", async () => {
    const w = await world();
    const res = await beat(w);
    assert.equal(res.status, 200, res.text);

    const after = await rowOf(w);
    assert.ok(after.leaseUntil, "the watchdog marker must be renewed for a live agent");
    assert.ok(after.leaseUntil.getTime() > Date.now() + 300_000, "and be a real expiry, not a token one");
    assert.equal(after.leaseOwner, null, "a heartbeat must not claim the task");
    assert.equal(after.leaseSession, null);
});

maybe("finishing a task drops owner, session and expiry", async () => {
    for (const finalState of ["done", "failed"] as const) {
        const w = await world();
        assert.equal((await claim(w, { owner: "session-a", ttlSeconds: 600 })).status, 200);
        const claimed = await rowOf(w);
        assert.ok(claimed.leaseUntil && claimed.leaseSession);

        await finalizeTaskForAgent({
            companyId: w.companyId,
            taskId: w.task.id,
            agentId: w.agent.id,
            state: finalState,
            comment: "handled",
        });

        const after = await rowOf(w);
        assert.equal(after.state, finalState);
        assert.deepEqual(leaseOf(after), emptyLease, `a ${finalState} task must not keep any part of the hold`);
    }
});

maybe("archiving a task drops the lease too", async () => {
    const w = await world();
    assert.equal((await claim(w, { owner: "session-a", ttlSeconds: 600 })).status, 200);
    assert.ok((await rowOf(w)).leaseUntil);

    actAs(await seedHuman(w.companyId, "owner"));
    const archived = await call(
        (await import("@/app/api/tasks/archive/route")).POST as never,
        "/api/tasks/archive",
        { method: "POST", body: { taskIds: [w.task.id] } },
    );
    assert.equal(archived.status, 200, archived.text);

    const after = await rowOf(w);
    assert.ok(after.deletedAt, "the task must be archived");
    assert.deepEqual(leaseOf(after), emptyLease, "an archived task must not keep any part of the hold");
});

maybe("the watchdog drops the lease when it retries or dead-letters a task", async () => {
    const w = await world();
    const expired = new Date(Date.now() - 60_000);
    await w.db.update(w.tasks).set({
        leaseOwner: w.agent.id,
        leaseSession: "session-a",
        leaseUntil: expired,
        retries: 0,
        maxRetries: 3,
    }).where(eq(w.tasks.id, w.task.id));

    const [exhausted] = await w.db.insert(w.tasks).values({
        companyId: w.companyId,
        projectId: w.project.id,
        taskType: "work",
        state: "in_progress",
        assignedAgentId: w.agent.id,
        leaseOwner: w.agent.id,
        leaseSession: "session-b",
        leaseUntil: expired,
        retries: 3,
        maxRetries: 3,
        inputJson: { title: "Exhausted" },
    }).returning();

    await runWatchdog();

    const retried = await rowOf(w);
    assert.equal(retried.state, "inbox", "an expired lease with retries left goes back to the inbox");
    assert.deepEqual(leaseOf(retried), emptyLease, "the retry must not carry the dead session's hold");

    const [dead] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, exhausted.id));
    assert.equal(dead.state, "dead_letter");
    assert.deepEqual(leaseOf(dead), emptyLease, "a dead-lettered task must not keep any part of the hold");
});
