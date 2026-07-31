const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("storage mirror migration is additive and registered", () => {
    const migration = fs.readFileSync(path.join(root, "src/db/migrations/0035_storage-mirrors.sql"), "utf8");
    const journal = fs.readFileSync(path.join(root, "src/db/migrations/meta/_journal.json"), "utf8");
    assert.match(migration, /CREATE TABLE IF NOT EXISTS "storage_mirrors"/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS "storage_mirror_entries"/);
    assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|ALTER COLUMN/);
    assert.match(journal, /0035_storage-mirrors/);
});

test("Drive integration remains opt-in and shares the existing storage volume", () => {
    const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    const env = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    assert.match(compose, /profiles: \["drive"\]/);
    assert.match(compose, /app-storage:\/storage/);
    assert.match(env, /DRIVE_SYNC_ENABLED=false/);
    assert.match(env, /STORAGE_DISCOVERY_ENABLED=false/);
});

test("Drive setup documents a dedicated OAuth client and avoids filesystem metadata", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const guide = fs.readFileSync(path.join(root, "src/content/docs/v1.1/self-hosting-upgrades.md"), "utf8");
    const syncScript = fs.readFileSync(path.join(root, "scripts/rclone-drive-sync.sh"), "utf8");
    assert.match(readme, /shared built-in client ID is\s+being retired during 2026/);
    assert.match(guide, /Select full Drive access/);
    assert.match(syncScript, /rclone mkdir "\$remote_path"/);
    assert.doesNotMatch(syncScript, /--metadata/);
});

test("untracked Drive files are promoted explicitly instead of entering artifact APIs", () => {
    const manager = fs.readFileSync(path.join(root, "src/app/(app)/artifacts/artifacts-manager.tsx"), "utf8");
    const contentsRoute = fs.readFileSync(path.join(root, "src/app/api/ui/folders/contents/route.ts"), "utf8");
    assert.match(manager, /Missing metadata/);
    assert.match(manager, /api\/ui\/artifacts\/finalize/);
    assert.match(contentsRoute, /discoveredEntries/);
    assert.match(contentsRoute, /registeredPaths/);
});

test("a selected artifact preview refreshes after mirrored content changes", () => {
    const manager = fs.readFileSync(path.join(root, "src/app/(app)/artifacts/artifacts-manager.tsx"), "utf8");
    assert.match(manager, /refreshedArtifact\.updatedAt/);
    assert.match(manager, /fetchArtifactDetail\(selectedEntry\.id\)/);
});

test("Emperor deletions propagate without enabling broad Drive-side deletion", () => {
    const syncScript = fs.readFileSync(path.join(root, "scripts/rclone-drive-sync.sh"), "utf8");
    const localAdapter = fs.readFileSync(path.join(root, "src/lib/storage/local.ts"), "utf8");
    assert.match(syncScript, /process_delete_markers/);
    assert.match(syncScript, /--files-from-raw/);
    assert.ok(syncScript.indexOf("process_delete_markers") < syncScript.indexOf('rclone copy "$remote_path" "$local_root"'));
    assert.doesNotMatch(syncScript, /rclone sync/);
    assert.match(localAdapter, /enqueueDriveMirrorDeletion/);
});
