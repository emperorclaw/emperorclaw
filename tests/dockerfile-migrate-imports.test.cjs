// The runner image only copies the files `src/db/migrate.ts` needs at startup.
// A module imported by the migration chain but missing from the image crashes
// every boot (v0.8.98 outage). Walk the import graph from migrate.ts and check
// that the Dockerfile copies every local file it reaches.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const copied = [...dockerfile.matchAll(/^COPY --from=builder \/app\/(\S+)/gm)].map((m) => m[1].replace(/\/$/, ""));

function resolveLocal(fromFile, spec) {
    let base;
    if (spec.startsWith("@/")) base = path.join(root, "src", spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
    else return null; // package import
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function migrateImportGraph() {
    const start = path.join(root, "src", "db", "migrate.ts");
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+["']([^"']+)["']/gm)) {
            const next = resolveLocal(file, match[1]);
            if (next) queue.push(next);
        }
    }
    return [...seen].map((file) => path.relative(root, file).split(path.sep).join("/"));
}

test("the runner image copies every file the startup migration imports", () => {
    const missing = migrateImportGraph().filter(
        (file) => !copied.some((entry) => file === entry || file.startsWith(`${entry}/`)),
    );
    assert.deepStrictEqual(missing, [], `Dockerfile must COPY: ${missing.join(", ")}`);
});
