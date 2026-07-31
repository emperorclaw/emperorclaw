import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverDirectStorageEntries } from "../src/lib/storage/discovery.ts";

test("storage discovery lists direct unknown candidates and ignores transfer files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emperor-storage-discovery-"));
    const previousRoot = process.env.STORAGE_LOCAL_DIR;
    const previousBackend = process.env.STORAGE_BACKEND;
    const previousDiscovery = process.env.STORAGE_DISCOVERY_ENABLED;
    process.env.STORAGE_LOCAL_DIR = root;
    process.env.STORAGE_BACKEND = "local";
    process.env.STORAGE_DISCOVERY_ENABLED = "true";
    try {
        const companyRoot = path.join(root, "companies", "company-1", "artifacts", "Reports");
        await fs.mkdir(path.join(companyRoot, "Incoming"), { recursive: true });
        await fs.writeFile(path.join(companyRoot, "proposal.docx"), "document");
        await fs.writeFile(path.join(companyRoot, "draft.partial"), "partial");
        await fs.writeFile(path.join(companyRoot, "~$proposal.docx"), "lock");

        const entries = await discoverDirectStorageEntries({ companyId: "company-1", folderPath: "Reports" });
        assert.deepEqual(entries.map((entry) => [entry.name, entry.entryType]), [
            ["Incoming", "folder"],
            ["proposal.docx", "file"],
        ]);
        assert.equal(entries[1].contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } finally {
        if (previousRoot === undefined) delete process.env.STORAGE_LOCAL_DIR; else process.env.STORAGE_LOCAL_DIR = previousRoot;
        if (previousBackend === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = previousBackend;
        if (previousDiscovery === undefined) delete process.env.STORAGE_DISCOVERY_ENABLED; else process.env.STORAGE_DISCOVERY_ENABLED = previousDiscovery;
        await fs.rm(root, { recursive: true, force: true });
    }
});
