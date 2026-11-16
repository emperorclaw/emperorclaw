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

const ROLE_NOTES: Record<string, string> = {
    "role-playbook-developer": "role-developer",
    "role-playbook-ops": "role-ops",
    "role-playbook-qa": "role-qa",
    "role-playbook-marketing": "role-marketing",
    "role-playbook-outreach": "role-outreach",
};

test("every starter note stays under the per-note context cap; role playbooks under 4000 chars", () => {
    for (const name of Object.keys(starterNoteHashes())) {
        const text = renderStarterNote(name, "A Fairly Long Company Name Inc")!;
        assert.ok(text.length < 8000, `${name} is ${text.length} chars`);
    }
    for (const name of Object.keys(ROLE_NOTES)) {
        const text = renderStarterNote(name, "Acme")!;
        assert.ok(text.length < 4000, `${name} is ${text.length} chars`);
    }
});

test("v3 role playbooks exist with the team-playbook, role-playbook and role tags", () => {
    assert.ok(STARTER_DOCTRINE_VERSION >= 3);
    for (const [name, roleTag] of Object.entries(ROLE_NOTES)) {
        const text = renderStarterNote(name, "Acme");
        assert.ok(text, `${name} is a starter note`);
        const tags = /^tags: \[(.*)\]$/m.exec(text!)?.[1].split(", ") ?? [];
        for (const tag of ["team-playbook", "role-playbook", roleTag]) {
            assert.ok(tags.includes(tag), `${name} is tagged ${tag}`);
        }
    }
});

test("an unedited v2 copy of the two changed notes is updated, even without stored hashes", () => {
    const v2Rules = renderLegacyStarterNote("agent-operating-rules", 5, "Acme")!;
    const v2Lead = renderLegacyStarterNote("team-playbook-lead", 1, "Acme")!;
    assert.ok(v2Rules && v2Lead);
    assert.notEqual(v2Rules, renderStarterNote("agent-operating-rules", "Acme"));
    assert.notEqual(v2Lead, renderStarterNote("team-playbook-lead", "Acme"));
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [
            { name: "agent-operating-rules", contentText: v2Rules },
            { name: "team-playbook-lead", contentText: v2Lead },
        ],
        storedHashes: {},
    });
    assert.equal(decisions.find((d) => d.name === "agent-operating-rules")?.action, "update");
    assert.equal(decisions.find((d) => d.name === "team-playbook-lead")?.action, "update");
});

test("an unedited v1 copy of the two changed notes is updated, even without stored hashes", () => {
    const v1Rules = renderLegacyStarterNote("agent-operating-rules", 4, "Acme")!;
    const v1Lead = renderLegacyStarterNote("team-playbook-lead", 0, "Acme")!;
    assert.ok(v1Rules && v1Lead);
    assert.notEqual(v1Rules, renderLegacyStarterNote("agent-operating-rules", 5, "Acme"));
    assert.notEqual(v1Lead, renderLegacyStarterNote("team-playbook-lead", 1, "Acme"));
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [
            { name: "agent-operating-rules", contentText: v1Rules },
            { name: "team-playbook-lead", contentText: v1Lead },
        ],
        storedHashes: {},
    });
    assert.equal(decisions.find((d) => d.name === "agent-operating-rules")?.action, "update");
    assert.equal(decisions.find((d) => d.name === "team-playbook-lead")?.action, "update");
});

test("an edited v2 copy is kept and reported as a suggestion", () => {
    const edited = renderLegacyStarterNote("team-playbook-lead", 1, "Acme")! + "\n- Our own lead rule.\n";
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [{ name: "team-playbook-lead", contentText: edited }],
        storedHashes: { "team-playbook-lead": "hash-of-the-v2-text" },
    });
    assert.deepEqual(decisions.find((d) => d.name === "team-playbook-lead"), {
        action: "keep", name: "team-playbook-lead", edited: true,
    });
});

test("a note the company received and deleted is not recreated; a note new in v3 is", () => {
    // Stored hashes as a v2 company has them: every v2 note, no role playbooks.
    const storedHashes = Object.fromEntries(
        Object.entries(starterNoteHashes()).filter(([name]) => !(name in ROLE_NOTES)),
    );
    const decisions = planStarterDoctrineUpgrade({
        companyName: "Acme",
        existingNotes: [{ name: "agent-operating-rules", contentText: renderStarterNote("agent-operating-rules", "Acme")! }],
        storedHashes,
    });
    assert.deepEqual(decisions.find((d) => d.name === "team-template-research"), {
        action: "skip-deleted", name: "team-template-research",
    });
    for (const name of Object.keys(ROLE_NOTES)) {
        assert.equal(decisions.find((d) => d.name === name)?.action, "create", `${name} is created`);
    }
});

test("with no stored hashes every missing note is created", () => {
    const decisions = planStarterDoctrineUpgrade({ companyName: "Acme", existingNotes: [], storedHashes: {} });
    assert.ok(decisions.every((d) => d.action === "create"));
    assert.equal(decisions.length, Object.keys(starterNoteHashes()).length);
});
