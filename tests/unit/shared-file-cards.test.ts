import test from "node:test";
import assert from "node:assert/strict";
import { parseEntityUrl, parseEntityKey, canViewSharedArtifact, CHAT_IMAGE_TYPES } from "../../src/lib/emperor-entities";

const id = "12345678-1234-1234-1234-123456789abc";
test("Knowledge and Storage references accept only real record URL shapes", () => {
    assert.deepEqual(parseEntityUrl(`emperor://knowledge/${id}`), { kind: "knowledge", id });
    assert.deepEqual(parseEntityUrl(`emperor://artifact/${id}`), { kind: "artifact", id });
    assert.deepEqual(parseEntityKey(`artifact:${id}`), { kind: "artifact", id });
    for (const url of [`emperor://artifact/${id}?url=https://evil.test`, "emperor://knowledge/nope", "file:///tmp/photo.png", `https://evil.test/artifact/${id}`]) {
        assert.equal(parseEntityUrl(url), null);
    }
});
test("private human uploads remain restricted while agent outputs are company-visible", () => {
    const file = { visibility: "private", createdByType: "human", createdById: "owner" };
    assert.equal(canViewSharedArtifact(file, "other"), false);
    assert.equal(canViewSharedArtifact(file, null), false);
    assert.equal(canViewSharedArtifact(file, "owner"), true);
    assert.equal(canViewSharedArtifact({ ...file, createdByType: "agent" }, "other"), true);
    assert.equal(canViewSharedArtifact({ ...file, visibility: "company" }, "other"), true);
});
test("image cards allow raster previews and exclude active content", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(CHAT_IMAGE_TYPES.has(type), true);
    for (const type of ["image/svg+xml", "text/html", "application/pdf"]) assert.equal(CHAT_IMAGE_TYPES.has(type), false);
});
