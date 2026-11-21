import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskRef } from "../../src/lib/task-id";

const UUID = "9f691848-f928-42e8-8e41-a761ba5e1103";

test("a full UUID is passed through, any case", () => {
    assert.deepEqual(classifyTaskRef(UUID), { kind: "id", id: UUID });
    assert.deepEqual(classifyTaskRef(UUID.toUpperCase()), { kind: "id", id: UUID });
    assert.deepEqual(classifyTaskRef(`  ${UUID}  `), { kind: "id", id: UUID });
});

test("an id with its dashes stripped is still an id", () => {
    assert.deepEqual(classifyTaskRef(UUID.replace(/-/g, "")), { kind: "id", id: UUID });
    assert.deepEqual(classifyTaskRef(UUID.replace(/-/g, "").toUpperCase()), { kind: "id", id: UUID });
});

test("the eight-character short code is a prefix, either case", () => {
    assert.deepEqual(classifyTaskRef("7793dcfa"), { kind: "prefix", prefix: "7793dcfa" });
    assert.deepEqual(classifyTaskRef("9F691848"), { kind: "prefix", prefix: "9f691848" });
});

test("a truncated id is a prefix as long as it can address one task", () => {
    // Dashes only count when the whole id is there: a half-dashed id is a typo,
    // and guessing which dashes were meant is worse than saying so.
    assert.equal(classifyTaskRef("7793dcfa-1234").kind, "invalid");
    assert.deepEqual(classifyTaskRef("7793dcfa1234"), { kind: "prefix", prefix: "7793dcfa1234" });
});

test("anything that is not hex is refused with a message that says what to send", () => {
    for (const raw of ["not-a-task-id", "task-7793dcfa", "7793dcfg", "78 93", "0x7793dcfa"]) {
        const ref = classifyTaskRef(raw);
        assert.equal(ref.kind, "invalid", raw);
        assert.match((ref as { error: string }).error, /UUID or its 8-character short code/);
    }
});

test("seven hex characters are too short to name a task, and an empty id says so", () => {
    assert.equal(classifyTaskRef("7793dcf").kind, "invalid");
    assert.equal(classifyTaskRef("").kind, "invalid");
    assert.equal(classifyTaskRef(null).kind, "invalid");
    assert.equal(classifyTaskRef(undefined).kind, "invalid");
    assert.match((classifyTaskRef("") as { error: string }).error, /required/);
});
