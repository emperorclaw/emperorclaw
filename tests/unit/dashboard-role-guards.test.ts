import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The dashboard's inline actions call these routes. Each must authenticate the
// caller through requireRole before touching data. Company viewers inherit
// member-level permissions by design (FR-23 floor, see tests/team-rbac.test.ts),
// so "member" keeps anonymous callers out without taking access away from
// anyone who has it today.
const ROUTES: Array<[string, string]> = [
    ["src/app/api/approvals/[id]/route.ts", "PATCH"],
    ["src/app/api/tasks/[id]/route.ts", "PATCH"],
    ["src/app/api/agents/[id]/recreate-runtime/route.ts", "POST"],
];

for (const [file, method] of ROUTES) {
    test(`${method} ${file} requires a signed-in company member`, () => {
        const source = readFileSync(resolve(__dirname, "../..", file), "utf8");
        const handler = source.slice(source.indexOf(`export async function ${method}`));
        assert.ok(handler.length > 0, `${method} handler exists`);
        const guard = handler.indexOf('requireRole("member")');
        assert.ok(guard > 0, "guarded by requireRole(\"member\")");
        const firstDbUse = handler.search(/\bdb\.(select|update|insert|delete)\b/);
        assert.ok(firstDbUse === -1 || guard < firstDbUse, "the guard runs before any database access");
    });
}
