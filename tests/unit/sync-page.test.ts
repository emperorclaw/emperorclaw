import { test } from "node:test";
import assert from "node:assert/strict";
import { SYNC_PAGE_SIZE, selectSyncPage } from "../../src/lib/sync-page";

const SINCE = new Date("2026-10-22T10:00:00.000Z");

function row(id: string, iso: string) {
    return { id, createdAt: new Date(iso) };
}

test("selectSyncPage returns the oldest page after the cursor and flags more", () => {
    const rows = Array.from({ length: SYNC_PAGE_SIZE + 1 }, (_, i) =>
        row(`m${String(i).padStart(3, "0")}`, new Date(SINCE.getTime() + 1000 * (SYNC_PAGE_SIZE + 1 - i)).toISOString()));
    const { page, hasMore, hasNew } = selectSyncPage(rows, { since: SINCE });
    assert.equal(page.length, SYNC_PAGE_SIZE);
    assert.equal(hasMore, true);
    assert.equal(hasNew, true);
    assert.equal(page[0].id, "m100", "oldest first");
    assert.ok(!page.some((r) => r.id === "m000"), "the newest row waits for the next page");
});

test("selectSyncPage: a single page has no more", () => {
    const { page, hasMore } = selectSyncPage([row("a", "2026-10-22T10:00:01Z")], { since: SINCE });
    assert.equal(page.length, 1);
    assert.equal(hasMore, false);
});

test("selectSyncPage: always-included open messages before the cursor are not new", () => {
    const open = row("open", "2026-10-22T09:00:00Z");
    assert.equal(selectSyncPage([open], { since: SINCE }).hasNew, false);
    assert.equal(selectSyncPage([open], { since: SINCE, retryIds: ["open"] }).hasNew, true, "an explicit retry id is new");
    assert.equal(selectSyncPage([open, row("n", "2026-10-22T10:00:05Z")], { since: SINCE }).hasNew, true);
    assert.equal(selectSyncPage([open], { since: null }).hasNew, true, "no cursor: everything is new");
});

test("selectSyncPage: equal timestamps order by id and respect the cursor slack", () => {
    const { page } = selectSyncPage([row("b", "2026-10-22T10:00:01Z"), row("a", "2026-10-22T10:00:01Z")], { since: SINCE });
    assert.deepEqual(page.map((r) => r.id), ["a", "b"]);
    assert.equal(selectSyncPage([row("x", "2026-10-22T09:59:59.995Z")], { since: SINCE }).hasNew, true);
});

test("selectSyncPage: nextSince points at the end of a full page, null otherwise", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(`m${i}`, `2026-10-22T10:00:0${i + 1}.000Z`));
    assert.equal(selectSyncPage(rows, { since: SINCE, limit: 2 }).nextSince, "2026-10-22T10:00:02.000Z");
    assert.equal(selectSyncPage(rows, { since: SINCE, limit: 5 }).nextSince, null);
});

test("selectSyncPage: known rows in the cursor's millisecond do not end the poll, an unseen sibling does", () => {
    const cursorRow = row("running", "2026-10-22T10:00:00.000Z");
    const sibling = row("sibling", "2026-10-22T10:00:00.000Z");
    assert.equal(selectSyncPage([cursorRow], { since: SINCE }).hasNew, true, "old bridges: slack rows count as new");
    assert.equal(selectSyncPage([cursorRow], { since: SINCE, knownIds: ["running"] }).hasNew, false);
    assert.equal(selectSyncPage([cursorRow, sibling], { since: SINCE, knownIds: ["running"] }).hasNew, true,
        "a same-millisecond message the runtime has not seen goes out at once");
});
