import { test } from "node:test";
import assert from "node:assert/strict";
import {
    LEGACY_STARTER_HASHES,
    planStarterDoctrineUpgrade,
    renderLegacyStarterNote,
    renderStarterNote,
    STARTER_DOCTRINE_VERSION,
    starterNoteHashes,
} from "../../src/lib/starter-knowledge";

test("STARTER_DOCTRINE_VERSION is a positive integer", () => {
    assert.equal(Number.isInteger(STARTER_DOCTRINE_VERSION), true);
    assert.ok((STARTER_DOCTRINE_VERSION as number) >= 1);
});

test("starterNoteHashes covers every starter note, is deterministic and name-independent", () => {
    const first = starterNoteHashes();
    const second = starterNoteHashes();
    assert.deepEqual(first, second);
    assert.ok(Object.keys(first).length >= 5);
    assert.ok(Object.keys(first).includes("agent-operating-rules"));
    assert.ok(Object.keys(first).includes("team-playbook-lead"));
});

test("a missing note is created", () => {
    const decisions = planStarterDoctrineUpgrade({ companyName: "Acme", existingNotes: [], storedHashes: {} });
    const created = decisions.filter((d) => d.action === "create");
    assert.equal(created.length, decisions.length);
    assert.ok(created.some((d) => d.name === "agent-operating-rules"));
});

test("W1: a company seeded with the old HEAD text (unedited) gets updated", () => {
    const oldHead = renderLegacyStarterNote("agent-operating-rules", 3, "Acme")!;
    assert.ok(oldHead, "legacy renderer returns the old HEAD text");
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [{ name: "agent-operating-rules", contentText: oldHead }],
        storedHashes: {},
    });
    const rule = decisions.find((d) => d.name === "agent-operating-rules");
    assert.equal(rule?.action, "update");
});

test("W1: an edited note is kept and reported as a suggestion", () => {
    const oldHead = renderLegacyStarterNote("agent-operating-rules", 3, "Acme")!;
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [{ name: "agent-operating-rules", contentText: oldHead + "\n- Our own custom rule.\n" }],
        storedHashes: {},
    });
    const rule = decisions.find((d) => d.name === "agent-operating-rules");
    assert.equal(rule?.action, "keep");
    assert.equal((rule as { edited?: boolean }).edited, true);
});

test("W1: legacy hashes are name-independent and cover every historical variant", () => {
    const legacy = LEGACY_STARTER_HASHES["agent-operating-rules"];
    assert.ok(legacy && legacy.size >= 4);
    // The agent-operating-rules note interpolates no company name, so every
    // historical variant renders identically for any company name.
    assert.equal(renderLegacyStarterNote("agent-operating-rules", 3, "Acme"), renderLegacyStarterNote("agent-operating-rules", 3, "Other Co"));
});

test("W1: a renamed company's unedited note is still recognised via the stored name", () => {
    const seeded = renderStarterNote("company-overview", "Old Name")!;
    const hashes = starterNoteHashes();
    const decisions = planStarterDoctrineUpgrade({
        companyName: "New Name",
        existingNotes: [{ name: "company-overview", contentText: seeded }],
        storedHashes: { "company-overview": hashes["company-overview"] },
        storedName: "Old Name",
    });
    const overview = decisions.find((d) => d.name === "company-overview");
    // company-overview is unchanged since seed: no update and no suggestion.
    assert.equal(overview?.action, "keep");
    assert.equal((overview as { edited?: boolean }).edited, false);
});

test("an already-current note is kept without a suggestion", () => {
    const current = renderStarterNote("agent-operating-rules", "Acme")!;
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [{ name: "agent-operating-rules", contentText: current }],
        storedHashes: {},
    });
    const rule = decisions.find((d) => d.name === "agent-operating-rules");
    assert.equal(rule?.action, "keep");
    assert.equal((rule as { edited?: boolean }).edited, false);
});


test("workspace filing guidance is added without replacing a company's customized note", () => {
    const customized = "# Our storage policy\nKeep approved invoices in the existing finance folders.";
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [{ name: "workspace-filing-guide", contentText: customized }],
        storedHashes: {},
    });
    assert.deepEqual(decisions.find((item) => item.name === "workspace-filing-guide"), {
        action: "keep", name: "workspace-filing-guide", edited: true,
    });
    const missing = planStarterDoctrineUpgrade({ companyName: "Acme", existingNotes: [], storedHashes: {} });
    assert.deepEqual(missing.find((item) => item.name === "workspace-filing-guide"), {
        action: "create", name: "workspace-filing-guide",
    });
});
