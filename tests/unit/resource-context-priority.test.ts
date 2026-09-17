import { test } from "node:test";
import assert from "node:assert/strict";
import { resourceContextPriority } from "../../src/lib/resource-context-priority";

const context = { projectId: "p1", customerId: "c1", agentId: "a1", selected: new Set<string>(), matchingTags: new Set<string>(), neighbors: new Set<string>() };
const note = { id: "n1", name: "Reference", scopeType: "company", scopeId: null as string | null, isShared: false };

test("auto-injection off excludes references even in matching scopes", () => {
    for (const [scopeType, scopeId] of [["company", null], ["project", "p1"], ["customer", "c1"], ["agent", "a1"]]) {
        assert.equal(resourceContextPriority({ ...note, scopeType: scopeType!, scopeId }, context), 99);
    }
});
test("shared doctrine leads, scoped shared notes require matching context", () => {
    assert.equal(resourceContextPriority({ ...note, name: "Operating Doctrine", isShared: true }, context), 1);
    assert.equal(resourceContextPriority({ ...note, scopeType: "project", scopeId: "p1", isShared: true }, context), 2);
    assert.equal(resourceContextPriority({ ...note, scopeType: "project", scopeId: "other", isShared: true }, context), 99);
});
test("explicit requests and linked references still resolve unshared notes", () => {
    assert.equal(resourceContextPriority(note, { ...context, selected: new Set(["n1"]) }), 3);
    assert.equal(resourceContextPriority(note, { ...context, matchingTags: new Set(["n1"]) }), 3);
    assert.equal(resourceContextPriority(note, { ...context, neighbors: new Set(["n1"]) }), 4);
});
