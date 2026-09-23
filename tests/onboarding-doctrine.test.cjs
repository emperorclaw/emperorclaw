/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

test("Boss template is pinned and listed first", () => {
  const templates = read("src/lib/agent-templates.ts");
  const bossIdx = templates.indexOf('id: "boss"');
  const seoIdx = templates.indexOf('id: "seo"');
  assert.ok(bossIdx !== -1, "a Boss template should exist");
  assert.ok(seoIdx !== -1, "the specialist templates should still exist");
  assert.ok(bossIdx < seoIdx, "Boss should be the first template so first-time users see it");
  assert.ok(templates.includes("pinned: true"), "Boss should be pinned");
  assert.ok(templates.includes("getPinnedAgentTemplates"), "pinned templates should be exposed to the picker");
});

test("Role picker renders pinned roles above the scrollable specialist grid", () => {
  const picker = read("src/app/(app)/agents/role-template-picker.tsx");
  const pinnedIdx = picker.indexOf("getPinnedAgentTemplates");
  const scrollIdx = picker.indexOf("overflow-y-auto");
  assert.ok(pinnedIdx !== -1, "the picker should render pinned roles");
  assert.ok(scrollIdx !== -1, "the picker should keep a scrollable grid");
  assert.ok(pinnedIdx < scrollIdx, "pinned roles should render before the scroll grid");
});

test("Default Hermes doctrine states the assignment and closure rules", () => {
  const guide = read("integrations/hermes/emperor-claw/operating-guide.md");
  assert.match(guide, /assignee/i, "the operating guide should mention the assignee");
  assert.match(guide, /set its assignee to the specific agent or person/i, "the guide should require an explicit owner");
  assert.match(guide, /assignee is accountable for closing/i, "the guide should make the assignee responsible for closure");
});

test("MCP instructions state the assignment and closure rules", () => {
  const instructions = read("src/lib/mcp-server/instructions.ts");
  assert.match(instructions, /exactly one owner/i, "MCP instructions should require a single owner");
  assert.match(instructions, /assignee closes it/i, "MCP instructions should make the assignee responsible for closure");
});

test("MCP task tools expose the hybrid assignee field", () => {
  const tools = read("src/lib/mcp-server/tools/tasks.ts");
  assert.ok(tools.includes('type: z.enum(["agent", "human"])'), "create/update task should accept agent or human assignees");
});

test("Provisioning passes role doctrine to the Hermes runtime", () => {
  const provisioning = read("src/lib/hermes-provisioning.ts");
  assert.ok(
    provisioning.includes("EMPEROR_CLAW_AGENT_INSTRUCTIONS"),
    "provisioning should set the role-doctrine env var for the container",
  );
  const bridge = read("integrations/hermes/emperor-claw/bridge/emperor_hermes_bridge.py");
  assert.ok(
    bridge.includes("EMPEROR_CLAW_AGENT_INSTRUCTIONS"),
    "the bridge should read the role-doctrine env var",
  );
});

test("Onboarding confirms the created agent and opens its direct chat", () => {
  const tour = read("src/components/onboarding-tour.tsx");
  assert.match(tour, /is created/i, "the tour should confirm the agent was created");
  assert.ok(tour.includes("Open direct chat"), "the tour should offer to open the direct chat");
  assert.ok(tour.includes("/messages?agent="), "the tour should deep-link into the agent's direct thread");

  const hub = read("src/components/messaging-hub.tsx");
  assert.ok(hub.includes('get("agent")'), "the messaging hub should read the ?agent= deep link");
});

test("Failed provisioning does not advance and can be retried", () => {
  const dialog = read("src/app/(app)/agents/easy-setup-dialog.tsx");
  assert.ok(dialog.includes("Retry provisioning"), "a failed batch should offer a retry");
  // The key is only cleared once a worker actually came up.
  assert.match(
    dialog,
    /if \(created\?\.agentId\) \{[\s\S]*?setLlmApiKey\(""\)/,
    "the API key should only be cleared on a successful creation",
  );
});

test("Hermes entrypoint points the bridge at the profile home", () => {
  const entrypoint = read("integrations/hermes/entrypoint.sh");
  assert.ok(
    entrypoint.includes('export HERMES_HOME="$HOME/.hermes/profiles/$PROFILE_NAME"'),
    "HERMES_HOME must be set so the bridge can read the session store and logs",
  );
});

test("Hermes entrypoint enables the tool-loop guardrail hard stop", () => {
  const entrypoint = read("integrations/hermes/entrypoint.sh");
  assert.ok(
    entrypoint.includes("tool_loop_guardrails.hard_stop_enabled true"),
    "the entrypoint should hard-stop tool loops so an agent cannot spin forever",
  );
});

test("Hermes entrypoint recreates the profile wrapper when it is missing", () => {
  const entrypoint = read("integrations/hermes/entrypoint.sh");
  assert.ok(entrypoint.includes("WRAPPER="), "the entrypoint should track the profile wrapper path");
  assert.match(entrypoint, /if \[ ! -x "\$WRAPPER" \]/, "the entrypoint should recreate a missing wrapper");
  assert.ok(
    entrypoint.includes('exec /home/hermes/.local/bin/hermes -p'),
    "the recreated wrapper should exec the profile-scoped hermes",
  );
});

test("Onboarding gates the direct chat on the agent coming online", () => {
  const tour = read("src/components/onboarding-tour.tsx");
  assert.ok(tour.includes("disabled={!online}"), "the chat button should be disabled until the agent is online");
  assert.ok(tour.includes("recreate-runtime"), "the tour should be able to retry provisioning");
  assert.ok(tour.includes("offlineTooLong"), "the tour should only offer a retry after a grace period");
});

test("Agents directory routes to the direct chat after hiring", () => {
  const client = read("src/app/(app)/agents/agents-client.tsx");
  assert.ok(client.includes("/messages?agent="), "hiring from /agents should open the direct chat once online");
  assert.ok(client.includes("handleAgentCreated"), "the directory should use the readiness-aware created handler");
  assert.ok(client.includes("recreate-runtime"), "the directory should offer a runtime retry if it stalls");
});

test("Onboarding is server-owned, not hidden by stale localStorage", () => {
  const tour = read("src/components/onboarding-tour.tsx");
  assert.ok(
    !tour.includes("window.localStorage"),
    "the tour must not gate on localStorage, or a server-side reset can never re-show it",
  );
  const page = read("src/app/(app)/page.tsx");
  assert.ok(
    page.includes("onboardingCompletedAt") && page.includes("onboardingDismissedAt"),
    "the dashboard should gate the tour on the server onboarding state",
  );
});

test("Local agent provisioning does not pin a per-turn timeout", () => {
  const provisioning = read("src/lib/hermes-provisioning.ts");
  assert.ok(
    !provisioning.includes("EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS"),
    "provisioning must not pin a turn timeout; the bridge default is unlimited",
  );
});

test("The Hermes image pull gets a generous timeout", () => {
  const docker = read("src/lib/docker.ts");
  assert.ok(docker.includes("IMAGE_PULL_TIMEOUT_MS"), "the pull timeout should be a named constant");
  assert.ok(/IMAGE_PULL_TIMEOUT_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(docker), "the pull timeout should be 30 minutes");
});

test("Company profile onboarding seeds the starter Knowledge & Rules scaffold", () => {
  const routePath = "src/app/api/onboarding/profile/route.ts";
  assert.ok(existsSync(resolve(root, routePath)), "the company profile route should exist");
  const route = read(routePath);
  assert.ok(route.includes("seedStarterKnowledge"), "the profile route should seed starter knowledge");
  assert.ok(route.includes("contextNotes"), "the profile route should persist company context");

  const starter = read("src/lib/starter-knowledge.ts");
  ["Company", "Agents", "Projects", "Customers"].forEach((folder) => {
    assert.ok(starter.includes(`"${folder}"`), `the scaffold should define the ${folder} folder`);
  });
});
