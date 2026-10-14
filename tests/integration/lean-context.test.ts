import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createNote(companyId: string, input: Record<string, unknown>) {
    const { createScopedResource } = await import("@/lib/resources");
    return createScopedResource({
        companyId,
        provider: "knowledge",
        resourceType: "knowledge_base",
        ...input,
    } as Parameters<typeof createScopedResource>[0]);
}

maybe("lean context returns kernel, scoped index, always block, roster, and an ETag", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const viewer = await seedAgent(companyId, { name: "Viewer", role: "Reviewer" });
    const owner = await seedAgent(companyId, { name: "Owner", role: "Builder" });

    await createNote(companyId, {
        scopeType: "company",
        name: "Company Rule",
        inject: "index",
        summary: "Company-wide rule summary",
        configText: "company body",
    });
    await createNote(companyId, {
        scopeType: "agent",
        scopeId: viewer.id,
        name: "Viewer Note",
        inject: "index",
        summary: "Only viewer sees this",
        configText: "viewer body",
    });
    const secretNote = await createNote(companyId, {
        scopeType: "agent",
        scopeId: owner.id,
        name: "Owner Note",
        inject: "index",
        summary: "Owner only",
        configText: "owner body",
    });
    await createNote(companyId, {
        scopeType: "company",
        name: "Always Rule",
        inject: "always",
        summary: "Pushed every session",
        configText: "always body",
    });

    const route = await import("@/app/api/mcp/context/lean/route");
    const res = await route.GET(makeRequest(`http://localhost/api/mcp/context/lean?agentId=${viewer.name}`, { headers: auth(rawToken) }));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.version, 1);
    assert.ok(body.kernel.includes("approved"));
    assert.ok(body.knowledgeIndex.includes("Company Rule"));
    assert.ok(body.knowledgeIndex.includes("Viewer Note"));
    assert.equal(body.knowledgeIndex.includes("Owner Note"), false, "another agent's note must not leak into the index");
    assert.equal(body.knowledgeIndex.includes(secretNote.id), false);
    assert.ok(body.alwaysBlock.includes("always body"));
    assert.ok(body.roster.includes("@Viewer"));
    assert.equal(body.roster.includes("Owner"), true);

    const etag = res.headers.get("ETag");
    assert.ok(etag && etag.length > 2, "lean context must return an ETag");
    const cached = await route.GET(makeRequest(`http://localhost/api/mcp/context/lean?agentId=${viewer.name}`, {
        headers: { ...auth(rawToken), "if-none-match": etag! },
    }));
    assert.equal(cached.status, 304);
});

maybe("lean context truncates the always block over the 1,500-char budget", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    await createNote(companyId, {
        scopeType: "company",
        name: "Huge Always",
        inject: "always",
        configText: "z".repeat(4000),
    });

    const route = await import("@/app/api/mcp/context/lean/route");
    const body = await (await route.GET(makeRequest("http://localhost/api/mcp/context/lean", { headers: auth(rawToken) }))).json();
    assert.equal(body.alwaysOverBudget, true);
    assert.ok(body.alwaysBlock.length <= 1500);
    assert.ok(body.alwaysBlock.includes("always budget reached"));
});

maybe("manual endpoint serves the whole manual and a single section", async () => {
    await resetDb();
    const { rawToken } = await seedCompanyWithToken();
    const route = await import("@/app/api/mcp/manual/route");

    const all = await (await route.GET(makeRequest("http://localhost/api/mcp/manual", { headers: auth(rawToken) }))).json();
    assert.ok(all.sections.some((section: { id: string }) => section.id === "approvals"));
    assert.ok(all.manual.includes("## Approvals"));

    const { RICH_REPLY_GUIDE } = await import("@/lib/rich-reply-guide");
    const one = await (await route.GET(makeRequest("http://localhost/api/mcp/manual?section=reply-formatting", { headers: auth(rawToken) }))).json();
    assert.equal(one.section.body, RICH_REPLY_GUIDE);

    const missing = await route.GET(makeRequest("http://localhost/api/mcp/manual?section=nope", { headers: auth(rawToken) }));
    assert.equal(missing.status, 404);
});

maybe("knowledge note endpoint sanitizes secrets and enforces scope", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const viewer = await seedAgent(companyId, { name: "Viewer" });
    const owner = await seedAgent(companyId, { name: "Owner" });
    const own = await createNote(companyId, {
        scopeType: "agent", scopeId: viewer.id, name: "Own", configText: "viewer body", secretText: "sk-viewer",
    });
    const other = await createNote(companyId, {
        scopeType: "agent", scopeId: owner.id, name: "Other", configText: "owner body", secretText: "sk-owner",
    });

    const route = await import("@/app/api/mcp/knowledge/[id]/route");
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    const ownRes = await route.GET(makeRequest(`http://localhost/api/mcp/knowledge/${own.id}?agentId=${viewer.name}`, { headers: auth(rawToken) }), params(own.id));
    assert.equal(ownRes.status, 200);
    const ownBody = await ownRes.json();
    assert.equal(ownBody.resource.id, own.id);
    assert.equal("secretText" in ownBody.resource, false);
    assert.equal(JSON.stringify(ownBody).includes("sk-viewer"), false);

    const denied = await route.GET(makeRequest(`http://localhost/api/mcp/knowledge/${other.id}?agentId=${viewer.name}`, { headers: auth(rawToken) }), params(other.id));
    assert.equal(denied.status, 404);
});

maybe("knowledge search returns bounded index lines and matches the summary", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const unique = `zorptastic${randomUUID().slice(0, 8)}`;
    const note = await createNote(companyId, {
        scopeType: "company",
        name: "Quarterly plan",
        summary: `Strategy hinges on the ${unique} initiative`,
        configText: "body without the trigger word",
    });

    const route = await import("@/app/api/mcp/knowledge/search/route");
    const body = await (await route.GET(makeRequest(`http://localhost/api/mcp/knowledge/search?q=${unique}`, { headers: auth(rawToken) }))).json();
    assert.equal(body.count, 1);
    assert.equal(body.results[0].id, note.id);
    assert.ok(body.results[0].line.includes(note.id));

    const empty = await (await route.GET(makeRequest("http://localhost/api/mcp/knowledge/search?q=", { headers: auth(rawToken) }))).json();
    assert.equal(empty.count, 0);
});

maybe("the migration maps is_shared onto inject and the app keeps them in step", async () => {
    // The SQL data migration itself (pre-existing rows).
    const dir = join(process.cwd(), "src", "db", "migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("knowledge-injection-modes.sql"));
    assert.ok(file, "knowledge-injection-modes migration should exist");
    const sql = readFileSync(join(dir, file!), "utf8");
    assert.ok(sql.includes("ADD COLUMN \"inject\""), "migration adds the inject column");
    assert.ok(sql.includes("DEFAULT 'on_request'"), "inject defaults to on_request (matches is_shared=false)");
    assert.ok(sql.includes("CASE WHEN \"is_shared\" THEN 'index' ELSE 'on_request' END"), "migration maps is_shared -> inject");

    // The app-level mapping for new/updated rows.
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const sharedRow = await createNote(companyId, { scopeType: "company", name: "Shared", isShared: true });
    assert.equal(sharedRow.inject, "index");
    assert.equal(sharedRow.isShared, true);
    const privateRow = await createNote(companyId, { scopeType: "company", name: "Private", isShared: false });
    assert.equal(privateRow.inject, "on_request");
    assert.equal(privateRow.isShared, false);

    const { updateScopedResource } = await import("@/lib/resources");
    const promoted = await updateScopedResource({
        companyId,
        resourceId: privateRow.id,
        patch: { isShared: true },
    });
    assert.equal(promoted?.inject, "index");
    assert.equal(promoted?.isShared, true);
});

maybe("the boot backfill excludes deleted rows and never leaves an empty body null", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { scopedResources } = await getSchema();

    // createScopedResource always derives a summary, so insert null-summary rows
    // directly to exercise the pre-migration state the backfill targets.
    await db.insert(scopedResources).values([
        { companyId, scopeType: "company", provider: "knowledge", resourceType: "knowledge_base", name: "Empty", configText: "", summary: null },
        { companyId, scopeType: "company", provider: "knowledge", resourceType: "knowledge_base", name: "Body", configText: "Refunds count against the client total.", summary: null },
        { companyId, scopeType: "company", provider: "knowledge", resourceType: "knowledge_base", name: "Deleted", configText: "gone", summary: null, deletedAt: new Date() },
    ]);

    const { backfillKnowledgeSummaries } = await import("@/lib/knowledge-backfill");
    const result = await backfillKnowledgeSummaries();
    assert.equal(result.scanned, 2, "soft-deleted rows are excluded");
    assert.equal(result.updated, 2);

    const rows = await db.select().from(scopedResources);
    const byName = new Map(rows.map((row) => [row.name, row]));
    assert.equal(byName.get("Empty")!.summary, "", "an empty body becomes an empty string, not null");
    assert.equal(byName.get("Body")!.summary, "Refunds count against the client total.");
    assert.equal(byName.get("Deleted")!.summary, null, "a soft-deleted row is left untouched");

    // Idempotent: the empty-string summary stops the row matching `summary IS NULL`.
    const second = await backfillKnowledgeSummaries();
    assert.equal(second.scanned, 0);
});
