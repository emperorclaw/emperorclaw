/* eslint-disable @typescript-eslint/no-require-imports */
// Security regression guards. These are static source assertions in the same
// style as architecture-boundary.test.cjs: each one pins a security control
// that was added after an audit, so it cannot silently disappear in a
// refactor. Behavioral coverage for the path sanitizer lives in
// path-sanitizer.test.ts.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

test("legacy task-notes route stays authenticated and tenant-scoped", () => {
  const source = read("src/app/api/tasks/[id]/notes/route.ts");
  assert.ok(
    source.includes("requireCompanyFromSession"),
    "notes route must resolve the caller's company from the session"
  );
  assert.ok(
    source.includes("task.companyId !== companyId"),
    "notes route must reject cross-tenant task ids"
  );
});

test("MCP token verification enforces a rate limit", () => {
  const source = read("src/lib/mcp.ts");
  assert.ok(
    source.includes("consumeRateLimit"),
    "verifyMcpToken must consume the rate limiter"
  );
  assert.ok(
    source.includes("Rate limit exceeded"),
    "verifyMcpToken must return a 429-style rejection when over the limit"
  );
});

test("idempotency relies on the unique index, not check-then-insert alone", () => {
  const schema = read("src/db/schema.ts");
  assert.ok(
    schema.includes('uniqueIndex("idx_idempotency_unique_request")'),
    "idempotencyKeys must keep the (companyId, requestHash) unique index"
  );
  const mcp = read("src/lib/mcp.ts");
  assert.ok(
    mcp.includes("onConflictDoNothing"),
    "saveIdempotencyResponse must insert with ON CONFLICT DO NOTHING"
  );
});

test("storage adapters route paths through the shared sanitizer", () => {
  for (const adapter of ["src/lib/storage/bunny.ts", "src/lib/storage/local.ts"]) {
    const source = read(adapter);
    assert.ok(
      source.includes("sanitizeLogicalPath"),
      `${adapter} must sanitize logical paths via path-sanitizer`
    );
  }
});

test("artifact download enforces nosniff, safe inline types, and visibility", () => {
  const source = read("src/app/api/ui/artifacts/[id]/download/route.ts");
  assert.ok(source.includes("X-Content-Type-Options"), "download must set nosniff");
  assert.ok(source.includes("SAFE_INLINE_TYPES"), "inline disposition must be allowlisted");
  assert.ok(
    source.includes('artifact.visibility === "private"'),
    "download must enforce private-visibility ownership"
  );
});

test("inbound webhook dedup is company-scoped", () => {
  const source = read("src/app/api/webhook/inbound/route.ts");
  assert.ok(
    source.includes("eq(chatMessages.companyId, companyId)"),
    "webhook dedup lookup must be scoped to the caller's company"
  );
});

test("high-risk MCP mutating routes validate bodies with zod", () => {
  const routes = [
    "src/app/api/mcp/artifacts/route.ts",
    "src/app/api/mcp/tasks/route.ts",
    "src/app/api/mcp/agents/route.ts",
    "src/app/api/mcp/agents/[id]/route.ts",
    "src/app/api/mcp/messages/send/route.ts",
    "src/app/api/webhook/inbound/route.ts",
  ];
  for (const route of routes) {
    const source = read(route);
    assert.ok(
      source.includes("parseJsonBody"),
      `${route} must parse its body through the shared zod boundary`
    );
  }
});
