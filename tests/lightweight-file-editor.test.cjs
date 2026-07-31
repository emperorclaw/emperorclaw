const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("Storage creates Office and lightweight files without an external service", () => {
    const manager = fs.readFileSync(path.join(root, "src/app/(app)/artifacts/artifacts-manager.tsx"), "utf8");
    const uploadRoute = fs.readFileSync(path.join(root, "src/app/api/ui/artifacts/upload/route.ts"), "utf8");
    assert.match(manager, /CREATABLE_FILE_TYPES/);
    assert.match(manager, /Excel workbook/);
    assert.match(manager, /Word document/);
    assert.match(manager, /CSV spreadsheet/);
    assert.match(manager, /Markdown/);
    assert.match(manager, /Plain text/);
    assert.match(manager, /JSON/);
    assert.match(manager, /Create and edit/);
    assert.match(manager, /createInitialFileContent/);
    assert.match(manager, /router\.push\(`\/artifacts\/\$\{payload\.artifact\.id\}\/edit`\)/);
    assert.match(manager, /New File Here/);
    assert.match(manager, /Rename file/);
    assert.match(manager, /\/api\/ui\/artifacts\/\$\{renameFileDraft\.artifactId\}\/move/);
    assert.match(manager, /The extension stays fixed/);
    assert.match(manager, /\/api\/ui\/artifacts\/upload/);
    assert.match(manager, /handleSaveTextDraft/);
    assert.match(manager, /handleSaveCsvDraft/);
    assert.doesNotMatch(uploadRoute, /Select a customer or project/);
});
