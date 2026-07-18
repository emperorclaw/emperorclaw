import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeLogicalPath, sanitizeFilenameSegment } from "../src/lib/storage/path-sanitizer.ts";

test("sanitizeLogicalPath accepts normal nested paths", () => {
    assert.equal(sanitizeLogicalPath("reports/q2/summary.pdf"), "reports/q2/summary.pdf");
    assert.equal(sanitizeLogicalPath("a/b"), "a/b");
});

test("sanitizeLogicalPath collapses redundant slashes and trims segments", () => {
    assert.equal(sanitizeLogicalPath("a//b/"), "a/b");
    assert.equal(sanitizeLogicalPath(" a / b "), "a/b");
});

test("sanitizeLogicalPath rejects parent-directory traversal", () => {
    assert.throws(() => sanitizeLogicalPath("../etc/passwd"));
    assert.throws(() => sanitizeLogicalPath("a/../../b"));
    assert.throws(() => sanitizeLogicalPath("a/./b"));
});

test("sanitizeLogicalPath rejects absolute paths", () => {
    assert.throws(() => sanitizeLogicalPath("/etc/passwd"));
});

test("sanitizeLogicalPath rejects backslash traversal (normalized then caught)", () => {
    assert.throws(() => sanitizeLogicalPath("..\\..\\windows\\system32"));
});

test("sanitizeLogicalPath rejects encoded traversal sequences", () => {
    assert.throws(() => sanitizeLogicalPath("a/%2e%2e/b"));
    assert.throws(() => sanitizeLogicalPath("a%2fb"));
    assert.throws(() => sanitizeLogicalPath("a%5cb"));
});

test("sanitizeLogicalPath rejects null bytes", () => {
    assert.throws(() => sanitizeLogicalPath("a/b\0.png"));
});

test("sanitizeLogicalPath rejects empty input", () => {
    assert.throws(() => sanitizeLogicalPath(""));
    assert.throws(() => sanitizeLogicalPath("///"));
});

test("sanitizeFilenameSegment strips separators and traversal dots", () => {
    // The invariant that matters: the result is a single harmless segment —
    // no path separators, never a bare "." / ".." traversal token.
    const traversal = sanitizeFilenameSegment("../../evil.png");
    assert.ok(!traversal.includes("/") && !traversal.includes("\\"));
    assert.notEqual(traversal, "..");
    assert.ok(!traversal.startsWith("."));
    assert.equal(sanitizeFilenameSegment("a/b\\c.txt"), "a-b-c.txt");
    assert.equal(sanitizeFilenameSegment(".."), "");
    assert.equal(sanitizeFilenameSegment("report.pdf"), "report.pdf");
});
