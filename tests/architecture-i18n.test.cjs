const assert = require("node:assert/strict");
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

/**
 * Agents never see translated text. Everything an agent, a runtime or bridge,
 * an MCP/OAuth client, a webhook or an email recipient reads is English and
 * must not depend on the UI's translation layer (next-intl, messages/*.json,
 * the request config, the UI formatters).
 */
const AGENT_FACING = [
    // MCP and agent instructions
    "src/lib/mcp-server",
    "src/app/mcp",
    "src/app/api/mcp",
    "src/lib/mcp.ts",
    "src/lib/emperor-manual.ts",
    "src/lib/agent-instructions.ts",
    "src/lib/rich-reply-guide.ts",
    // OAuth clients
    "src/app/api/oauth",
    "src/app/.well-known",
    "src/lib/oauth.ts",
    // Runtimes, hosts and bridges
    "src/app/api/runtime",
    "src/app/api/runtime-hosts",
    "src/app/api/runtime-host-jobs",
    "src/lib/runtime-hosts",
    "src/lib/openclaw",
    "src/lib/runtime-setup.ts",
    "src/lib/agent-runtime-tokens.ts",
    "src/lib/hermes-provisioning.ts",
    "src/lib/hermes-hiring-profile.ts",
    "src/lib/hire-hermes-agent.ts",
    // Webhooks and emails
    "src/app/api/webhook",
    "src/lib/email.ts",
    "src/lib/email-verification.ts",
];

const FORBIDDEN = [
    /from\s+["']next-intl(\/[^"']*)?["']/,
    /require\(\s*["']next-intl(\/[^"']*)?["']\s*\)/,
    /import\(\s*["']next-intl(\/[^"']*)?["']\s*\)/,
    /["'][^"']*messages\/(en|zh-CN)\.json["']/,
    /["']@\/i18n\/(request|load-messages|fallback)["']/,
    /["']@\/components\/(app-)?intl-provider["']/,
    /["']@\/i18n\/app-messages["']/,
    /["']@\/lib\/i18n\/format["']/,
];

function filesUnder(path) {
    const full = join(root, path);
    if (!existsSync(full)) return [];
    if (statSync(full).isFile()) return [full];
    return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
        const child = join(full, entry.name);
        if (entry.isDirectory()) return filesUnder(relative(root, child));
        return /\.(ts|tsx|js|cjs|mjs)$/.test(entry.name) ? [child] : [];
    });
}

test("agent-facing modules never import the translation layer", () => {
    const files = AGENT_FACING.flatMap(filesUnder);
    for (const path of AGENT_FACING) assert.ok(existsSync(join(root, path)), `${path} no longer exists: update AGENT_FACING`);
    assert.ok(files.length > 20, `expected to scan the agent-facing tree, found ${files.length} files`);
    const violations = [];
    for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN) {
            if (pattern.test(source)) violations.push(`${relative(root, file)} matches ${pattern}`);
        }
    }
    assert.deepEqual(violations, []);
});

test("the locale resolver stays dependency-free so any server path can share it", () => {
    const source = readFileSync(join(root, "src/i18n/config.ts"), "utf8");
    assert.equal(/^\s*import\s/m.test(source), false, "src/i18n/config.ts must not import anything");
});
