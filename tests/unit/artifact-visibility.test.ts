import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
    agentMayChangeArtifact,
    agentMayWriteIntoFolder,
    humanMayChangeArtifact,
    humanMayViewArtifact,
    humanMayViewFolder,
    humanMayWriteIntoFolder,
    isManagedUploadsFolder,
    isPrivateChatUpload,
    isPrivateHumanUpload,
    isReservedFolderKind,
    isStorageAdmin,
} from "../../src/lib/artifact-visibility";
import {
    agentArtifactCondition,
    humanArtifactCondition,
    humanFolderCondition,
} from "../../src/lib/artifact-visibility-server";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const COMPANY = "44444444-4444-4444-8444-444444444444";
const privateUpload = { visibility: "private", createdByType: "human", createdById: OWNER };
const dialect = new PgDialect();

test("a private human upload is visible to its uploader and owners/admins only", () => {
    assert.equal(isPrivateHumanUpload(privateUpload), true);
    assert.equal(humanMayViewArtifact(privateUpload, { userId: OWNER, role: "member" }), true);
    assert.equal(humanMayViewArtifact(privateUpload, { userId: OWNER, role: "viewer" }), true);
    assert.equal(humanMayViewArtifact(privateUpload, { userId: OTHER, role: "member" }), false);
    assert.equal(humanMayViewArtifact(privateUpload, { userId: OTHER, role: "viewer" }), false);
    assert.equal(humanMayViewArtifact(privateUpload, { userId: null, role: null }), false);
    for (const role of ["admin", "owner", "instance_admin"]) {
        assert.equal(humanMayViewArtifact(privateUpload, { userId: OTHER, role }), true, role);
    }
    assert.equal(humanMayChangeArtifact(privateUpload, { userId: OTHER, role: "member" }), false);
    assert.equal(humanMayChangeArtifact(privateUpload, { userId: OTHER, role: "admin" }), true);
});

test("company files, agent output and ownerless legacy rows keep their visibility", () => {
    const member = { userId: OTHER, role: "member" };
    assert.equal(humanMayViewArtifact({ ...privateUpload, visibility: "company" }, member), true);
    assert.equal(humanMayViewArtifact({ ...privateUpload, createdByType: "agent" }, member), true);
    assert.equal(humanMayViewArtifact({ ...privateUpload, createdByType: "mcp" }, member), true);
    assert.equal(humanMayViewArtifact({ ...privateUpload, createdById: null }, member), true);
    assert.equal(isStorageAdmin({ userId: OTHER, role: "member" }), false);
    assert.equal(isStorageAdmin({ userId: OTHER, role: "garbage" }), false);
});

test("a person's uploads folder belongs to them; other folders are unchanged", () => {
    const uploads = { kind: "user_uploads", ownerUserId: OWNER };
    assert.equal(humanMayViewFolder(uploads, { userId: OWNER, role: "member" }), true);
    assert.equal(humanMayViewFolder(uploads, { userId: OTHER, role: "member" }), false);
    assert.equal(humanMayViewFolder(uploads, { userId: OTHER, role: "admin" }), true);
    assert.equal(humanMayViewFolder({ kind: "user_uploads", ownerUserId: null }, { userId: OTHER, role: "member" }), false);
    assert.equal(humanMayViewFolder({ kind: "folder", ownerUserId: null }, { userId: OTHER, role: "viewer" }), true);
    assert.equal(humanMayWriteIntoFolder(uploads, { userId: OTHER, role: "member" }), false);
    assert.equal(isManagedUploadsFolder(uploads), true);
    assert.equal(isManagedUploadsFolder({ kind: "uploads_root" }), true);
    assert.equal(isManagedUploadsFolder({ kind: "folder" }), false);
});

test("chat uploads: by source kind or a user_uploads folder; only those are closed to agents", () => {
    const chat = { ...privateUpload, sourceKind: "chat-attachment" };
    assert.equal(isPrivateChatUpload(chat), true);
    assert.equal(isPrivateChatUpload({ ...privateUpload, sourceKind: "voice-message" }), true);
    assert.equal(isPrivateChatUpload(privateUpload, "user_uploads"), true);
    assert.equal(isPrivateChatUpload(privateUpload, "folder"), false, "a private Storage upload is not a chat upload");
    assert.equal(isPrivateChatUpload({ ...chat, visibility: "company" }), false);
    assert.equal(agentMayChangeArtifact(chat), false);
    assert.equal(agentMayChangeArtifact(privateUpload, "user_uploads"), false);
    assert.equal(agentMayChangeArtifact(privateUpload), true, "private Storage uploads keep their old agent behavior");
    assert.equal(agentMayChangeArtifact({ ...privateUpload, createdByType: "agent" }), true);
});

test("upload folders are managed: reserved kinds, no writes into them by agents, none into the root by anyone", () => {
    assert.equal(isReservedFolderKind("user_uploads"), true);
    assert.equal(isReservedFolderKind("uploads_root"), true);
    assert.equal(isReservedFolderKind("folder"), false);
    assert.equal(isReservedFolderKind(undefined), false);
    assert.equal(agentMayWriteIntoFolder({ kind: "user_uploads", ownerUserId: OWNER }), false);
    assert.equal(agentMayWriteIntoFolder({ kind: "uploads_root" }), false);
    assert.equal(agentMayWriteIntoFolder({ kind: "folder" }), true);
    assert.equal(agentMayWriteIntoFolder(null), true);
    assert.equal(humanMayWriteIntoFolder({ kind: "uploads_root" }, { userId: OWNER, role: "owner" }), false);
    assert.equal(humanMayWriteIntoFolder({ kind: "user_uploads", ownerUserId: OWNER }, { userId: OWNER, role: "member" }), true);
});

test("SQL twins: admins unfiltered, members limited to their own private uploads", () => {
    assert.equal(humanArtifactCondition({ userId: OTHER, role: "admin" }), undefined);
    assert.equal(humanFolderCondition({ userId: OTHER, role: "owner" }), undefined);

    const member = dialect.sqlToQuery(humanArtifactCondition({ userId: OTHER, role: "member" })!);
    assert.match(member.sql, /"artifacts"\."visibility" <> 'private' OR "artifacts"\."created_by_type" <> 'human'/);
    assert.match(member.sql, /"artifacts"\."created_by_id" IS NULL/);
    assert.ok(member.params.includes(OTHER));

    const folders = dialect.sqlToQuery(humanFolderCondition({ userId: OTHER, role: "viewer" })!);
    assert.match(folders.sql, /"artifact_folders"\."kind" <>/);
    assert.ok(folders.params.includes("user_uploads"));
    assert.ok(folders.params.includes(OTHER));
});

test("SQL twins: agents need an attachment in a readable thread for chat uploads; operators see none", () => {
    const operator = dialect.sqlToQuery(agentArtifactCondition(COMPANY, null));
    assert.doesNotMatch(operator.sql, /thread_messages/);
    assert.match(operator.sql, /<> 'private'/);
    assert.match(operator.sql, /NOT \(/, "non-chat private uploads stay visible to operators");
    assert.match(operator.sql, /vis_f\.kind = /);
    const listing = dialect.sqlToQuery(agentArtifactCondition(COMPANY, null, undefined, { hideOtherPrivateUploads: true }));
    assert.doesNotMatch(listing.sql, /OR NOT \(/, "list_storage_files keeps hiding other private uploads");

    const agent = dialect.sqlToQuery(agentArtifactCondition(COMPANY, AGENT));
    assert.match(agent.sql, /FROM thread_messages vis_tm/);
    assert.match(agent.sql, /\(vis_tm\.metadata_json -> 'attachments'\) @> jsonb_build_array/);
    assert.match(agent.sql, /vis_th\.type = 'team'/);
    assert.match(agent.sql, /vis_th\.type = 'direct' AND vis_th\.direct_agent_id = /);
    assert.match(agent.sql, /vis_tp\.participant_type = 'agent'/);
    assert.ok(agent.params.includes(AGENT));
    assert.ok(agent.params.includes(COMPANY));
});
