import { test } from "node:test";
import assert from "node:assert/strict";
import { GO_CHORDS, isPlainKey, isTypingTarget, matchesQuery } from "../../src/lib/keyboard-shortcuts";

const el = (tagName: string, attrs: Record<string, string> = {}, extra: { isContentEditable?: boolean; insideEditable?: boolean } = {}) => ({
    tagName,
    isContentEditable: extra.isContentEditable ?? false,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => (extra.insideEditable && selector.includes("contenteditable") ? {} : null),
});

test("shortcuts are suppressed while typing", () => {
    assert.equal(isTypingTarget(el("TEXTAREA")), true);
    assert.equal(isTypingTarget(el("SELECT")), true);
    assert.equal(isTypingTarget(el("INPUT")), true, "an input without a type is text");
    assert.equal(isTypingTarget(el("input", { type: "search" })), true);
    assert.equal(isTypingTarget(el("DIV", {}, { isContentEditable: true })), true);
    assert.equal(isTypingTarget(el("DIV", { contenteditable: "true" })), true);
    assert.equal(isTypingTarget(el("DIV", { role: "textbox" })), true);
    assert.equal(isTypingTarget(el("SPAN", {}, { insideEditable: true })), true, "inner node of a rich editor");
});

test("shortcuts work on buttons, links, checkboxes and the page", () => {
    assert.equal(isTypingTarget(el("BUTTON")), false);
    assert.equal(isTypingTarget(el("A")), false);
    assert.equal(isTypingTarget(el("INPUT", { type: "checkbox" })), false);
    assert.equal(isTypingTarget(el("DIV", { contenteditable: "false" })), false);
    assert.equal(isTypingTarget(el("BODY")), false);
    assert.equal(isTypingTarget(null), false);
});

test("modifier combinations are never single-key shortcuts", () => {
    assert.equal(isPlainKey({ ctrlKey: false, metaKey: false, altKey: false }), true);
    assert.equal(isPlainKey({ ctrlKey: true, metaKey: false, altKey: false }), false);
    assert.equal(isPlainKey({ ctrlKey: false, metaKey: true, altKey: false }), false);
    assert.equal(isPlainKey({ ctrlKey: false, metaKey: false, altKey: true }), false);
});

test("g-chords cover home, inbox, messages, projects and agents", () => {
    assert.deepEqual(Object.fromEntries(Object.entries(GO_CHORDS).map(([k, v]) => [k, v.href])), { h: "/", i: "/inbox", m: "/messages", p: "/projects", a: "/agents" });
});

test("palette matching: every word, any order, case and accents ignored", () => {
    assert.ok(matchesQuery("Website relaunch for Bodega Ñandú", "nandu web"));
    assert.ok(matchesQuery("Knowledge base", "KNOW"));
    assert.ok(!matchesQuery("Knowledge base", "know files"));
    assert.ok(matchesQuery("Anything", "   "));
});
