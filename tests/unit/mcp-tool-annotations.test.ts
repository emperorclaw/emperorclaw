import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { TOOL_ANNOTATIONS, annotateTools } from "../../src/lib/mcp-server/tool-annotations";

const toolsDir = path.join(__dirname, "../../src/lib/mcp-server/tools");

function registeredToolNames(): string[] {
    const names = new Set<string>();
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
        const source = readFileSync(path.join(toolsDir, file), "utf8");
        for (const match of source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) names.add(match[1]);
    }
    return [...names].sort();
}

test("every registered MCP tool has annotations, so Codex does not treat it as an unvetted write", () => {
    const names = registeredToolNames();
    assert.ok(names.length > 40, `found ${names.length} tools; the scan is broken`);
    assert.deepEqual(names.filter((name) => !TOOL_ANNOTATIONS[name]), [], "tools missing from TOOL_ANNOTATIONS");
    assert.deepEqual(Object.keys(TOOL_ANNOTATIONS).filter((name) => !names.includes(name)), [], "annotations for tools that no longer exist");
});

test("reads are read-only and writes are not", () => {
    for (const [name, hints] of Object.entries(TOOL_ANNOTATIONS)) {
        const isRead = /^(get|list|search|read)_/.test(name) || name === "wait_for_reply";
        assert.equal(hints.readOnlyHint, isRead, `${name} readOnlyHint`);
        if (hints.readOnlyHint) assert.equal(hints.destructiveHint, false, `${name} is read-only yet destructive`);
    }
    for (const name of ["archive_group", "archive_view", "remove_group_member", "decide_approval", "update_task", "run_automation"]) {
        assert.equal(TOOL_ANNOTATIONS[name].destructiveHint, true, `${name} changes what exists`);
    }
});

test("annotateTools adds the hints at registration, keeps a tool's own, and leaves unknown tools alone", () => {
    const calls: unknown[][] = [];
    const server = { registerTool: (...args: unknown[]) => { calls.push(args); return "registered"; } };
    annotateTools(server);
    const handler = () => null;

    assert.equal(server.registerTool("list_tasks", { title: "List Tasks" }, handler), "registered");
    assert.deepEqual(calls[0], ["list_tasks", { title: "List Tasks", annotations: TOOL_ANNOTATIONS.list_tasks }, handler]);

    server.registerTool("update_task", { annotations: { idempotentHint: false } }, handler);
    assert.deepEqual((calls[1][1] as { annotations: unknown }).annotations, { ...TOOL_ANNOTATIONS.update_task, idempotentHint: false });

    const config = { title: "Unknown" };
    server.registerTool("not_a_tool", config, handler);
    assert.equal(calls[2][1], config);
});
