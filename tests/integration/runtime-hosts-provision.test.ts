import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, seedHuman, seedMcpToken } from "./_access-helper";
import { connect, harness, inventoryFrame, jobRow, pairHost, waitForHostStatus, waitForJob, type FakeHost, type Frame } from "./_host-harness";

/**
 * Runtime hosts 0.22: hiring an agent onto a host (provision_agent, its token
 * minted at dispatch), retrying a failed setup, deleting an agent that runs on
 * a host (remove_agent, which waits for the host), gating 0.21 daemons, and an
 * agent-bound token doing everything a bridge does.
 */
const maybe = dbAvailable ? test : test.skip;
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const auth = (raw: string) => ({ authorization: `Bearer ${raw}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function world() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const viktor = await seedAgent(companyId, { name: "Viktor", provider: "hermes" });
    return { companyId, admin, member, viktor };
}

const viktorProfile = (agentId: string): Frame => ({
    profile: "viktor", agentId, sameEmperor: true, topology: "standalone", status: "active", gateway: "active", bridge: "active", health: { registered: true },
});

/** A host with the 0.22 daemon (or 0.21 with `commands: null`), its inventory sent and adopted. */
async function onlineHost(s: Awaited<ReturnType<typeof world>>, h: Awaited<ReturnType<typeof harness>>, opts: { commands?: string[] | null; paired?: { hostId: string; token: string } } = {}) {
    actAs(s.admin);
    const paired = opts.paired ?? await pairHost();
    const host = await connect(h, paired.token);
    host.hello({ commands: opts.commands });
    await host.waitFor(() => host.frames.find((f) => f.type === "welcome"));
    host.send(inventoryFrame([viktorProfile(s.viktor.id)]));
    await waitForAgentOnHost(s.viktor.id, paired.hostId);
    return { ...paired, host };
}

async function waitForAgentOnHost(agentId: string, hostId: string | null, ms = 5000) {
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const end = Date.now() + ms;
    for (;;) {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        if (row?.runtimeHostId === hostId) return row;
        if (Date.now() > end) throw new Error(`agent ${agentId} is on ${row?.runtimeHostId}, expected ${hostId}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

async function hire(body: Record<string, unknown>) {
    const route = await import("@/app/api/agents/route");
    const res = await route.POST(makeRequest("http://localhost/api/agents", { method: "POST", body }));
    return { status: res.status, json: await res.json() as Record<string, any> };
}

async function tokenRow(hash: string) {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(companyTokens).where(eq(companyTokens.tokenHash, hash));
    return row;
}

/** The host answers a command: ack, a few progress lines, then the result. */
function runJob(host: FakeHost, command: Frame, result: Frame) {
    host.send({ type: "ack", jobId: command.jobId, accepted: true });
    host.send({ type: "progress", jobId: command.jobId, seq: 1, step: "Checking profile", line: "==> Checking profile" });
    host.send({ type: "progress", jobId: command.jobId, seq: 2, step: "Installing", line: "==> Installing growth-hacker (standalone gateway)" });
    host.send({ type: "result", jobId: command.jobId, exitCode: result.ok ? 0 : 11, summary: result.ok ? "done" : "failed", logTail: "", ...result });
}

async function deleteAgent(agentId: string, name: string, extra: Record<string, unknown> = {}) {
    const route = await import("@/app/api/agents/[id]/route");
    const res = await route.DELETE(makeRequest(`http://localhost/api/agents/${agentId}`, { method: "DELETE", body: { confirmName: name, ...extra } }), params(agentId));
    return { status: res.status, json: await res.json() as Record<string, any> };
}

maybe("hire on a host: validated and queued, token minted at dispatch, progress, result, the bridge comes online", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, host } = await onlineHost(s, h);
        actAs(s.admin);
        // What the hire dialog shows for the host.
        const hostsRoute = await import("@/app/api/runtime-hosts/route");
        const listed = (await (await hostsRoute.GET()).json() as { hosts: Frame[] }).hosts[0];
        assert.equal(listed.hire.ok, true);
        assert.deepEqual(listed.hire.providers, ["openrouter", "deepseek"]);
        assert.equal(listed.hire.skipBrowser, true);

        // Refusals before anything is created.
        assert.equal((await hire({ name: "X", runtimeHostId: hostId, llmProvider: "anthropic" })).status, 400, "no anthropic key on that host");
        assert.equal((await hire({ name: 'Bad "quote"', runtimeHostId: hostId, llmProvider: "deepseek" })).status, 400);
        assert.equal((await hire({ name: "X", runtimeHostId: randomUUID(), llmProvider: "deepseek" })).status, 404);
        assert.equal((await hire({ name: "X", runtimeHostId: hostId, llmProvider: "deepseek", model: "a b" })).status, 400);

        const created = await hire({ name: "Growth Hacker", role: "Growth", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek", access: "everyone" });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const agent = created.json.agent;
        const jobId = created.json.jobId as string;
        assert.ok(jobId);
        assert.equal(agent.provider, "hermes");
        assert.equal(agent.deploymentMode, "remote");
        assert.equal(agent.llmProvider, "deepseek");
        assert.equal(agent.llmModel, "deepseek-chat", "the provider's default model");

        const command = await host.waitFor(() => host.commands().find((c) => c.jobId === jobId));
        assert.equal(command.command, "provision_agent");
        assert.equal(command.deadlineSec, 1800);
        const token = command.args.apiToken as string;
        assert.match(token, /^ec_[0-9a-f]{48}$/);
        assert.deepEqual({ ...command.args, apiToken: "x" }, {
            profile: "growth-hacker", agentId: agent.id, agentName: "Growth Hacker", gateway: "standalone", llmProvider: "deepseek",
            model: "deepseek-chat", skipBrowser: true, apiToken: "x",
        }, "no URL, no key: the host has its own");

        const sent = await jobRow(jobId);
        assert.equal(sent.status, "sent");
        assert.equal(sent.idempotencyKey, agent.id);
        assert.ok(!("apiToken" in (sent.argsJson as Frame)), "args_json never holds the token");
        assert.equal(sent.mintedTokenHash, sha(token));
        const minted = await tokenRow(sha(token));
        assert.equal(minted.agentId, agent.id, "bound to the new agent");
        assert.equal(minted.name, `host-provision:${jobId}`);
        assert.equal(minted.revokedAt, null);

        // Audited without the token.
        const db = await getDb();
        const { auditLog, agents } = await getSchema();
        const { and, eq } = await import("drizzle-orm");
        const audits = await db.select().from(auditLog).where(and(eq(auditLog.companyId, s.companyId), eq(auditLog.action, "runtime_host.job_queued")));
        assert.ok(audits.some((a) => JSON.stringify(a.payloadJson).includes("\"provision_agent\"")));
        assert.ok(!JSON.stringify(audits).includes(token));

        // The agent page while it is being set up.
        const agentRoute = await import("@/app/api/agents/[id]/route");
        const during = await (await agentRoute.GET(makeRequest(`http://localhost/api/agents/${agent.id}`), params(agent.id))).json() as Frame;
        assert.equal(during.runtimeHost.id, hostId);
        assert.equal(during.provisioning.status, "sent");
        assert.equal(during.provisioning.profile, "growth-hacker");

        // An inventory without the profile yet (it is being created) does not release the agent.
        host.send(inventoryFrame([viktorProfile(s.viktor.id)]));
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await waitForAgentOnHost(agent.id, hostId)).runtimeProfile, "growth-hacker");

        runJob(host, command, { ok: true, tokenSha256: sha(token) });
        await waitForJob(jobId, "succeeded");
        const jobRoute = await import("@/app/api/runtime-host-jobs/[id]/route");
        const progress = await (await jobRoute.GET(makeRequest(`http://localhost/api/runtime-host-jobs/${jobId}?afterSeq=0`), params(jobId))).json() as Frame;
        assert.deepEqual(progress.events.map((e: Frame) => e.seq), [1, 2]);
        assert.equal((await tokenRow(sha(token))).revokedAt, null, "the token the host holds stays live");

        // The bridge on the host registers and heartbeats with that token: the agent is online.
        const register = await import("@/app/api/mcp/runtime/register/route");
        const reg = await register.POST(makeRequest("http://localhost/api/mcp/runtime/register", {
            method: "POST", headers: auth(token),
            body: { runtimeId: "hermes-malecu-growth-hacker", name: "Hermes on malecu-hermes-1", hostname: "malecu-hermes-1", bridgeVersion: "0.22.0", bridgeProtocol: 2, agentId: agent.id },
        }));
        assert.equal(reg.status, 200, await reg.clone().text());
        const heartbeat = await import("@/app/api/mcp/agents/heartbeat/route");
        assert.equal((await heartbeat.POST(makeRequest("http://localhost/api/mcp/agents/heartbeat", {
            method: "POST", headers: auth(token), body: { agentId: agent.id, currentLoad: 0, runtimeId: "hermes-malecu-growth-hacker" },
        }))).status, 200);
        const [online] = await db.select().from(agents).where(eq(agents.id, agent.id));
        assert.equal(online.status, "online");

        // The host reports the new profile: the agent stays adopted there.
        host.send(inventoryFrame([viktorProfile(s.viktor.id), { ...viktorProfile(agent.id), profile: "growth-hacker" }]));
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await waitForAgentOnHost(agent.id, hostId)).runtimeProfile, "growth-hacker");
        const after = await (await agentRoute.GET(makeRequest(`http://localhost/api/agents/${agent.id}`), params(agent.id))).json() as Frame;
        assert.equal(after.provisioning.status, "succeeded");

        // A second agent with the same name gets the next free profile name.
        const twin = await hire({ name: "Growth Hacker", provider: "hermes", runtimeHostId: hostId, llmProvider: "openrouter" });
        assert.equal(twin.status, 201);
        const twinCommand = await host.waitFor(() => host.commands().find((c) => c.jobId === twin.json.jobId));
        assert.equal(twinCommand.args.profile, "growth-hacker-2");
        assert.equal(twinCommand.args.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
        assert.notEqual(twinCommand.args.apiToken, token);
    } finally {
        await h.close();
    }
});

maybe("a failed setup revokes its token; Retry sends a new one and the old stays revoked; members are refused", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, host } = await onlineHost(s, h);
        actAs(s.member);
        const refused = await hire({ name: "Sneaky", runtimeHostId: hostId, llmProvider: "deepseek" });
        assert.equal(refused.status, 403, "only owners and admins hire onto a host");
        assert.equal((await hire({ name: "Plain member agent", provider: "hermes" })).status, 201, "members still hire the manual way");

        actAs(s.admin);
        const created = await hire({ name: "Courier", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek", model: "deepseek-reasoner" });
        assert.equal(created.status, 201);
        const agentId = created.json.agent.id as string;
        const first = await host.waitFor(() => host.commands().find((c) => c.jobId === created.json.jobId));
        const token1 = first.args.apiToken as string;
        assert.equal(first.args.model, "deepseek-reasoner");
        runJob(host, first, { ok: false, errorCode: "exit_11", summary: "set up Courier: failed: no API key for the model provider on this host (exit 11)" });
        const failed = await waitForJob(first.jobId, "failed");
        assert.match(failed.error ?? "", /no API key/);
        assert.ok((await tokenRow(sha(token1))).revokedAt, "the failed job's token is revoked");

        const agentRoute = await import("@/app/api/agents/[id]/route");
        const page = await (await agentRoute.GET(makeRequest(`http://localhost/api/agents/${agentId}`), params(agentId))).json() as Frame;
        assert.equal(page.provisioning.status, "failed");
        assert.match(page.provisioning.error, /no API key/);
        assert.equal(page.runtimeHost.id, hostId, "still linked to its host (Retry / Remove)");

        const retryRoute = await import("@/app/api/agents/[id]/provision/route");
        actAs(s.member);
        assert.equal((await retryRoute.POST(makeRequest(`http://localhost/api/agents/${agentId}/provision`, { method: "POST" }), params(agentId))).status, 403);
        actAs(s.admin);
        const retried = await retryRoute.POST(makeRequest(`http://localhost/api/agents/${agentId}/provision`, { method: "POST" }), params(agentId));
        assert.equal(retried.status, 201, await retried.clone().text());
        const retryJobId = (await retried.json() as Frame).jobId as string;
        assert.notEqual(retryJobId, first.jobId);
        const second = await host.waitFor(() => host.commands().find((c) => c.jobId === retryJobId));
        const token2 = second.args.apiToken as string;
        assert.notEqual(token2, token1, "a new token");
        assert.equal(second.args.profile, first.args.profile, "the same profile: the host reruns it");
        runJob(host, second, { ok: true, tokenSha256: sha(token2) });
        await waitForJob(retryJobId, "succeeded");
        assert.equal((await tokenRow(sha(token2))).revokedAt, null);
        assert.ok((await tokenRow(sha(token1))).revokedAt, "the old token stays revoked");
        const again = await retryRoute.POST(makeRequest(`http://localhost/api/agents/${agentId}/provision`, { method: "POST" }), params(agentId));
        assert.equal(again.status, 409, "nothing to retry after a success");

        // A job re-sent after a lost ack mints another token: the host reports the one it wrote and only that one survives.
        const third = await hire({ name: "Scout", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek" });
        const cmdA = await host.waitFor(() => host.commands().find((c) => c.jobId === third.json.jobId));
        const db = await getDb();
        const { runtimeHostJobs } = await getSchema();
        const { eq, sql } = await import("drizzle-orm");
        await db.update(runtimeHostJobs).set({ sentAt: sql`now() - interval '2 minutes'` }).where(eq(runtimeHostJobs.id, cmdA.jobId));
        await h.hostServer.sweep();
        const cmdB = await host.waitFor(() => host.commands().filter((c) => c.jobId === third.json.jobId)[1]);
        assert.notEqual(cmdB.args.apiToken, cmdA.args.apiToken);
        runJob(host, cmdA, { ok: true, tokenSha256: sha(cmdA.args.apiToken) });
        await waitForJob(cmdA.jobId, "succeeded");
        assert.equal((await tokenRow(sha(cmdA.args.apiToken))).revokedAt, null, "the token the host wrote stays");
        assert.ok((await tokenRow(sha(cmdB.args.apiToken))).revokedAt, "the unused one is revoked");
    } finally {
        await h.close();
    }
});

maybe("delete an agent on a host: tokens revoked at once, removal queued, kept past an hour offline, run when the host is back", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, token: hostToken, host } = await onlineHost(s, h);
        const builder = await seedAgent(s.companyId, { name: "Builder", provider: "hermes" });
        host.send(inventoryFrame([viktorProfile(s.viktor.id), { ...viktorProfile(builder.id), profile: "builder" }]));
        await waitForAgentOnHost(builder.id, hostId);
        const viktorToken = await seedMcpToken(s.companyId, s.viktor.id);
        await host.close();
        await waitForHostStatus(hostId, "offline");

        actAs(s.admin);
        const deleted = await deleteAgent(s.viktor.id, "Viktor");
        assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
        assert.equal(deleted.json.hostRemoval.status, "queued");
        assert.equal(deleted.json.hostRemoval.hostOnline, false);
        assert.equal(deleted.json.hostRemoval.needsUpdate, false);
        const removeJobId = deleted.json.hostRemoval.jobId as string;
        const queued = await jobRow(removeJobId);
        assert.equal(queued.command, "remove_agent");
        assert.deepEqual(queued.argsJson, { profile: "viktor", agentId: s.viktor.id, purge: true });

        // It can no longer act: its token is refused right away.
        const sync = await import("@/app/api/mcp/messages/sync/route");
        assert.equal((await sync.GET(makeRequest("http://localhost/api/mcp/messages/sync?mode=all", { headers: auth(viktorToken) }))).status, 401);

        // Pending removals show on the host card, with the deleted agent's name.
        const hostsRoute = await import("@/app/api/runtime-hosts/route");
        const card = (await (await hostsRoute.GET()).json() as { hosts: Frame[] }).hosts[0];
        const pending = card.activeJobs.find((j: Frame) => j.id === removeJobId);
        assert.equal(pending.agentName, "Viktor");
        assert.equal(pending.status, "queued");

        // Hours later the host is still away: a queued restart expires, the removal does not.
        const db = await getDb();
        const { runtimeHostJobs, runtimeHosts } = await getSchema();
        const { eq, sql } = await import("drizzle-orm");
        const { queueJob, sweepRuntimeHosts } = await import("@/lib/runtime-hosts/store");
        const restart = await queueJob({ companyId: s.companyId, hostId, agentId: builder.id, command: "restart_agent", args: { profile: "builder", target: "bridge" }, userId: s.admin.userId });
        assert.ok(!restart.conflict);
        await db.update(runtimeHostJobs).set({ createdAt: sql`now() - interval '3 hours'` }).where(eq(runtimeHostJobs.hostId, hostId));
        await db.update(runtimeHosts).set({ lastSeenAt: sql`now() - interval '2 hours'` }).where(eq(runtimeHosts.id, hostId));
        await sweepRuntimeHosts();
        assert.equal((await jobRow(restart.job.id)).status, "canceled", "a restart hours later would surprise: it expired");
        assert.equal((await jobRow(removeJobId)).status, "queued", "the removal waits for the host");
        // A removal the host had started before it vanished goes back to the queue instead of being lost.
        await db.update(runtimeHostJobs).set({ status: "running", startedAt: sql`now() - interval '2 hours'`, deadlineAt: sql`now() + interval '1 hour'` }).where(eq(runtimeHostJobs.id, removeJobId));
        await sweepRuntimeHosts();
        assert.equal((await jobRow(removeJobId)).status, "queued");

        // The host comes back: the removal runs (no token in it).
        const back = await connect(h, hostToken);
        back.hello();
        const command = await back.waitFor(() => back.commands().find((c) => c.jobId === removeJobId));
        assert.deepEqual(command.args, { profile: "viktor", agentId: s.viktor.id, purge: true });
        back.send({ type: "ack", jobId: removeJobId, accepted: true });
        back.send({ type: "result", jobId: removeJobId, ok: true, exitCode: 0, summary: "remove profile viktor (deleted): done", logTail: "" });
        await waitForJob(removeJobId, "succeeded");
        const { agents } = await getSchema();
        const [gone] = await db.select().from(agents).where(eq(agents.id, s.viktor.id));
        assert.ok(gone.deletedAt);
        assert.equal(gone.runtimeHostId, null, "no longer on the host");

        // Without the option: deleted in Emperor only.
        const kept = await deleteAgent(builder.id, "Builder", { removeFromHost: false });
        assert.equal(kept.json.hostRemoval.status, "skipped");
        const builderJobs = await db.select().from(runtimeHostJobs).where(eq(runtimeHostJobs.agentId, builder.id));
        assert.ok(!builderJobs.some((j) => j.command === "remove_agent"));
    } finally {
        await h.close();
    }
});

maybe("delete: no host link, a revoked host, or a member deleting only deletes in Emperor", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, host } = await onlineHost(s, h);
        const plain = await seedAgent(s.companyId, { name: "Plain", provider: "hermes" });
        actAs(s.admin);
        assert.equal((await deleteAgent(plain.id, "Plain")).json.hostRemoval.status, "not_on_host");

        // A member owner of an agent on the host: deleted, but the removal needs an admin.
        const owned = await seedAgent(s.companyId, { name: "Owned", provider: "hermes", access: "everyone" });
        host.send(inventoryFrame([viktorProfile(s.viktor.id), { ...viktorProfile(owned.id), profile: "owned" }]));
        await waitForAgentOnHost(owned.id, hostId);
        actAs(s.member);
        const byMember = await deleteAgent(owned.id, "Owned");
        assert.equal(byMember.status, 200, JSON.stringify(byMember.json));
        assert.equal(byMember.json.hostRemoval.status, "admin_required");

        actAs(s.admin);
        const hostRoute = await import("@/app/api/runtime-hosts/[id]/route");
        assert.equal((await hostRoute.DELETE(makeRequest(`http://localhost/api/runtime-hosts/${hostId}`, { method: "DELETE" }), params(hostId))).status, 200);
        const gone = await deleteAgent(s.viktor.id, "Viktor");
        assert.equal(gone.status, 200);
        assert.equal(gone.json.hostRemoval.status, "not_on_host", "revoking the host released its agents");
    } finally {
        await h.close();
    }
});

maybe("a 0.21 daemon: no hiring there (Update this host), its removals wait until it is updated", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, token, host } = await onlineHost(s, h, { commands: null });
        actAs(s.admin);
        const hostsRoute = await import("@/app/api/runtime-hosts/route");
        const card = (await (await hostsRoute.GET()).json() as { hosts: Frame[] }).hosts[0];
        assert.equal(card.hire.ok, false);
        assert.equal(card.hire.code, "update");
        assert.deepEqual([...card.commands].sort(), ["refresh_inventory", "restart_agent"]);
        const refused = await hire({ name: "New one", runtimeHostId: hostId, llmProvider: "deepseek" });
        assert.equal(refused.status, 409);
        assert.match(refused.json.error, /Update this host to hire here/);

        // Restarts keep working on a 0.21 daemon.
        const jobsRoute = await import("@/app/api/runtime-hosts/[id]/jobs/route");
        const restart = await jobsRoute.POST(makeRequest(`http://localhost/api/runtime-hosts/${hostId}/jobs`, {
            method: "POST", body: { command: "restart_agent", agentId: s.viktor.id },
        }), params(hostId));
        assert.equal(restart.status, 201);
        const restartCommand = await host.waitFor(() => host.commands().find((c) => c.command === "restart_agent"));
        host.send({ type: "ack", jobId: restartCommand.jobId, accepted: true });
        host.send({ type: "result", jobId: restartCommand.jobId, ok: true, exitCode: 0, summary: "done", logTail: "" });
        await waitForJob(restartCommand.jobId, "succeeded");
        // provision/remove never go through the raw jobs route.
        for (const command of ["provision_agent", "remove_agent"]) {
            const res = await jobsRoute.POST(makeRequest(`http://localhost/api/runtime-hosts/${hostId}/jobs`, { method: "POST", body: { command, agentId: s.viktor.id } }), params(hostId));
            assert.equal(res.status, 400, command);
        }

        const deleted = await deleteAgent(s.viktor.id, "Viktor");
        assert.equal(deleted.json.hostRemoval.status, "queued");
        assert.equal(deleted.json.hostRemoval.needsUpdate, true);
        const removeJobId = deleted.json.hostRemoval.jobId as string;
        await h.hostServer.sweep();
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(!host.commands().some((c) => c.command === "remove_agent"), "never sent to a daemon that does not know it");
        assert.equal((await jobRow(removeJobId)).status, "queued");

        // The host is updated to 0.22 and reconnects: now it gets the removal.
        await host.close();
        const updated = await connect(h, token);
        updated.hello();
        const command = await updated.waitFor(() => updated.commands().find((c) => c.jobId === removeJobId));
        assert.equal(command.command, "remove_agent");
    } finally {
        await h.close();
    }
});

maybe("an agent-bound token (as a hosted agent gets) does everything a bridge does", async () => {
    await resetDb();
    const db = await getDb();
    const { companies, companyMembers, projects, tasks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId, userId: person } = await seedCompanyWithToken();
    await db.insert(companyMembers).values({ companyId, userId: person, role: "owner" });
    await db.update(companies).set({ directChatMode: "shared" }).where(eq(companies.id, companyId));
    const agent = await seedAgent(companyId, { name: "Hosted", provider: "hermes" });
    const other = await seedAgent(companyId, { name: "Other", provider: "hermes" });
    const { mintAgentRuntimeToken } = await import("@/lib/agent-runtime-tokens");
    const { rawToken: token } = await mintAgentRuntimeToken({ companyId, agentId: agent.id, name: `host-provision:${randomUUID()}` });
    const { ensureDirectThread, ensureTeamThread, appendThreadMessage } = await import("@/lib/control-plane");

    // register + heartbeat
    const register = await import("@/app/api/mcp/runtime/register/route");
    const reg = await register.POST(makeRequest("http://localhost/api/mcp/runtime/register", {
        method: "POST", headers: auth(token),
        body: { runtimeId: "hermes-host-hosted", name: "Hermes on host", hostname: "host", bridgeVersion: "0.22.0", bridgeProtocol: 2, agentId: agent.id },
    }));
    assert.equal(reg.status, 200, await reg.clone().text());
    assert.equal(((await reg.json()) as Frame).runtimeNode.agentId, agent.id);
    const heartbeat = await import("@/app/api/mcp/agents/heartbeat/route");
    assert.equal((await heartbeat.POST(makeRequest("http://localhost/api/mcp/agents/heartbeat", {
        method: "POST", headers: auth(token), body: { agentId: agent.id, currentLoad: 0, runtimeId: "hermes-host-hosted" },
    }))).status, 200);
    assert.equal((await heartbeat.POST(makeRequest("http://localhost/api/mcp/agents/heartbeat", {
        method: "POST", headers: auth(token), body: { agentId: other.id, currentLoad: 0 },
    }))).status, 403, "never another agent's liveness");

    // intake: the long-poll sync (team message + a DM to it), naming itself as the bridge does
    const team = await ensureTeamThread(companyId);
    const teamMsg = await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: person, text: "@Hosted hello team" });
    const dm = await ensureDirectThread(companyId, agent.id, person);
    const dmMsg = await appendThreadMessage({ companyId, threadId: dm.id, senderType: "human", senderId: person, targetAgentId: agent.id, text: "a DM" });
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const since = new Date(Date.now() - 60_000).toISOString();
    const synced = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&since=${encodeURIComponent(since)}&agentId=${agent.id}`, { headers: auth(token) }));
    assert.equal(synced.status, 200);
    const ids = ((await synced.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    assert.ok(ids.includes(teamMsg.id) && ids.includes(dmMsg.id), "team chat and the DM reach the bridge");

    // post in team chat, answer the DM, typing/read status
    const send = await import("@/app/api/mcp/messages/send/route");
    const post = (body: Frame) => send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: { ...auth(token), "idempotency-key": `k-${randomUUID()}` }, body: { agentId: agent.id, ...body },
    }));
    assert.equal((await post({ thread_id: team.id, text: "hello from the host" })).status, 200);
    assert.equal((await post({ thread_id: dm.id, text: "DM answer", replyToMessageId: dmMsg.id })).status, 200);
    const status = await import("@/app/api/mcp/chat/status/route");
    assert.equal((await status.POST(makeRequest("http://localhost/api/mcp/chat/status", {
        method: "POST", headers: auth(token), body: { threadId: dm.id, agentId: agent.id, typing: true, markRead: true },
    }))).status, 200);
    assert.equal((await post({ thread_id: team.id, agentId: other.id, text: "as another agent" })).status, 403);

    // private chat: the company switches to private chats; P's private thread with the agent
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const privateThread = await ensureDirectThread(companyId, agent.id, person);
    assert.equal(privateThread.isPrivate, true);
    const privateMsg = await appendThreadMessage({ companyId, threadId: privateThread.id, senderType: "human", senderId: person, targetAgentId: agent.id, text: "private question" });
    const privateSync = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&since=${encodeURIComponent(since)}&agentId=${agent.id}`, { headers: auth(token) }));
    assert.ok(((await privateSync.json()) as { messages: { id: string }[] }).messages.some((m) => m.id === privateMsg.id), "its private chats reach it");
    const threadRoute = await import("@/app/api/mcp/threads/[id]/messages/route");
    assert.equal((await threadRoute.GET(makeRequest(`http://localhost/api/mcp/threads/${privateThread.id}/messages?agentId=${agent.id}`, { headers: auth(token) }), params(privateThread.id))).status, 200);
    const reply = await post({ thread_id: privateThread.id, text: "private answer", replyToMessageId: privateMsg.id });
    assert.equal(reply.status, 200, await reply.clone().text());
    const [stored] = await db.select().from(threadMessages).where(eq(threadMessages.id, ((await reply.json()) as Frame).message_id));
    assert.equal(stored.threadId, privateThread.id);
    assert.equal(stored.senderId, agent.id);

    // runs and run events
    const runs = await import("@/app/api/mcp/agents/runs/route");
    const runEvents = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const runRoute = await import("@/app/api/mcp/agents/runs/[id]/route");
    const runId = randomUUID();
    assert.equal((await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(token), body: { id: runId, agentId: agent.id, triggerKind: "message", triggerMessageId: privateMsg.id, threadId: privateThread.id },
    }))).status, 200);
    const events = await runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${runId}/events?agentId=${agent.id}`, {
        method: "POST", headers: auth(token), body: { events: [{ id: randomUUID(), seq: 1, kind: "turn.started", ts: new Date().toISOString() }] },
    }), params(runId));
    assert.equal(events.status, 200, await events.clone().text());
    const finished = await runRoute.PATCH(makeRequest(`http://localhost/api/mcp/agents/runs/${runId}?agentId=${agent.id}`, {
        method: "PATCH", headers: auth(token), body: { status: "succeeded", replyMessageId: stored.id },
    }), params(runId));
    assert.equal(finished.status, 200, await finished.clone().text());

    // task updates
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "work", state: "inbox", assignedAgentId: agent.id, inputJson: { title: "Write copy" } }).returning();
    const taskRoute = await import("@/app/api/mcp/tasks/[id]/route");
    const patched = await taskRoute.PATCH(makeRequest(`http://localhost/api/mcp/tasks/${task.id}`, {
        method: "PATCH", headers: { ...auth(token), "idempotency-key": `t-${randomUUID()}` }, body: { agentId: agent.id, state: "in_progress" },
    }), params(task.id));
    assert.equal(patched.status, 200, await patched.clone().text());
    const [moved] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(moved.state, "in_progress");
});

// ── review hardening ────────────────────────────────────────────────────────

async function jobAction(jobId: string, action: string) {
    const route = await import("@/app/api/runtime-host-jobs/[id]/route");
    const res = await route.POST(makeRequest(`http://localhost/api/runtime-host-jobs/${jobId}`, { method: "POST", body: { action } }), params(jobId));
    return { status: res.status, json: await res.json() as Record<string, any> };
}

maybe("memory: queued hires reserve their share; a fresh heartbeat short of memory fails the job at dispatch with a clear reason", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, host } = await onlineHost(s, h);
        host.send({ type: "heartbeat", memAvailMiB: 1100, load1: 0.1, activeJobId: null });
        await new Promise((r) => setTimeout(r, 200));
        actAs(s.admin);
        const first = await hire({ name: "First", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek" });
        assert.equal(first.status, 201);
        const second = await hire({ name: "Second", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek" });
        assert.equal(second.status, 201, "1100 MB minus one queued setup (512) still fits one more");
        const third = await hire({ name: "Third", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek" });
        assert.equal(third.status, 409, "1100 MB minus two queued setups leaves too little");
        assert.match(third.json.error, /setups already queued/);
        // Meanwhile the host's memory dropped: when the second is dispatched, it fails with the reason.
        const firstCommand = await host.waitFor(() => host.commands().find((c) => c.jobId === first.json.jobId));
        host.send({ type: "heartbeat", memAvailMiB: 300, load1: 0.1, activeJobId: firstCommand.jobId });
        await new Promise((r) => setTimeout(r, 200));
        runJob(host, firstCommand, { ok: true, tokenSha256: sha(firstCommand.args.apiToken) });
        const failed = await waitForJob(second.json.jobId, "failed");
        assert.match(failed.error ?? "", /Not enough free memory on the host now \(300 MB free, a new agent needs 512 MB\)/);
        assert.ok(!host.commands().some((c) => c.jobId === second.json.jobId), "never sent");
        assert.equal(failed.mintedTokenHash, null, "no token was minted for it");
    } finally {
        await h.close();
    }
});

maybe("tokens: the sweeper revokes provisioning tokens of failed jobs and deleted agents", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId } = await onlineHost(s, h);
        const db = await getDb();
        const { runtimeHostJobs, agents } = await getSchema();
        const { eq } = await import("drizzle-orm");
        const { mintAgentRuntimeToken } = await import("@/lib/agent-runtime-tokens");
        const [failedJob] = await db.insert(runtimeHostJobs).values({
            companyId: s.companyId, hostId, agentId: s.viktor.id, command: "provision_agent", argsJson: {}, status: "failed", finishedAt: new Date(),
        }).returning();
        const stray = await mintAgentRuntimeToken({ companyId: s.companyId, agentId: s.viktor.id, name: `host-provision:${failedJob.id}` });
        const ghost = await seedAgent(s.companyId, { name: "Ghost", provider: "hermes" });
        const ghostToken = await mintAgentRuntimeToken({ companyId: s.companyId, agentId: ghost.id, name: `host-provision:${randomUUID()}` });
        await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, ghost.id));
        const live = await mintAgentRuntimeToken({ companyId: s.companyId, agentId: s.viktor.id, name: `host-provision:${randomUUID()}` });
        const { sweepRuntimeHosts } = await import("@/lib/runtime-hosts/store");
        const swept = await sweepRuntimeHosts();
        assert.ok((swept?.revokedTokens ?? 0) >= 2, JSON.stringify(swept));
        assert.ok((await tokenRow(stray.tokenHash)).revokedAt, "a failed job's token");
        assert.ok((await tokenRow(ghostToken.tokenHash)).revokedAt, "a deleted agent's token");
        assert.equal((await tokenRow(live.tokenHash)).revokedAt, null, "a token of a job we know nothing bad about stays");
    } finally {
        await h.close();
    }
});

maybe("setup states: after a revoke the failed setup still shows; an offline host's queued setup says when it expires", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, host } = await onlineHost(s, h);
        actAs(s.admin);
        const created = await hire({ name: "Waiter", provider: "hermes", runtimeHostId: hostId, llmProvider: "deepseek" });
        const command = await host.waitFor(() => host.commands().find((c) => c.jobId === created.json.jobId));
        runJob(host, command, { ok: false, errorCode: "exit_12", summary: "did not register" });
        await waitForJob(command.jobId, "failed");
        const agentId = created.json.agent.id as string;
        const agentRoute = await import("@/app/api/agents/[id]/route");
        const hostRoute = await import("@/app/api/runtime-hosts/[id]/route");
        assert.equal((await hostRoute.DELETE(makeRequest(`http://localhost/api/runtime-hosts/${hostId}`, { method: "DELETE" }), params(hostId))).status, 200);
        const page = await (await agentRoute.GET(makeRequest(`http://localhost/api/agents/${agentId}`), params(agentId))).json() as Frame;
        assert.equal(page.runtimeHost, null, "the revoke cleared the link");
        assert.equal(page.provisioning.status, "failed", "Setup failed still shows");
        assert.equal(page.provisioning.hostStatus, "revoked");
        const retryRoute = await import("@/app/api/agents/[id]/provision/route");
        const retried = await retryRoute.POST(makeRequest(`http://localhost/api/agents/${agentId}/provision`, { method: "POST" }), params(agentId));
        assert.equal(retried.status, 409);
        assert.match(((await retried.json()) as Frame).error, /was revoked/);

        // Pair the machine again; it goes offline with a setup still queued.
        const again = await onlineHost(s, h);
        const queued = await hire({ name: "Patient", provider: "hermes", runtimeHostId: again.hostId, llmProvider: "deepseek" });
        const sent = await again.host.waitFor(() => again.host.commands().find((c) => c.jobId === queued.json.jobId));
        await again.host.close();
        await waitForHostStatus(again.hostId, "offline");
        const db = await getDb();
        const { runtimeHostJobs } = await getSchema();
        const { eq } = await import("drizzle-orm");
        await db.update(runtimeHostJobs).set({ status: "queued", sentAt: null }).where(eq(runtimeHostJobs.id, sent.jobId));
        const waiting = await (await agentRoute.GET(makeRequest(`http://localhost/api/agents/${queued.json.agent.id}`), params(queued.json.agent.id))).json() as Frame;
        assert.equal(waiting.provisioning.status, "queued");
        assert.equal(waiting.provisioning.hostStatus, "offline");
        const minutes = (new Date(waiting.provisioning.expiresAt).getTime() - Date.now()) / 60_000;
        assert.ok(minutes > 55 && minutes <= 60, `expires in about an hour (${minutes})`);
    } finally {
        await h.close();
    }
});

maybe("removals: a failed one stays until dismissed and can be retried; a pending one can be canceled; a revoke reports the profiles left", async () => {
    const s = await world();
    const h = await harness();
    try {
        const { hostId, host } = await onlineHost(s, h);
        const builder = await seedAgent(s.companyId, { name: "Builder", provider: "hermes" });
        const scout = await seedAgent(s.companyId, { name: "Scout", provider: "hermes" });
        host.send(inventoryFrame([viktorProfile(s.viktor.id), { ...viktorProfile(builder.id), profile: "builder" }, { ...viktorProfile(scout.id), profile: "scout" }]));
        await waitForAgentOnHost(scout.id, hostId);
        actAs(s.admin);

        // A removal the host refuses: failed, and it stays on the host card long after.
        const deleted = await deleteAgent(s.viktor.id, "Viktor");
        const removeJobId = deleted.json.hostRemoval.jobId as string;
        const command = await host.waitFor(() => host.commands().find((c) => c.jobId === removeJobId));
        host.send({ type: "ack", jobId: command.jobId, accepted: false, reason: "agent_mismatch: profile viktor belongs to another agent; not removed" });
        await waitForJob(removeJobId, "failed");
        const db = await getDb();
        const { runtimeHostJobs, auditLog } = await getSchema();
        const { and, eq, sql } = await import("drizzle-orm");
        await db.update(runtimeHostJobs).set({ finishedAt: sql`now() - interval '3 hours'` }).where(eq(runtimeHostJobs.id, removeJobId));
        const hostsRoute = await import("@/app/api/runtime-hosts/route");
        const listed = async () => (await (await hostsRoute.GET()).json() as { hosts: Frame[] }).hosts[0].activeJobs as Frame[];
        assert.ok((await listed()).some((j) => j.id === removeJobId && j.status === "failed"), "still visible hours later");

        const retried = await jobAction(removeJobId, "retry");
        assert.equal(retried.status, 201, JSON.stringify(retried.json));
        assert.notEqual(retried.json.job.id, removeJobId);
        assert.ok(!(await listed()).some((j) => j.id === removeJobId), "the retried one is dismissed");
        const again = await host.waitFor(() => host.commands().find((c) => c.jobId === retried.json.job.id));
        host.send({ type: "ack", jobId: again.jobId, accepted: false, reason: "agent_mismatch" });
        await waitForJob(again.jobId, "failed");
        assert.equal((await jobAction(again.jobId, "dismiss")).status, 200);
        assert.ok(!(await listed()).some((j) => j.id === again.jobId), "dismissed");
        assert.equal((await jobAction(again.jobId, "cancel")).status, 409, "only a waiting removal can be canceled");

        // A pending removal (host offline) is canceled: the profile stays, audited.
        await host.close();
        await waitForHostStatus(hostId, "offline");
        const pending = await deleteAgent(builder.id, "Builder");
        const pendingId = pending.json.hostRemoval.jobId as string;
        actAs(s.member);
        assert.equal((await jobAction(pendingId, "cancel")).status, 403);
        actAs(s.admin);
        assert.equal((await jobAction(pendingId, "cancel")).status, 200);
        assert.equal((await jobRow(pendingId)).status, "canceled");
        assert.ok(!(await listed()).some((j) => j.id === pendingId), "a canceled removal is not left on the card");

        // Revoking the host with a removal still pending: reported and audited as left on the host.
        const lastOne = await deleteAgent(scout.id, "Scout");
        assert.equal(lastOne.json.hostRemoval.status, "queued");
        const hostRoute = await import("@/app/api/runtime-hosts/[id]/route");
        const revoked = await hostRoute.DELETE(makeRequest(`http://localhost/api/runtime-hosts/${hostId}`, { method: "DELETE" }), params(hostId));
        const body = await revoked.json() as Frame;
        assert.deepEqual(body.leftProfiles, [{ agentId: scout.id, agentName: "Scout", profile: "scout" }]);
        const abandoned = await db.select().from(auditLog).where(and(eq(auditLog.companyId, s.companyId), eq(auditLog.action, "runtime_host.removal_abandoned")));
        assert.equal(abandoned.length, 1);
        const canceledAudit = await db.select().from(auditLog).where(and(eq(auditLog.companyId, s.companyId), eq(auditLog.action, "runtime_host.removal_canceled")));
        assert.equal(canceledAudit.length, 1);
    } finally {
        await h.close();
    }
});
