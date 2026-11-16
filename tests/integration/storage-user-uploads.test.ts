/**
 * Chat uploads land in the uploader's own folder (uploads/<userId>) as private
 * files, and "private" holds on every Storage surface (lib/artifact-visibility.ts):
 * - people: the uploader and owners/admins see the file and the folder; another
 *   member does not (list, folder contents, search, download, read, PATCH);
 * - agents: the agent the file was sent to can list and download it; another
 *   agent (outside that private chat) and an operator token naming no agent
 *   cannot, and no agent may delete it;
 * - a chat message cannot re-share a file its sender cannot open.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const storageDir = mkdtempSync(path.join(tmpdir(), "ec-user-uploads-"));
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = storageDir;
test.after(() => rmSync(storageDir, { recursive: true, force: true }));

type Person = { userId: string; sessionId: string };

async function world() {
    await resetDb();
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId } = await seedCompanyWithToken();
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const uploader = await seedHuman(companyId, "member");
    const colleague = await seedHuman(companyId, "member");
    const admin = await seedHuman(companyId, "admin");
    const scout = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    const builder = await seedAgent(companyId, { name: "Builder", provider: "hermes" });
    return {
        companyId, uploader, colleague, admin, scout, builder,
        scoutToken: await seedMcpToken(companyId, scout.id),
        builderToken: await seedMcpToken(companyId, builder.id),
        operatorToken: await seedMcpToken(companyId, null),
    };
}

async function upload(person: Person, name: string, body: string) {
    const { POST } = await import("@/app/api/chat/attachments/route");
    actAs(person);
    const form = new FormData();
    form.append("file", new File([body], name, { type: "text/plain" }));
    const res = await POST(new NextRequest(new Request("http://localhost/api/chat/attachments", { method: "POST", body: form })));
    const json = await res.json() as { id: string; name: string; contentType: string; sizeBytes: number; url: string };
    return { status: res.status, json };
}

async function send(person: Person, agentId: string, text: string, attachments: string[]) {
    const { POST } = await import("@/app/api/chat/route");
    actAs(person);
    return call(POST, "/api/chat", { method: "POST", body: { text, targetAgentId: agentId, attachments } });
}

async function messagesWith(companyId: string, text: string) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    return db.select().from(threadMessages).where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.text, text)));
}

async function uiList(person: Person) {
    const { GET } = await import("@/app/api/ui/artifacts/route");
    actAs(person);
    const res = await call(GET as never, "/api/ui/artifacts?limit=500");
    assert.equal(res.status, 200, res.text);
    return new Set((res.json.artifacts as { id: string }[]).map((a) => a.id));
}

async function folderContents(person: Person, folderId: string | null) {
    const { GET } = await import("@/app/api/ui/folders/contents/route");
    actAs(person);
    return call(GET as never, `/api/ui/folders/contents${folderId ? `?folderId=${folderId}` : ""}`);
}

async function searchIds(person: Person, q: string) {
    const { GET } = await import("@/app/api/search/route");
    actAs(person);
    const res = await call(GET as never, `/api/search?q=${encodeURIComponent(q)}&limit=50`);
    assert.equal(res.status, 200, res.text);
    return new Set((res.json.results as { id: string }[]).map((r) => r.id));
}

async function uiDownload(person: Person, id: string) {
    const { GET } = await import("@/app/api/ui/artifacts/[id]/download/route");
    actAs(person);
    return call(GET as never, `/api/ui/artifacts/${id}/download`, { params: { id } });
}

async function mcpDownload(token: string, id: string, agentId?: string) {
    const { GET } = await import("@/app/api/mcp/artifacts/[id]/download/route");
    return call(GET as never, `/api/mcp/artifacts/${id}/download${agentId ? `?agentId=${agentId}` : ""}`, { headers: bearer(token), params: { id } });
}

async function mcpList(token: string) {
    const { GET } = await import("@/app/api/mcp/artifacts/route");
    const res = await call(GET as never, "/api/mcp/artifacts?limit=500", { headers: bearer(token) });
    assert.equal(res.status, 200, res.text);
    return new Set((res.json.artifacts as { id: string }[]).map((a) => a.id));
}

maybe("a chat upload is stored privately in the uploader's own folder, inside the shared uploads root", async () => {
    const w = await world();
    const first = await upload(w.uploader, "quarterlyzebra.txt", "quarterly zebra numbers");
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.name, "quarterlyzebra.txt");

    const db = await getDb();
    const { artifacts, artifactFolders } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, first.json.id));
    assert.equal(row.visibility, "private");
    assert.equal(row.createdByType, "human");
    assert.equal(row.createdById, w.uploader.userId);
    assert.equal(row.sourceKind, "chat-attachment");
    assert.ok(row.path?.startsWith(`uploads/${w.uploader.userId}/`), row.path ?? "no path");
    const [folder] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, row.folderId!));
    assert.equal(folder.kind, "user_uploads");
    assert.equal(folder.ownerUserId, w.uploader.userId);
    assert.equal(folder.path, `uploads/${w.uploader.userId}`);
    const [root] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, folder.parentFolderId!));
    assert.equal(root.kind, "uploads_root");
    assert.equal(root.path, "uploads");

    // Concurrent first uploads by another person still yield one folder each.
    const results = await Promise.all([upload(w.colleague, "a.txt", "a"), upload(w.colleague, "b.txt", "b")]);
    for (const result of results) assert.equal(result.status, 201);
    const folders = await db.select().from(artifactFolders).where(eq(artifactFolders.ownerUserId, w.colleague.userId));
    assert.equal(folders.length, 1, "one uploads folder per person");
    const roots = await db.select().from(artifactFolders).where(eq(artifactFolders.kind, "uploads_root"));
    assert.equal(roots.length, 1, "one shared uploads root");
});

maybe("people: the uploader and admins see a private upload; another member does not, anywhere", async () => {
    const w = await world();
    const { json: file } = await upload(w.uploader, "quarterlyzebra.txt", "quarterly zebra numbers");

    // Lists
    assert.ok((await uiList(w.uploader)).has(file.id));
    assert.ok((await uiList(w.admin)).has(file.id));
    assert.ok(!(await uiList(w.colleague)).has(file.id), "member list leaked a private upload");

    // Folder contents: the person's folder is hidden from other members.
    const db = await getDb();
    const { artifacts } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    const mine = await folderContents(w.uploader, row.folderId!);
    assert.equal(mine.status, 200, mine.text);
    assert.ok((mine.json.artifacts as { id: string }[]).some((a) => a.id === file.id));
    assert.equal((await folderContents(w.colleague, row.folderId!)).status, 404, "another person's uploads folder must read as missing");
    const adminView = await folderContents(w.admin, row.folderId!);
    assert.equal(adminView.status, 200);
    const rootId = (mine.json.ancestors as { id: string }[])[0].id;
    const rootForColleague = await folderContents(w.colleague, rootId);
    assert.equal(rootForColleague.status, 200);
    assert.ok(!(rootForColleague.json.folders as { id: string }[]).some((f) => f.id === row.folderId), "uploads root listed another person's folder");
    assert.ok((await folderContents(w.admin, rootId)).json.folders.some((f: { id: string }) => f.id === row.folderId));

    // Global search
    assert.ok((await searchIds(w.uploader, "quarterlyzebra")).has(file.id));
    assert.ok((await searchIds(w.admin, "quarterlyzebra")).has(file.id));
    assert.ok(!(await searchIds(w.colleague, "quarterlyzebra")).has(file.id), "search leaked a private upload");

    // Download and read
    assert.equal((await uiDownload(w.uploader, file.id)).status, 200);
    assert.equal((await uiDownload(w.admin, file.id)).status, 200);
    assert.equal((await uiDownload(w.colleague, file.id)).status, 404);
    const recordRoute = await import("@/app/api/ui/artifacts/[id]/route");
    actAs(w.colleague);
    assert.equal((await call(recordRoute.GET as never, `/api/ui/artifacts/${file.id}`, { params: { id: file.id } })).status, 404);

    // Changes: another member cannot make it company-visible, move or delete it.
    actAs(w.colleague);
    const patch = await call(recordRoute.PATCH as never, `/api/ui/artifacts/${file.id}`, { method: "PATCH", body: { visibility: "company" }, params: { id: file.id } });
    assert.equal(patch.status, 404);
    const deleteRoute = await import("@/app/api/ui/artifacts/[id]/delete/route");
    actAs(w.colleague);
    assert.equal((await call(deleteRoute.DELETE as never, `/api/ui/artifacts/${file.id}/delete`, { method: "DELETE", params: { id: file.id } })).status, 404);
    const [still] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    assert.equal(still.visibility, "private");
    assert.equal(still.deletedAt, null);

    // Uploading into another person's folder reads as missing.
    const folderRoute = await import("@/app/api/ui/folders/route");
    actAs(w.colleague);
    const sub = await call(folderRoute.POST as never, "/api/ui/folders", { method: "POST", body: { name: "sneaky", parentFolderId: row.folderId } });
    assert.equal(sub.status, 404);
    actAs(null);
});

maybe("chat: a message cannot carry a file its sender cannot open", async () => {
    const w = await world();
    const { json: file } = await upload(w.uploader, "secret.txt", "secret");
    const reshared = await send(w.colleague, w.scout.id, "look at this", [file.id]);
    assert.ok(reshared.status < 300, reshared.text);
    const [message] = await messagesWith(w.companyId, "look at this");
    const attachments = (message.metadataJson as { attachments?: unknown[] }).attachments ?? [];
    assert.equal(attachments.length, 0, "another person's private upload must not be attached");

    const own = await send(w.uploader, w.scout.id, "here is my file", [file.id]);
    assert.ok(own.status < 300, own.text);
    const [mine] = await messagesWith(w.companyId, "here is my file");
    assert.deepEqual(((mine.metadataJson as { attachments: { id: string }[] }).attachments).map((a) => a.id), [file.id]);
    actAs(null);
});

maybe("agents: the addressed agent reads the attachment; another agent and an agentless operator token do not", async () => {
    const w = await world();
    const { json: file } = await upload(w.uploader, "brief.txt", "brief for scout");
    const { json: unsent } = await upload(w.uploader, "draft.txt", "not sent yet");
    const sent = await send(w.uploader, w.scout.id, "please read the brief", [file.id]);
    assert.ok(sent.status < 300, sent.text);
    actAs(null);

    // The private chat's agent: download and list.
    const scoutDownload = await mcpDownload(w.scoutToken, file.id);
    assert.equal(scoutDownload.status, 200, scoutDownload.text);
    assert.equal(scoutDownload.text, "brief for scout");
    assert.ok((await mcpList(w.scoutToken)).has(file.id));
    assert.equal((await mcpDownload(w.scoutToken, unsent.id)).status, 404, "a file never sent to the agent stays private");
    assert.ok(!(await mcpList(w.scoutToken)).has(unsent.id));

    // Another agent: the private chat is not its thread.
    assert.equal((await mcpDownload(w.builderToken, file.id)).status, 404);
    assert.ok(!(await mcpList(w.builderToken)).has(file.id));

    // An operator token naming no agent never sees it; acting as the agent it may.
    assert.equal((await mcpDownload(w.operatorToken, file.id)).status, 404);
    assert.ok(!(await mcpList(w.operatorToken)).has(file.id));
    assert.equal((await mcpDownload(w.operatorToken, file.id, w.scout.id)).status, 200);

    // list_storage_files follows the same rule.
    const scoutTools = await mcpClientFor(w.companyId, w.scout.id);
    const builderTools = await mcpClientFor(w.companyId, w.builder.id);
    assert.ok((await scoutTools.tool("list_storage_files", { search: "brief" })).text.includes(file.id));
    assert.ok(!(await builderTools.tool("list_storage_files", { search: "brief" })).text.includes(file.id));

    // Even the addressed agent cannot delete or move it.
    const deleteRoute = await import("@/app/api/mcp/artifacts/[id]/delete/route");
    const deleted = await call(deleteRoute.DELETE as never, `/api/mcp/artifacts/${file.id}/delete`, { method: "DELETE", headers: bearer(w.scoutToken), params: { id: file.id } });
    assert.equal(deleted.status, 403, deleted.text);
    const db = await getDb();
    const { artifacts } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    assert.equal(row.deletedAt, null);

    // And no agent writes into a person's uploads folder.
    const foldersRoute = await import("@/app/api/mcp/folders/route");
    const sub = await call(foldersRoute.POST as never, "/api/mcp/folders", { method: "POST", headers: bearer(w.scoutToken), body: { name: "agent-notes", parentFolderId: row.folderId } });
    assert.equal(sub.status, 403, sub.text);
});

async function postTeam(person: Person, text: string, attachments: string[]) {
    const { POST } = await import("@/app/api/chat/route");
    actAs(person);
    return call(POST, "/api/chat", { method: "POST", body: { text, attachments } });
}

async function entityCard(person: Person, id: string) {
    const { GET } = await import("@/app/api/ui/entities/route");
    actAs(person);
    const res = await call(GET as never, `/api/ui/entities?refs=artifact:${id}`);
    assert.equal(res.status, 200, res.text);
    return (res.json.entities as Record<string, unknown>)[`artifact:${id}`];
}

maybe("people who can read the message open its attachment; lists, search and writes stay strict", async () => {
    const w = await world();
    const { json: shared } = await upload(w.uploader, "teamzebra.txt", "for the whole team");
    const { json: privateOne } = await upload(w.uploader, "dmzebra.txt", "only for scout");
    assert.ok((await postTeam(w.uploader, "team, see attached", [shared.id])).status < 300);
    assert.ok((await send(w.uploader, w.scout.id, "scout only", [privateOne.id])).status < 300);

    // Attached in team chat: a colleague can open, download and see the card.
    const recordRoute = await import("@/app/api/ui/artifacts/[id]/route");
    actAs(w.colleague);
    assert.equal((await call(recordRoute.GET as never, `/api/ui/artifacts/${shared.id}`, { params: { id: shared.id } })).status, 200);
    const download = await uiDownload(w.colleague, shared.id);
    assert.equal(download.status, 200, download.text);
    assert.equal(download.text, "for the whole team");
    assert.ok(await entityCard(w.colleague, shared.id), "the chat file card resolves for a team member");

    // Attached only in the uploader's private chat: the colleague cannot read that thread.
    assert.equal((await uiDownload(w.colleague, privateOne.id)).status, 404);
    actAs(w.colleague);
    assert.equal((await call(recordRoute.GET as never, `/api/ui/artifacts/${privateOne.id}`, { params: { id: privateOne.id } })).status, 404);
    assert.equal(await entityCard(w.colleague, privateOne.id), null);

    // Still never in the colleague's Storage browser or search, and still not theirs to change.
    const listed = await uiList(w.colleague);
    assert.ok(!listed.has(shared.id) && !listed.has(privateOne.id), "list leaked a private upload");
    const found = await searchIds(w.colleague, "teamzebra");
    assert.ok(!found.has(shared.id), "search leaked a private upload");
    actAs(w.colleague);
    const patch = await call(recordRoute.PATCH as never, `/api/ui/artifacts/${shared.id}`, { method: "PATCH", body: { visibility: "company" }, params: { id: shared.id } });
    assert.equal(patch.status, 404);
    const deleteRoute = await import("@/app/api/ui/artifacts/[id]/delete/route");
    actAs(w.colleague);
    assert.equal((await call(deleteRoute.DELETE as never, `/api/ui/artifacts/${shared.id}/delete`, { method: "DELETE", params: { id: shared.id } })).status, 404);
    actAs(null);
});

async function formPost(handler: (req: NextRequest) => Promise<Response>, url: string, form: FormData) {
    const res = await handler(new NextRequest(new Request(`http://localhost${url}`, { method: "POST", body: form })));
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

maybe("a private Storage upload outside the uploads folders keeps its old agent access", async () => {
    const w = await world();
    const { seedTwoTenantsOfWork } = await import("./_access-helper");
    const work = await seedTwoTenantsOfWork(w.companyId);
    const analyst = await seedAgent(w.companyId, { name: "Analyst", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const analystToken = await seedMcpToken(w.companyId, analyst.id);

    const { POST } = await import("@/app/api/ui/artifacts/upload/route");
    actAs(w.uploader);
    const form = new FormData();
    form.append("file", new File(["project numbers"], "projectreport.txt", { type: "text/plain" }));
    form.append("projectId", work.projectIn.id);
    const uploaded = await formPost(POST as never, "/api/ui/artifacts/upload", form);
    actAs(null);
    assert.equal(uploaded.status, 201, uploaded.text);
    const file = uploaded.json.artifact as { id: string };
    const db = await getDb();
    const { artifacts } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    assert.equal(row.visibility, "private", "Storage uploads default to private");

    // The project's agent lists, downloads and verifies it, as before.
    assert.ok((await mcpList(analystToken)).has(file.id));
    const download = await mcpDownload(analystToken, file.id);
    assert.equal(download.status, 200, download.text);
    assert.equal(download.text, "project numbers");
    assert.equal((await mcpDownload(w.operatorToken, file.id)).status, 200, "operator tokens keep their access");
    const verifyRoute = await import("@/app/api/mcp/artifacts/[id]/verify/route");
    assert.equal((await call(verifyRoute.GET as never, `/api/mcp/artifacts/${file.id}/verify`, { headers: bearer(analystToken), params: { id: file.id } })).status, 200);
    // list_storage_files never listed private human uploads; it still does not.
    const tools = await mcpClientFor(w.companyId, analyst.id);
    assert.ok(!(await tools.tool("list_storage_files", { search: "projectreport" })).text.includes(file.id));
    // People: still private to the uploader.
    assert.ok(!(await uiList(w.colleague)).has(file.id));
    actAs(null);
});

maybe("a regular folder named uploads is never adopted as the managed root", async () => {
    const w = await world();
    const folderRoute = await import("@/app/api/ui/folders/route");
    actAs(w.admin);
    const regular = await call(folderRoute.POST as never, "/api/ui/folders", { method: "POST", body: { name: "uploads" } });
    assert.equal(regular.status, 201, regular.text);
    const regularId = (regular.json.folder as { id: string }).id;

    const { json: file } = await upload(w.uploader, "afterregular.txt", "x");
    const db = await getDb();
    const { artifacts, artifactFolders } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    const [mine] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, row.folderId!));
    const [root] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, mine.parentFolderId!));
    assert.equal(root.kind, "uploads_root");
    assert.equal(root.path, "user-uploads");
    assert.equal(root.name, "Uploads");
    assert.notEqual(root.id, regularId);
    assert.equal(mine.path, `user-uploads/${w.uploader.userId}`);
    const [untouched] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, regularId));
    assert.equal(untouched.kind, "folder");

    // Deleting the regular folder leaves everyone's uploads alone.
    const folderIdRoute = await import("@/app/api/ui/folders/[id]/route");
    actAs(w.admin);
    assert.equal((await call(folderIdRoute.DELETE as never, `/api/ui/folders/${regularId}`, { method: "DELETE", params: { id: regularId } })).status, 200);
    const [still] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    assert.equal(still.deletedAt, null);
    actAs(null);
});

maybe("upload folder kinds are reserved and the folders cannot be deleted, admins included", async () => {
    const w = await world();
    const { json: file } = await upload(w.uploader, "keep.txt", "keep");
    const db = await getDb();
    const { artifacts, artifactFolders } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, file.id));
    const [mine] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, row.folderId!));

    // Nobody creates or converts to a reserved kind.
    const uiFolders = await import("@/app/api/ui/folders/route");
    actAs(w.admin);
    for (const kind of ["user_uploads", "uploads_root"]) {
        assert.equal((await call(uiFolders.POST as never, "/api/ui/folders", { method: "POST", body: { name: `fake-${kind}`, kind } })).status, 400, kind);
    }
    const normal = await call(uiFolders.POST as never, "/api/ui/folders", { method: "POST", body: { name: "normal" } });
    assert.equal(normal.status, 201, normal.text);
    const normalId = (normal.json.folder as { id: string }).id;
    const uiFolder = await import("@/app/api/ui/folders/[id]/route");
    actAs(w.admin);
    assert.equal((await call(uiFolder.PATCH as never, `/api/ui/folders/${normalId}`, { method: "PATCH", body: { kind: "user_uploads" }, params: { id: normalId } })).status, 400);
    const mcpFolders = await import("@/app/api/mcp/folders/route");
    assert.equal((await call(mcpFolders.POST as never, "/api/mcp/folders", { method: "POST", headers: bearer(w.scoutToken), body: { name: "fake-root", kind: "uploads_root" } })).status, 400);
    const kinds = (await db.select({ kind: artifactFolders.kind }).from(artifactFolders).where(eq(artifactFolders.companyId, w.companyId))).map((f) => f.kind);
    assert.equal(kinds.filter((k) => k === "uploads_root").length, 1);
    assert.equal(kinds.filter((k) => k === "user_uploads").length, 1);

    // Neither the person's folder nor the root can be deleted, by the owner or an admin; agents get 403.
    for (const [person, id] of [[w.uploader, mine.id], [w.admin, mine.id], [w.admin, mine.parentFolderId!]] as const) {
        actAs(person);
        const res = await call(uiFolder.DELETE as never, `/api/ui/folders/${id}`, { method: "DELETE", params: { id } });
        assert.equal(res.status, 409, res.text);
    }
    const mcpFolder = await import("@/app/api/mcp/folders/[id]/route");
    assert.equal((await call(mcpFolder.DELETE as never, `/api/mcp/folders/${mine.id}`, { method: "DELETE", headers: bearer(w.operatorToken), params: { id: mine.id } })).status, 403);
    const [folderStill] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, mine.id));
    assert.equal(folderStill.deletedAt, null);

    // A single file inside can still be deleted by an admin.
    const deleteRoute = await import("@/app/api/ui/artifacts/[id]/delete/route");
    actAs(w.admin);
    assert.equal((await call(deleteRoute.DELETE as never, `/api/ui/artifacts/${file.id}/delete`, { method: "DELETE", params: { id: file.id } })).status, 200);
    actAs(null);
});

maybe("voice messages are private chat uploads in the sender's folder, playable by whoever reads the message", async () => {
    const w = await world();
    const { POST } = await import("@/app/api/chat/voice/route");
    const voice = async (person: Person) => {
        actAs(person);
        const form = new FormData();
        form.append("file", new File(["fake-audio"], "voice.webm", { type: "audio/webm" }));
        return formPost(POST as never, "/api/chat/voice", form);
    };
    const direct = await voice(w.uploader);
    const team = await voice(w.uploader);
    assert.equal(direct.status, 201, direct.text);
    assert.equal(team.status, 201, team.text);
    const directId = direct.json.id as string;
    const teamId = team.json.id as string;

    const db = await getDb();
    const { artifacts, artifactFolders } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, directId));
    assert.equal(row.visibility, "private");
    assert.equal(row.sourceKind, "voice-message");
    const [folder] = await db.select().from(artifactFolders).where(eq(artifactFolders.id, row.folderId!));
    assert.equal(folder.kind, "user_uploads");
    assert.equal(folder.ownerUserId, w.uploader.userId);

    assert.ok((await send(w.uploader, w.scout.id, "Voice message (3s)", [directId])).status < 300);
    assert.ok((await postTeam(w.uploader, "Voice message (2s)", [teamId])).status < 300);

    assert.equal((await uiDownload(w.uploader, directId)).status, 200, "the sender plays it");
    assert.equal((await uiDownload(w.colleague, directId)).status, 404, "outside the private chat");
    assert.equal((await uiDownload(w.colleague, teamId)).status, 200, "a team chat reader plays it");
    actAs(null);
    assert.equal((await mcpDownload(w.scoutToken, directId)).status, 200, "the chat's agent hears it");
    assert.equal((await mcpDownload(w.builderToken, directId)).status, 404);
    assert.ok(!(await uiList(w.colleague)).has(teamId));
    actAs(null);
});
