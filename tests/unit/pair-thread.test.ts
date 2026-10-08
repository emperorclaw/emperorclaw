import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { relatedTaskId } from "../../src/lib/groups";

test("relatedTaskId finds a task link in message text", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(relatedTaskId([{ text: `Fixed — see [task](emperor://task/${id})` }]), id);
});

test("relatedTaskId reads taskIds from metadata", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    assert.equal(relatedTaskId([{ text: "done", metadataJson: { taskIds: [id] } }]), id);
});

test("relatedTaskId reads a single taskId from metadata", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    assert.equal(relatedTaskId([{ text: "handoff", metadataJson: { taskId: id } }]), id);
});

test("relatedTaskId prefers the newest message", () => {
    const oldId = "11111111-1111-4111-8111-111111111111";
    const newId = "22222222-2222-4222-8222-222222222222";
    // Newest-first order.
    const messages = [
        { text: `latest ref emperor://task/${newId}` },
        { text: `older ref emperor://task/${oldId}` },
    ];
    assert.equal(relatedTaskId(messages), newId);
});

test("relatedTaskId returns null when no task is referenced", () => {
    assert.equal(relatedTaskId([]), null);
    assert.equal(relatedTaskId([{ text: "no links here", metadataJson: {} }]), null);
    assert.equal(relatedTaskId([{ text: null, metadataJson: { something: true } }]), null);
});

// The conversations endpoint is read-only and private-agent-scoped: it must
// gate on owner/admin before touching the database.
test("GET /api/agents/[id]/conversations is gated to owners and admins", () => {
    const source = readFileSync(resolve(__dirname, "../..", "src/app/api/agents/[id]/conversations/route.ts"), "utf8");
    const handler = source.slice(source.indexOf("export async function GET"));
    assert.ok(handler.length > 0, "GET handler exists");
    const guard = handler.indexOf('requireRole("owner", "admin")');
    assert.ok(guard > 0, "guarded by requireRole(\"owner\", \"admin\")");
    const firstDbUse = handler.search(/\bdb\.(select|update|insert|delete)\b/);
    assert.ok(firstDbUse === -1 || guard < firstDbUse, "the guard runs before any database access");
});
