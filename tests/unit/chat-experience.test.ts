import test from "node:test";
import assert from "node:assert/strict";
import { createComposerStore } from "../../src/lib/chat/composer-store";
import { responseSnapshotSchema, mayReplaceSnapshot } from "../../src/lib/chat/response-contract";
import { randomUUID } from "node:crypto";

test("composer exposes the latest text synchronously without changing the empty snapshot on every key", () => {
    const editor = createComposerStore();
    const states: boolean[] = [];
    const unsubscribe = editor.subscribe(() => states.push(editor.hasText()));
    editor.set("a"); editor.set("ab"); editor.set(previous => `${previous}c`);
    assert.equal(editor.get(), "abc");
    assert.deepEqual(states, [true, true, true]);
    editor.set(""); assert.equal(editor.hasText(), false);
    unsubscribe(); editor.set("restored"); assert.equal(states.length, 4);
});

test("response snapshots enforce byte caps, stable identity, revision and bounded segments", () => {
    const valid = { responseId: randomUUID(), revision: 1, segmentIndex: 0, text: "Hello", state: "streaming" };
    assert.equal(responseSnapshotSchema.safeParse(valid).success, true);
    for (const changes of [{ text: "🦊".repeat(40_000) }, { segmentIndex: 32 }, { revision: 0 }, { responseId: "x" }, { state: "anything" }, { extra: "no" }])
        assert.equal(responseSnapshotSchema.safeParse({ ...valid, ...changes }).success, false);
});

test("late or duplicate snapshots cannot regress a sealed response", () => {
    assert.equal(mayReplaceSnapshot({ revision: 2, state: "streaming" }, { revision: 1, state: "streaming" }), false);
    assert.equal(mayReplaceSnapshot({ revision: 2, state: "streaming" }, { revision: 3, state: "completed" }), true);
    assert.equal(mayReplaceSnapshot({ revision: 2, state: "completed" }, { revision: 3, state: "streaming" }), false);
});

import { streamBlocks } from "../../src/lib/chat/stream-blocks";
test("completed stream blocks stay stable and code fences are never split at empty lines", () => {
    const prefix = "A completed paragraph.\n\n";
    assert.equal(streamBlocks(prefix + "tail")[0], streamBlocks(prefix + "tail grows")[0]);
    assert.equal(streamBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nlast").length, 2);
    assert.ok(streamBlocks("p\n\n".repeat(1000)).length <= 256);
});

import { withResponsePreviews, chatRowKey, rememberHumanMessageKey } from "../../src/lib/chat/use-chat-responses";
import type { ChatPreview } from "../../src/lib/chat/response-contract";
test("saved replies win over their preview while optimistic acknowledgements retain a row key", () => {
    const preview: ChatPreview = { responseId: randomUUID(), runId: randomUUID(), agentId: randomUUID(), agentName: "Agent", segmentIndex: 0,
        revision: 1, state: "streaming", text: "Partial", runStatus: "running", updatedAt: new Date().toISOString(), finalMessageId: null };
    const make = (row: ChatPreview) => ({ id: row.responseId, senderType: "agent", createdAt: row.updatedAt, text: row.text });
    assert.equal(withResponsePreviews([], [preview], make).length, 1);
    const final = { id: randomUUID(), senderType: "agent", createdAt: preview.updatedAt, text: "Authoritative final" };
    const completed = { ...preview, finalMessageId: final.id };
    assert.deepEqual(withResponsePreviews([final], [completed], make), [final]);
    assert.equal(chatRowKey(final, [completed]), preview.responseId);
    const clientId = randomUUID(); rememberHumanMessageKey(final.id, clientId);
    assert.equal(chatRowKey(final, []), clientId);
});

import { newClientMessageId } from "../../src/lib/chat/client-message-id";
test("request identities work when HTTP browsers do not expose randomUUID", () => {
    assert.equal(newClientMessageId({ getRandomValues: bytes => { bytes.fill(0); return bytes; } }), "00000000-0000-4000-8000-000000000000");
    const values = Array.from({ length: 100 }, () => newClientMessageId({}));
    assert.equal(new Set(values).size, 100);
    assert.ok(values.every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)));
});
