import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_ENTER_MAX,
    CHAT_ENTER_STAGGER_MS,
    CHAT_ENTER_WINDOW_MS,
    NO_CHAT_ENTER,
    chatEnterStep,
    nextChatEnter,
} from "../../src/lib/chat-enter";

const rows = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }));

test("a chat's first page is the entrance, once, first rows only", () => {
    const view = "main";
    const staged = nextChatEnter(NO_CHAT_ENTER, view, rows(20), 1_000);
    assert.deepEqual(staged.ids, rows(CHAT_ENTER_MAX).map((row) => row.id));
    assert.equal(staged.view, view);
    assert.equal(staged.at, 1_000);

    // Steps follow the list order, 30 ms apart in CSS.
    rows(CHAT_ENTER_MAX).forEach((row, i) => {
        assert.equal(chatEnterStep(staged, view, row.id, 1_000), i);
    });
    assert.equal(chatEnterStep(staged, view, "m7", 1_000), undefined, "past the cap: no entrance");
    assert.equal(CHAT_ENTER_WINDOW_MS, CHAT_ENTER_STAGGER_MS * (CHAT_ENTER_MAX - 1) + 400);
});

test("a live arrival or a background poll does not restage the list", () => {
    const view = "main";
    const staged = nextChatEnter(NO_CHAT_ENTER, view, rows(3), 1_000);
    const polled = nextChatEnter(staged, view, rows(3), 1_500);
    assert.equal(polled, staged, "same state: nothing new enters");
    const appended = nextChatEnter(staged, view, rows(4), 1_500);
    assert.equal(appended, staged, "a new last message keeps the entrance as it was");
    assert.equal(chatEnterStep(appended, view, "m4", 1_500), undefined);
});

test("an older page loaded above never enters", () => {
    const view = "main";
    const staged = nextChatEnter(NO_CHAT_ENTER, view, rows(3), 1_000);
    const older = nextChatEnter(staged, view, [{ id: "old" }, ...rows(3)], 1_100);
    assert.equal(older, staged);
    assert.equal(chatEnterStep(older, view, "old", 1_100), undefined);
});

test("another chat, or a cleared list, takes its own first page", () => {
    const staged = nextChatEnter(NO_CHAT_ENTER, "main", rows(3), 1_000);
    const other = nextChatEnter(staged, "chat-b", rows(3, "b"), 2_000);
    assert.notEqual(other, staged);
    assert.deepEqual(other.ids, ["b1", "b2", "b3"]);
    assert.equal(chatEnterStep(other, "chat-b", "b1", 2_000), 0);
    assert.equal(chatEnterStep(other, "main", "m1", 2_000), undefined, "the previous chat is over");

    // Switching to a chat empties the list first: the load must be able to stage again.
    const cleared = nextChatEnter(other, "chat-b", [], 2_100);
    assert.deepEqual(cleared.ids, []);
    const loaded = nextChatEnter(cleared, "chat-b", rows(2, "b"), 2_300);
    assert.deepEqual(loaded.ids, ["b1", "b2"]);
    assert.equal(chatEnterStep(loaded, "chat-b", "b1", 2_300), 0);
});

test("the marks expire, so a re-mounted row stays still", () => {
    const staged = nextChatEnter(NO_CHAT_ENTER, "main", rows(2), 1_000);
    assert.equal(chatEnterStep(staged, "main", "m1", 1_000 + CHAT_ENTER_WINDOW_MS - 1), 0);
    assert.equal(chatEnterStep(staged, "main", "m1", 1_000 + CHAT_ENTER_WINDOW_MS), undefined);
});

test("a new chat composer has nothing to stage until its first message exists", () => {
    const empty = nextChatEnter(NO_CHAT_ENTER, "new:client-1", [], 1_000);
    assert.deepEqual(empty.ids, []);
    const created = nextChatEnter(empty, "thread-1", [{ id: "first" }], 1_500);
    assert.deepEqual(created.ids, ["first"]);
    assert.equal(chatEnterStep(created, "thread-1", "first", 1_500), 0);
});
