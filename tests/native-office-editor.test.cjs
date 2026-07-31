const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("native Office editors are pinned, lazy-loaded, and save through artifact replacement", () => {
    const pkg = JSON.parse(read("package.json"));
    const shell = read("src/app/(app)/artifacts/[id]/edit/artifact-office-editor.tsx");
    const manager = read("src/app/(app)/artifacts/artifacts-manager.tsx");

    assert.equal(pkg.dependencies["@extend-ai/react-xlsx"], "0.16.0");
    assert.equal(pkg.dependencies["@extend-ai/react-docx"], "0.8.1");
    assert.equal(pkg.dependencies.fflate, "0.8.3");
    assert.match(shell, /dynamic\(\(\) => import\("@\/components\/artifact-editor\/xlsx-artifact-editor"\)/);
    assert.match(shell, /dynamic\(\(\) => import\("@\/components\/artifact-editor\/docx-artifact-editor"\)/);
    assert.match(shell, /\/api\/ui\/artifacts\/\$\{artifact\.id\}\/replace/);
    assert.match(shell, /formData\.set\("folderId", artifact\.folderId\)/);
    assert.match(manager, /Edit in Emperor/);
    assert.match(manager, /name\.endsWith\("\.xlsx"\) \|\| name\.endsWith\("\.docx"\)/);
});

test("active application contains no ONLYOFFICE integration", () => {
    const files = [
        "package.json",
        "docker-compose.yml",
        "src/app/(app)/artifacts/artifacts-manager.tsx",
        "src/app/(app)/artifacts/[id]/edit/artifact-office-editor.tsx",
    ];
    for (const file of files) assert.doesNotMatch(read(file), /onlyoffice/i, file);
});

test("Extend MIT notice is distributed with the application", () => {
    const notice = read("THIRD_PARTY_NOTICES.md");
    assert.match(notice, /@extend-ai\/react-xlsx/);
    assert.match(notice, /@extend-ai\/react-docx/);
    assert.match(notice, /fflate/);
    assert.match(notice, /MIT License/);
    assert.match(notice, /Copyright \(c\) 2026 CrowdView Inc, dba Extend/);
});

test("production CSP permits only the WebAssembly evaluation needed by the Office editors", () => {
    const nextConfig = read("next.config.ts");
    const nginxGuide = read("docs/security-headers-nginx.md");

    assert.match(nextConfig, /'wasm-unsafe-eval'/);
    assert.match(nginxGuide, /'wasm-unsafe-eval'/);
    assert.match(nextConfig, /isDev \? " 'unsafe-eval'" : ""/);
});
