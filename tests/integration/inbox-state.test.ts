import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

/**
 * Per-person inbox state (src/lib/inbox-state.ts): read and archive belong to
 * one person in one company, only items that person can see can be changed,
 * and an archived item comes back when it changes.
 */
maybe("inbox state: per person, visible items only, resurfaces on change, read-all and badge counts", async () => {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const { buildAttention } = await import("@/lib/attention");
    const { markAllInboxRead, setInboxItemState } = await import("@/lib/inbox-state");
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);

    const { companyId, userId: aliceId } = await seedCompanyWithToken();
    const { companyId: otherCompanyId } = await seedCompanyWithToken();
    const [bob] = await db.insert(s.users).values({ email: `bob-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Bob" }).returning();
    await db.insert(s.companyMembers).values([
        { companyId, userId: aliceId, role: "owner" },
        { companyId, userId: bob.id, role: "admin" },
        // Alice also belongs to another company.
        { companyId: otherCompanyId, userId: aliceId, role: "owner" },
    ]);
    const alice = { userId: aliceId, isOwnerOrAdmin: true, canAct: true, scope: null };
    const bobAccess = { userId: bob.id, isOwnerOrAdmin: true, canAct: true, scope: null };

    const ox = await seedAgent(companyId, { name: "Ox", lastSeenAt: ago(120) });
    const [project] = await db.insert(s.projects).values({ companyId, goal: "Ops", status: "active" }).returning();
    const [otherProject] = await db.insert(s.projects).values({ companyId: otherCompanyId, goal: "Other ops", status: "active" }).returning();
    const [, blocked, otherBlocked] = await db.insert(s.tasks).values([
        // Ox holds work while offline: an "agent" item.
        { companyId, projectId: project.id, taskType: "ops", state: "in_progress", assignedAgentId: ox.id, inputJson: { title: "Nightly backup" } },
        { companyId, projectId: project.id, taskType: "ops", state: "blocked", inputJson: { title: "Rotate keys" }, updatedAt: ago(30) },
        { companyId: otherCompanyId, projectId: otherProject.id, taskType: "ops", state: "blocked", inputJson: { title: "Other company keys" }, updatedAt: ago(30) },
    ]).returning();
    // A mention for Alice only.
    const [mention] = await db.insert(s.notifications).values({ companyId, userId: aliceId, kind: "mention", title: "Ox mentioned you", link: "/messages", dedupeKey: `m:${randomUUID()}` }).returning();

    const agentKey = `agent:${ox.id}`;
    const blockedKey = `task:${blocked.id}`;
    const mentionKey = `notification:${mention.id}`;
    const otherKey = `task:${otherBlocked.id}`;

    const first = await buildAttention(companyId, alice);
    assert.ok(first.entries.some((e) => e.id === agentKey), "the offline agent is listed");
    assert.ok(first.entries.some((e) => e.id === blockedKey), "the blocked task is listed");
    assert.ok(first.entries.every((e) => e.read === false && e.archived === false && typeof e.fingerprint === "string"), "fresh: unread, not archived, fingerprinted");
    assert.equal(first.counts.unread, first.counts.needsYou, "badge: every needs-you item is unread");
    assert.equal(first.counts.unread, 2);

    // Alice archives the agent item and reads the blocked task.
    const archived = await setInboxItemState(companyId, alice, { action: "archive", items: [{ key: agentKey, fingerprint: null }] });
    assert.deepEqual(archived, { updated: [agentKey], skipped: [] });
    await setInboxItemState(companyId, alice, { action: "read", items: [{ key: blockedKey, fingerprint: null }] });

    const aliceAfter = await buildAttention(companyId, alice);
    assert.ok(!aliceAfter.entries.some((e) => e.id === agentKey), "archived: gone from Alice's inbox");
    assert.deepEqual(aliceAfter.archived.map((e) => e.id), [agentKey], "and listed under Archived");
    assert.equal(aliceAfter.entries.find((e) => e.id === blockedKey)?.read, true);
    assert.equal(aliceAfter.counts.needsYou, 1, "archived items never count");
    assert.equal(aliceAfter.counts.unread, 0, "badge: nothing unread left");

    // Bob's inbox is his own.
    const bobView = await buildAttention(companyId, bobAccess);
    assert.ok(bobView.entries.some((e) => e.id === agentKey && !e.archived), "Bob still sees what Alice archived");
    assert.equal(bobView.entries.find((e) => e.id === blockedKey)?.read, false, "and it is unread for him");
    assert.equal(bobView.counts.unread, 2);
    assert.ok(!bobView.entries.some((e) => e.id === mentionKey), "Alice's mention is hers alone");

    // Items you cannot see are skipped and never stored.
    const sneaky = await setInboxItemState(companyId, bobAccess, { action: "archive", items: [{ key: mentionKey, fingerprint: null }, { key: otherKey, fingerprint: null }, { key: "agent:not-real", fingerprint: null }, { key: blockedKey, fingerprint: null }] });
    assert.deepEqual(sneaky.updated, [blockedKey]);
    assert.deepEqual(sneaky.skipped.sort(), [mentionKey, otherKey, "agent:not-real"].sort());
    const bobRows = await db.select().from(s.inboxItemState).where(eq(s.inboxItemState.userId, bob.id));
    assert.deepEqual(bobRows.map((r) => r.itemKey), [blockedKey], "only the visible item has a row");
    const noViewer = await setInboxItemState(companyId, { userId: null, isOwnerOrAdmin: false, canAct: false, scope: { agentIds: [], customerIds: [] } }, { action: "read", items: [{ key: blockedKey, fingerprint: null }] });
    assert.deepEqual(noViewer, { updated: [], skipped: [blockedKey] }, "no signed-in viewer: nothing");

    // A restricted member scoped away from Ox cannot touch Ox's item.
    const scoped = { userId: bob.id, isOwnerOrAdmin: false, canAct: true, scope: { agentIds: [], customerIds: [] } };
    const outOfScope = await setInboxItemState(companyId, scoped, { action: "read", items: [{ key: agentKey, fingerprint: null }] });
    assert.deepEqual(outOfScope.skipped, [agentKey]);

    // Cross-company: Alice's state in one company never applies in the other.
    const crossCompany = await setInboxItemState(otherCompanyId, alice, { action: "archive", items: [{ key: blockedKey, fingerprint: null }] });
    assert.deepEqual(crossCompany.skipped, [blockedKey], "a key from another company is not visible there");
    await setInboxItemState(otherCompanyId, alice, { action: "read", items: [{ key: otherKey, fingerprint: null }] });
    const aliceOther = await buildAttention(otherCompanyId, alice);
    assert.equal(aliceOther.entries.find((e) => e.id === otherKey)?.read, true);
    assert.equal(aliceOther.archived.length, 0, "the agent archive in the first company does not leak");
    const aliceRows = await db.select().from(s.inboxItemState).where(and(eq(s.inboxItemState.userId, aliceId), eq(s.inboxItemState.companyId, otherCompanyId)));
    assert.deepEqual(aliceRows.map((r) => r.itemKey), [otherKey]);

    // A stale client fingerprint: the item changed after Alice looked, so it stays unread.
    await setInboxItemState(companyId, alice, { action: "unread", items: [{ key: blockedKey, fingerprint: null }] });
    await setInboxItemState(companyId, alice, { action: "read", items: [{ key: blockedKey, fingerprint: "00000000" }] });
    assert.equal((await buildAttention(companyId, alice)).entries.find((e) => e.id === blockedKey)?.read, false);

    // Ox reconnects and drops offline again: the archived item resurfaces, unread.
    await db.update(s.agents).set({ lastSeenAt: ago(60) }).where(eq(s.agents.id, ox.id));
    const resurfaced = await buildAttention(companyId, alice);
    const back = resurfaced.entries.find((e) => e.id === agentKey);
    assert.ok(back, "a new offline spell brings it back");
    assert.equal(back!.read, false);
    assert.equal(resurfaced.archived.length, 0);
    // A blocked task that changes resurfaces too.
    await setInboxItemState(companyId, alice, { action: "archive", items: [{ key: blockedKey, fingerprint: null }] });
    assert.ok(!(await buildAttention(companyId, alice)).entries.some((e) => e.id === blockedKey));
    await db.update(s.tasks).set({ updatedAt: ago(5) }).where(eq(s.tasks.id, blocked.id));
    assert.ok((await buildAttention(companyId, alice)).entries.some((e) => e.id === blockedKey && !e.archived), "updated task: back in the inbox");

    // Unarchive puts an archived item straight back.
    await setInboxItemState(companyId, alice, { action: "archive", items: [{ key: agentKey, fingerprint: null }] });
    await setInboxItemState(companyId, alice, { action: "unarchive", items: [{ key: agentKey, fingerprint: null }] });
    assert.ok((await buildAttention(companyId, alice)).entries.some((e) => e.id === agentKey), "unarchived");

    // Read-all: every listed item, Alice only.
    const readAll = await markAllInboxRead(companyId, alice);
    assert.equal(readAll.updated, 2, "the changed task and the mention (archiving already read the agent item)");
    const allRead = await buildAttention(companyId, alice);
    assert.ok(allRead.entries.every((e) => e.read), "everything read");
    assert.equal(allRead.counts.unread, 0, "badge: zero");
    assert.ok(allRead.counts.needsYou > 0, "the items are still listed");
    assert.equal((await markAllInboxRead(companyId, alice)).updated, 0, "nothing left to read");
    assert.equal((await buildAttention(companyId, bobAccess)).counts.unread, 2, "Bob's badge is his own: nothing read, and his archived task came back when it changed");
});
