import { test } from "node:test";
import assert from "node:assert/strict";
import { appendedIds } from "../../src/lib/use-live-arrivals";

const ids = (...list: string[]) => list.map((id) => ({ id }));

test("the first load of a thread animates nothing", () => {
    assert.deepEqual(appendedIds([], ids("a", "b", "c")), []);
});

test("messages appended after the last known one are live arrivals", () => {
    assert.deepEqual(appendedIds(ids("a", "b"), ids("a", "b", "c", "d")), ["c", "d"]);
});

test("older pages loaded above are history, not arrivals", () => {
    assert.deepEqual(appendedIds(ids("c", "d"), ids("a", "b", "c", "d")), []);
    assert.deepEqual(appendedIds(ids("c", "d"), ids("a", "b", "c", "d", "e")), ["e"]);
});

test("a different thread (the last known message is gone) animates nothing", () => {
    assert.deepEqual(appendedIds(ids("a", "b"), ids("x", "y")), []);
});
