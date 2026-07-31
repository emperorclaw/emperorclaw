import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueDriveMirrorDeletion } from "../../src/lib/storage/drive-deletion-queue.ts";

test("Drive deletion markers are opt-in and persist exact relative paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emperor-drive-delete-"));
    const previous = {
        backend: process.env.STORAGE_BACKEND,
        drive: process.env.DRIVE_SYNC_ENABLED,
        root: process.env.STORAGE_LOCAL_DIR,
    };

    try {
        process.env.STORAGE_BACKEND = "local";
        process.env.STORAGE_LOCAL_DIR = root;
        process.env.DRIVE_SYNC_ENABLED = "false";
        await enqueueDriveMirrorDeletion({
            companyId: "11111111-1111-1111-1111-111111111111",
            logicalPath: "Reports/old.xlsx",
            entryType: "file",
        });
        await assert.rejects(fs.stat(path.join(root, ".drive-sync")), { code: "ENOENT" });

        process.env.DRIVE_SYNC_ENABLED = "true";
        await enqueueDriveMirrorDeletion({
            companyId: "11111111-1111-1111-1111-111111111111",
            logicalPath: "Reports/old.xlsx",
            entryType: "file",
        });
        await enqueueDriveMirrorDeletion({
            companyId: "11111111-1111-1111-1111-111111111111",
            logicalPath: "Reports/Archive",
            entryType: "directory",
        });

        const fileQueue = path.join(root, ".drive-sync", "deletions", "files");
        const directoryQueue = path.join(root, ".drive-sync", "deletions", "directories");
        const [fileMarker] = await fs.readdir(fileQueue);
        const [directoryMarker] = await fs.readdir(directoryQueue);
        assert.equal(
            await fs.readFile(path.join(fileQueue, fileMarker), "utf8"),
            "11111111-1111-1111-1111-111111111111/artifacts/Reports/old.xlsx\n",
        );
        assert.equal(
            await fs.readFile(path.join(directoryQueue, directoryMarker), "utf8"),
            "11111111-1111-1111-1111-111111111111/artifacts/Reports/Archive\n",
        );
    } finally {
        if (previous.backend === undefined) delete process.env.STORAGE_BACKEND;
        else process.env.STORAGE_BACKEND = previous.backend;
        if (previous.drive === undefined) delete process.env.DRIVE_SYNC_ENABLED;
        else process.env.DRIVE_SYNC_ENABLED = previous.drive;
        if (previous.root === undefined) delete process.env.STORAGE_LOCAL_DIR;
        else process.env.STORAGE_LOCAL_DIR = previous.root;
        await fs.rm(root, { recursive: true, force: true });
    }
});
