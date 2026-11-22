import test from "node:test";
import assert from "node:assert/strict";
import {
    parseImageRef,
    isFloatingImageRef,
    isPinnedReference,
    resolveUpdateTarget,
    describeImageRef,
    updateHttpStatus,
    parseComposeImage,
} from "../../src/lib/update-image";

const DIGEST = "sha256:" + "a".repeat(64);
const REPO = "ghcr.io/emperorclaw/emperorclaw";

test("parseImageRef separates repository, tag and digest", () => {
    assert.deepEqual(parseImageRef(`${REPO}:v0.42.6`), {
        ref: `${REPO}:v0.42.6`,
        repository: REPO,
        tag: "v0.42.6",
        digest: null,
    });
    const pinned = parseImageRef(`${REPO}@${DIGEST}`);
    assert.equal(pinned?.repository, REPO);
    assert.equal(pinned?.tag, null);
    assert.equal(pinned?.digest, DIGEST);
    // `repo:tag@sha256:…` is legal; the digest wins and the tag is a hint only.
    const both = parseImageRef(`${REPO}:v0.42.6@${DIGEST}`);
    assert.equal(both?.tag, "v0.42.6");
    assert.equal(both?.digest, DIGEST);
    assert.equal(parseImageRef("   "), null);
    assert.equal(parseImageRef(undefined), null);
});

test("a registry port is not a tag", () => {
    const parsed = parseImageRef("localhost:5000/emperorclaw");
    assert.equal(parsed?.repository, "localhost:5000/emperorclaw");
    assert.equal(parsed?.tag, null);
});

test("only latest and a missing tag count as floating", () => {
    assert.equal(isFloatingImageRef(`${REPO}:latest`), true);
    assert.equal(isFloatingImageRef(`${REPO}:LATEST`), true);
    assert.equal(isFloatingImageRef(REPO), true);
    assert.equal(isFloatingImageRef(`${REPO}:v0.42.6`), false);
    assert.equal(isFloatingImageRef(`${REPO}@${DIGEST}`), false);
    assert.equal(isFloatingImageRef(null), false);
});

test("isPinnedReference tells a promise from a hope", () => {
    assert.equal(isPinnedReference(`${REPO}@${DIGEST}`), true);
    assert.equal(isPinnedReference(`${REPO}:v0.42.6`), true);
    assert.equal(isPinnedReference(`${REPO}:latest`), false);
    assert.equal(isPinnedReference(REPO), false);
    assert.equal(isPinnedReference(""), false);
});

test("the env var wins, then the compose reference, then the default", () => {
    const base = { composeImage: `${REPO}@${DIGEST}`, runningImage: `${REPO}@${DIGEST}` };
    assert.deepEqual(resolveUpdateTarget({ ...base, envImage: `${REPO}:v0.42.7` }), {
        ok: true,
        ref: `${REPO}:v0.42.7`,
        source: "env",
        floating: false,
    });
    assert.deepEqual(resolveUpdateTarget(base), {
        ok: true,
        ref: `${REPO}@${DIGEST}`,
        source: "compose",
        floating: false,
    });
    assert.deepEqual(resolveUpdateTarget({ defaultImage: `${REPO}:v0.42.6` }), {
        ok: true,
        ref: `${REPO}:v0.42.6`,
        source: "default",
        floating: false,
    });
    // Blank env must not shadow the compose reference.
    assert.equal(resolveUpdateTarget({ ...base, envImage: "   " }).ok, true);
});

test("floating over a pinned container is refused, and says how to fix it", () => {
    const refused = resolveUpdateTarget({
        envImage: `${REPO}:latest`,
        composeImage: `${REPO}@${DIGEST}`,
        runningImage: `${REPO}@${DIGEST}`,
    });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.code, "floating-blocked");
    assert.match(refused.message, /Refusing to promote/);
    assert.match(refused.message, /EMPEROR_UPDATE_IMAGE/);
});

test("an explicit release tag is also a pin", () => {
    const refused = resolveUpdateTarget({
        envImage: REPO, // no tag at all — floating
        runningImage: `${REPO}:v0.42.6`,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "floating-blocked");
});

test("floating over floating still works, so a dev box can keep using latest", () => {
    const allowed = resolveUpdateTarget({
        envImage: `${REPO}:latest`,
        composeImage: `${REPO}:latest`,
        runningImage: `${REPO}:latest`,
    });
    assert.equal(allowed.ok, true);
    if (allowed.ok) assert.equal(allowed.floating, true);
});

test("no reference at all is its own error, not a silent default", () => {
    const none = resolveUpdateTarget({});
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.code, "no-target");
});

test("describeImageRef keeps digests short and distinguishable", () => {
    const one = describeImageRef(`${REPO}@${DIGEST}`);
    const two = describeImageRef(`${REPO}@sha256:` + "b".repeat(64));
    assert.match(one, /^ghcr\.io\/emperorclaw\/emperorclaw@sha256:aaaaaaaaaaaa…$/);
    assert.notEqual(one, two);
    assert.equal(describeImageRef(`${REPO}:v0.42.6`), `${REPO}:v0.42.6`);
    assert.equal(describeImageRef(""), "(none)");
});

test("a refusal is a 409, an error is a 500, a clean run is a 200", () => {
    const ok = [{ step: "resolve-image", status: "ok" }];
    assert.equal(updateHttpStatus({ refused: false, steps: ok }), 200);
    assert.equal(updateHttpStatus({ refused: true, steps: ok }), 409);
    assert.equal(updateHttpStatus({ refused: true, steps: [{ step: "resolve-image", status: "error" }] }), 409);
    assert.equal(updateHttpStatus({ refused: false, steps: [{ step: "pull-image", status: "error" }] }), 500);
    assert.equal(updateHttpStatus({ refused: false, steps: [] }), 200);
});

test("parseComposeImage reads the service image and prefers our repository", () => {
    const yaml = [
        "services:",
        "  app:",
        "    image: ghcr.io/emperorclaw/emperorclaw@sha256:" + "c".repeat(64),
        "    ports:",
        '      - "3000:3000"',
        "  db:",
        "    image: postgres:17-alpine",
    ].join("\n");
    assert.equal(
        parseComposeImage(yaml, REPO),
        `ghcr.io/emperorclaw/emperorclaw@sha256:${"c".repeat(64)}`,
    );
    // Without a repository hint the first service image wins.
    assert.equal(parseComposeImage(yaml), `ghcr.io/emperorclaw/emperorclaw@sha256:${"c".repeat(64)}`);
    // A compose file that only knows about other images is not a source for us.
    assert.equal(parseComposeImage("services:\n  db:\n    image: postgres:17-alpine\n", REPO), null);
    assert.equal(parseComposeImage("services: {}\n", REPO), null);
    assert.equal(parseComposeImage(null, REPO), null);
});

test("the compose file outranks the reference the container was created from", () => {
    const pinnedFile = `${REPO}@${DIGEST}`;
    const resolved = resolveUpdateTarget({
        composeFileImage: `${REPO}:v0.42.7`,
        composeImage: pinnedFile,
        runningImage: pinnedFile,
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
        assert.equal(resolved.ref, `${REPO}:v0.42.7`);
        assert.equal(resolved.source, "compose-file");
    }
    // The env var still wins over the file.
    const withEnv = resolveUpdateTarget({
        envImage: `${REPO}@${DIGEST}`,
        composeFileImage: `${REPO}:v0.42.7`,
        runningImage: pinnedFile,
    });
    assert.equal(withEnv.ok && withEnv.source, "env");
});
