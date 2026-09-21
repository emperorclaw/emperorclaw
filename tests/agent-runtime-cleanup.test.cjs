/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

test("Agent deletion tears down the container and its Hermes volume", () => {
  const deletion = read("src/lib/agent-deletion.ts");
  assert.ok(deletion.includes("dockerVolumeRemove"), "deletion should remove the per-agent volume");
  assert.ok(deletion.includes("hermesVolumeName"), "deletion should derive the volume name from the shared helper");
  assert.ok(deletion.includes("warnings"), "teardown failures should be collected, not swallowed");
  assert.ok(!deletion.includes(".catch(() => {})"), "teardown failures must not be silently swallowed");

  const docker = read("src/lib/docker.ts");
  assert.ok(docker.includes("export async function dockerVolumeRemove"), "docker helper should expose volume removal");

  const route = read("src/app/api/agents/[id]/route.ts");
  assert.ok(route.includes("cleanup"), "the DELETE route should return the cleanup outcome");
});
