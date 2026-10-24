/* eslint-disable @typescript-eslint/no-require-imports */
// server.ts runs before Next prepares. A runtime import of next/server (or
// next/headers) anywhere in its import graph crashes the boot with
// "AsyncLocalStorage accessed in runtime where it is not available".
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve, dirname } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const FORBIDDEN = /^(next\/server|next\/headers)$/;

function resolveImport(fromFile, spec) {
    let base;
    if (spec.startsWith("@/")) base = resolve(root, "src", spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
        if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
    }
    return null;
}

/** Runtime (non type-only) imports of a module, with their specifiers. */
function runtimeImports(source) {
    const specs = [];
    const re = /^\s*import\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
    for (const m of source.matchAll(re)) {
        if (m[1]) continue; // import type { … }
        if (m[2] && /^\{[^}]*\}$/.test(m[2].trim()) && m[2].replace(/[{}\s]/g, "").split(",").filter(Boolean).every((s) => s.startsWith("type "))) continue;
        specs.push(m[3] ?? m[4]);
    }
    return specs;
}

test("server.ts never loads next/server or next/headers before Next starts", () => {
    const start = resolve(root, "server.ts");
    const seen = new Set();
    const queue = [[start, ["server.ts"]]];
    const offenders = [];
    while (queue.length) {
        const [file, chain] = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
            if (FORBIDDEN.test(spec)) offenders.push(`${chain.join(" -> ")} imports ${spec}`);
            const next = resolveImport(file, spec);
            if (next) queue.push([next, [...chain, next.slice(root.length + 1)]]);
        }
    }
    assert.deepEqual(offenders, []);
});
