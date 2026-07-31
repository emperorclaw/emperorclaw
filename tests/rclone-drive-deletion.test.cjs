const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Drive sidecar consumes exact deletion markers before inbound copy", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "emperor-rclone-sidecar-"));
    const bin = path.join(fixture, "bin");
    const localRoot = path.join(fixture, "storage", "companies");
    const queueRoot = path.join(fixture, "storage", ".drive-sync", "deletions");
    const remoteRoot = path.join(fixture, "remote");
    const logPath = path.join(fixture, "rclone.log");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(localRoot, "company-a", "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(remoteRoot, "company-a", "artifacts", "Old Folder"), { recursive: true });
    fs.mkdirSync(path.join(queueRoot, "files"), { recursive: true });
    fs.mkdirSync(path.join(queueRoot, "directories"), { recursive: true });
    fs.writeFileSync(path.join(remoteRoot, "company-a", "artifacts", "ghost.txt"), "stale");
    fs.writeFileSync(path.join(remoteRoot, "company-a", "artifacts", "keep.txt"), "external");
    fs.writeFileSync(path.join(remoteRoot, "company-a", "artifacts", "Old Folder", "nested.txt"), "stale");
    fs.writeFileSync(path.join(localRoot, "company-a", "artifacts", "ghost.txt"), "resurrected");
    fs.mkdirSync(path.join(localRoot, "company-a", "artifacts", "Old Folder"), { recursive: true });
    fs.writeFileSync(path.join(localRoot, "company-a", "artifacts", "Old Folder", "nested.txt"), "resurrected");
    fs.writeFileSync(path.join(queueRoot, "files", "file-marker"), "company-a/artifacts/ghost.txt\n");
    fs.writeFileSync(path.join(queueRoot, "directories", "directory-marker"), "company-a/artifacts/Old Folder\n");

    const fakeRclone = path.join(bin, "rclone");
    fs.writeFileSync(fakeRclone, `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RCLONE_LOG, JSON.stringify(args) + "\n");
if (args[0] === "delete") {
  const marker = args[args.indexOf("--files-from-raw") + 1];
  const relative = fs.readFileSync(marker, "utf8").trim();
  fs.rmSync(path.join(process.env.FAKE_REMOTE_ROOT, relative), { force: true });
}
if (args[0] === "purge") {
  const prefix = "mock:Mirror/companies/";
  const relative = args[1].startsWith(prefix) ? args[1].slice(prefix.length) : "";
  fs.rmSync(path.join(process.env.FAKE_REMOTE_ROOT, relative), { recursive: true, force: true });
}
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });

    try {
        const result = spawnSync("sh", [path.join(root, "scripts", "rclone-drive-sync.sh")], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                DRIVE_RCLONE_REMOTE: "mock",
                DRIVE_ROOT: "Mirror",
                DRIVE_LOCAL_ROOT: localRoot,
                DRIVE_DELETE_QUEUE_DIR: queueRoot,
                DRIVE_POLL_INTERVAL_SECONDS: "2",
                FAKE_RCLONE_LOG: logPath,
                FAKE_REMOTE_ROOT: remoteRoot,
            },
        });
        assert.equal(result.status, 9, result.stderr);
        assert.equal(fs.existsSync(path.join(remoteRoot, "company-a", "artifacts", "ghost.txt")), false);
        assert.equal(fs.existsSync(path.join(remoteRoot, "company-a", "artifacts", "Old Folder")), false);
        assert.equal(fs.existsSync(path.join(localRoot, "company-a", "artifacts", "ghost.txt")), false);
        assert.equal(fs.existsSync(path.join(localRoot, "company-a", "artifacts", "Old Folder")), false);
        assert.equal(fs.readFileSync(path.join(remoteRoot, "company-a", "artifacts", "keep.txt"), "utf8"), "external");
        assert.deepEqual(fs.readdirSync(path.join(queueRoot, "files")), []);
        assert.deepEqual(fs.readdirSync(path.join(queueRoot, "directories")), []);

        const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
        const deletionIndex = calls.findIndex((args) => args[0] === "delete");
        const inboundIndex = calls.findIndex((args) => args[0] === "copy" && args[1] === "mock:Mirror/companies");
        assert.ok(deletionIndex >= 0 && inboundIndex > deletionIndex, "deletions must run before inbound copy");
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
