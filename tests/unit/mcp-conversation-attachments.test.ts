import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_ATTACHMENTS_MAX, messageAttachments, toConversationMessages } from "../../src/lib/mcp-server/tools/conversations";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function row(id: string, text: string, metadataJson: unknown) {
    return {
        id,
        companyId: "c1",
        threadId: "t1",
        senderType: "human",
        senderId: "u1",
        text,
        metadataJson,
        deliveryState: "delivered",
        createdAt: new Date("2026-11-16T10:00:00Z"),
    } as unknown as Parameters<typeof toConversationMessages>[1][number];
}

test("read_thread messages carry the files attached to them", async () => {
    const file = { id: "art-1", name: "report.xlsx", contentType: XLSX, sizeBytes: 43622 };
    // Human senders only: describeSenders needs no database for them.
    const [withFile, plain] = await toConversationMessages("c1", [
        row("m1", "", { senderName: "Jose", attachments: [file] }),
        row("m2", "hi", { senderName: "Jose" }),
    ]);
    assert.deepEqual(withFile.attachments, [file]);
    assert.equal(withFile.text, "", "an attachment-only message keeps its empty text");
    assert.equal(withFile.senderName, "Jose");
    assert.equal("attachments" in plain, false, "no attachments key without files");
});

test("malformed attachment metadata is skipped, missing fields get defaults", () => {
    for (const meta of [null, "x", {}, { attachments: "nope" }, { attachments: { id: "a" } }, { attachments: [null, 3, "a", { name: "no id" }, { id: "  " }] }]) {
        assert.deepEqual(messageAttachments(meta), []);
    }
    assert.deepEqual(messageAttachments({ attachments: [{ id: "a1", sizeBytes: -5 }, { id: "a2", name: " b.csv ", contentType: "text/csv", sizeBytes: Number.NaN }] }), [
        { id: "a1", name: "file", contentType: "application/octet-stream", sizeBytes: 0 },
        { id: "a2", name: "b.csv", contentType: "text/csv", sizeBytes: 0 },
    ]);
});

test("the attachment list is capped", () => {
    const files = Array.from({ length: MESSAGE_ATTACHMENTS_MAX + 5 }, (_, i) => ({ id: `a${i}`, name: `${i}.txt`, contentType: "text/plain", sizeBytes: 1 }));
    assert.equal(messageAttachments({ attachments: files }).length, MESSAGE_ATTACHMENTS_MAX);
});
