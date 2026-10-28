import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The dashboard's inline actions call these routes. Each must authenticate the
// caller through requireRole before touching data. Company viewers inherit
// member-level permissions by design (FR-23 floor, see tests/team-rbac.test.ts),
// so "member" keeps anonymous callers out without taking access away from
// anyone who has it today.
// Since 0.20 a task edit is resource-aware: the signed-in floor is "viewer"
// and the task's project decides (taskWriteDenied, lib/resource-access.ts).
const ROUTES: Array<[string, string, string]> = [
    ["src/app/api/approvals/[id]/route.ts", "PATCH", 'requireRole("member")'],
    ["src/app/api/tasks/[id]/route.ts", "PATCH", "taskWriteDenied("],
    ["src/app/api/agents/[id]/recreate-runtime/route.ts", "POST", 'requireRole("member")'],
];

for (const [file, method, check] of ROUTES) {
    test(`${method} ${file} requires a signed-in company member`, () => {
        const source = readFileSync(resolve(__dirname, "../..", file), "utf8");
        const handler = source.slice(source.indexOf(`export async function ${method}`));
        assert.ok(handler.length > 0, `${method} handler exists`);
        assert.ok(handler.indexOf("requireRole(") > 0, "signed in through requireRole");
        const guard = handler.indexOf(check);
        assert.ok(guard > 0, `guarded by ${check}`);
        const firstDbUse = handler.search(/\bdb\.(select|update|insert|delete)\b/);
        assert.ok(firstDbUse === -1 || guard < firstDbUse, "the guard runs before any database access");
    });
}
