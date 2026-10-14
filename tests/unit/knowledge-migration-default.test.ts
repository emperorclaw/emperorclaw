import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(process.cwd(), "src", "db", "migrations");

test("the inject column defaults to on_request, matching is_shared=false", () => {
  const file = readdirSync(migrationsDir).find((name) => name.endsWith("knowledge-injection-modes.sql"));
  assert.ok(file, "knowledge-injection-modes migration should exist");
  const sql = readFileSync(join(migrationsDir, file!), "utf8");
  assert.match(sql, /ADD COLUMN "inject" text DEFAULT 'on_request' NOT NULL/, "migration default is on_request");
  assert.ok(
    sql.includes(`CASE WHEN "is_shared" THEN 'index' ELSE 'on_request' END`),
    "migration still maps existing rows",
  );

  const snapshot = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "0060_snapshot.json"), "utf8"),
  );
  assert.equal(
    snapshot.tables["public.scoped_resources"].columns.inject.default,
    "'on_request'",
    "snapshot default matches the migration",
  );

  const schema = readFileSync(join(process.cwd(), "src", "db", "schema.ts"), "utf8");
  assert.match(schema, /inject: text\("inject"\)\.default\('on_request'\)/, "schema.ts default is on_request");
});
