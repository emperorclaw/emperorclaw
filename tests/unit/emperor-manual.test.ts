import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_KERNEL,
  MCP_KERNEL,
  EMPEROR_MANUAL,
  EMPEROR_MANUAL_SECTIONS,
  getEmperorManualSection,
  listEmperorManualSections,
} from "../../src/lib/emperor-manual";
import { RICH_REPLY_GUIDE } from "../../src/lib/rich-reply-guide";

const EXPECTED_SECTIONS = [
  "chat-and-mentions",
  "tasks-and-projects",
  "knowledge",
  "storage",
  "approvals",
  "team-handoffs",
  "reply-formatting",
];

test("the manual exposes every named section", () => {
  const ids = listEmperorManualSections().map((section) => section.id);
  for (const id of EXPECTED_SECTIONS) {
    assert.ok(ids.includes(id), `manual should have a ${id} section`);
  }
  assert.equal(new Set(ids).size, ids.length, "section ids must be unique");
});

test("section lookup is case-insensitive and null for unknown ids", () => {
  assert.equal(getEmperorManualSection("APPROVALS")?.id, "approvals");
  assert.equal(getEmperorManualSection("does-not-exist"), null);
});

test("the reply-formatting section is the full rich-reply guide", () => {
  assert.equal(getEmperorManualSection("reply-formatting")?.body, RICH_REPLY_GUIDE);
});

test("the manual renders every section under its heading", () => {
  for (const section of EMPEROR_MANUAL_SECTIONS) {
    assert.ok(EMPEROR_MANUAL.includes(`## ${section.title}`), `manual should head ${section.title}`);
    assert.ok(EMPEROR_MANUAL.includes(section.body), `manual should body ${section.title}`);
  }
});

test("both kernels are at most 1,500 characters", () => {
  assert.ok(BRIDGE_KERNEL.length <= 1500, `bridge kernel is ${BRIDGE_KERNEL.length} chars, max 1500`);
  assert.ok(MCP_KERNEL.length <= 1500, `mcp kernel is ${MCP_KERNEL.length} chars, max 1500`);
});

test("both kernels carry the shared incident-driven rules", () => {
  for (const [name, kernel] of [["bridge", BRIDGE_KERNEL], ["mcp", MCP_KERNEL]] as const) {
    for (const phrase of ["@all", "approved", "mayProceed", "get_emperor_manual", "search_knowledge", "exactly one owner", "never close work you did not own", "never print secrets"]) {
      assert.ok(kernel.includes(phrase), `${name} kernel should mention ${phrase}`);
    }
  }
});

test("kernels differ on how a reply is delivered", () => {
  // Bridges deliver the reply themselves; MCP clients answer WITH send_message.
  assert.ok(BRIDGE_KERNEL.includes("delivered to the current thread automatically"));
  assert.ok(BRIDGE_KERNEL.includes("Never call send_message to answer"));
  assert.ok(BRIDGE_KERNEL.includes("lean index below"));

  assert.ok(MCP_KERNEL.includes("calling send_message in the thread you are replying to"));
  assert.ok(MCP_KERNEL.includes("one reply, no duplicates"));
  assert.ok(MCP_KERNEL.includes("get_knowledge_context or search_knowledge"));
  assert.equal(MCP_KERNEL.includes("index below"), false, "MCP clients get no pre-sent index");
});
