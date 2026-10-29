import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_HOST_MODEL, HERMES_PROFILE_ID_RE, HOST_LLM_PROVIDERS, LEGACY_HOST_COMMANDS, RESERVED_PROFILE_NAMES, hostCommandsFrom,
    isValidHostModel, planHostCommand, profileSlugForAgent, validateCommandArgs,
} from "../../src/lib/runtime-hosts/commands";
import { JOB_QUEUE_EXPIRY_MS, expiresInQueue, statusWhenHostLost } from "../../src/lib/runtime-hosts/job-state";
import { gatewayForNewAgent, hireReadiness, type HireHostFacts } from "../../src/lib/runtime-hosts/hire";
import { PROFILE_NAME_RE, parseHostFrame } from "../../src/lib/runtime-hosts/protocol";

/** Runtime hosts 0.22: hiring onto a host (provision_agent) and removing from it (remove_agent). Pure parts. */

const AGENT = "11111111-1111-4111-8111-111111111111";
const TOKEN = `ec_${"a".repeat(48)}`;
const queued = { profile: "growth-hacker", agentId: AGENT, agentName: "Growth Hacker", gateway: "standalone", llmProvider: "deepseek", model: "deepseek-chat", skipBrowser: true };

test("provision args: no token when queued (it is minted at dispatch), required when sent", () => {
    const plan = planHostCommand("provision_agent", queued);
    assert.ok(plan.ok);
    assert.equal(plan.deadlineSec, 1800);
    assert.ok(!("apiToken" in plan.args), "args_json never holds a token");
    const withToken = planHostCommand("provision_agent", { ...queued, apiToken: TOKEN });
    assert.equal(withToken.ok, false, "a token is refused at queue time");
    assert.match((withToken as { error: string }).error, /minted when the job is sent/);
    assert.equal(validateCommandArgs("provision_agent", queued, { stage: "dispatch" }).ok, false, "sent without a token: refused");
    const sent = validateCommandArgs("provision_agent", { ...queued, apiToken: TOKEN }, { stage: "dispatch" });
    assert.ok(sent.ok && sent.args.apiToken === TOKEN);
});

test("provision args: injection, URL overrides, odd providers and profile names are refused", () => {
    const bad: Record<string, unknown>[] = [
        { apiUrl: "https://evil.example" }, { emperorUrl: "https://evil.example" }, { env: { A: "1" } },
        { agentName: 'x"; rm -rf ~' }, { agentName: "$HOME" }, { agentName: "a`id`" }, { agentName: "x".repeat(81) },
        { profile: "Growth" }, { profile: "a.b" }, { profile: "default" }, { profile: "gateway" }, { profile: "../x" },
        { llmProvider: "custom" }, { llmProvider: "evil;rm" }, { model: "a b" }, { model: "x;rm" },
        { gateway: "both" }, { maxParallel: 9 }, { maxParallel: 1.5 }, { skipBrowser: "yes" }, { agentId: "nope" },
    ];
    for (const patch of bad) {
        assert.equal(planHostCommand("provision_agent", { ...queued, ...patch }).ok, false, JSON.stringify(patch));
    }
    const plan = planHostCommand("provision_agent", { ...queued, agentId: AGENT.toUpperCase(), maxParallel: 2 });
    assert.ok(plan.ok);
    assert.equal(plan.args.agentId, AGENT, "agent ids are normalised to lowercase");
    assert.equal(plan.args.maxParallel, 2);
    assert.ok(!("maxParallel" in (planHostCommand("provision_agent", queued) as { args: Record<string, unknown> }).args), "absent maxParallel stays absent");
});

test("remove args: profile, agent and purge only", () => {
    const plan = planHostCommand("remove_agent", { profile: "viktor", agentId: AGENT.toUpperCase(), purge: true });
    assert.ok(plan.ok);
    assert.deepEqual(plan.args, { profile: "viktor", agentId: AGENT, purge: true });
    assert.equal(plan.deadlineSec, 300);
    for (const patch of [{ purge: "yes" }, { profile: "a;rm" }, { agentId: "x" }, { force: true }, { apiToken: TOKEN }]) {
        assert.equal(planHostCommand("remove_agent", { profile: "viktor", agentId: AGENT, ...patch }).ok, false, JSON.stringify(patch));
    }
});

test("capability gating: a 0.21 daemon (no commands in hello) runs restart and refresh only", () => {
    assert.deepEqual(hostCommandsFrom(undefined), [...LEGACY_HOST_COMMANDS]);
    assert.deepEqual(hostCommandsFrom(null), [...LEGACY_HOST_COMMANDS]);
    const legacy = hostCommandsFrom(undefined);
    const refused = planHostCommand("provision_agent", queued, { hostCommands: legacy });
    assert.equal(refused.ok, false);
    assert.equal((refused as { status: number }).status, 409);
    assert.match((refused as { error: string }).error, /Update this host/);
    assert.ok(planHostCommand("restart_agent", { profile: "viktor" }, { hostCommands: legacy }).ok);
    const current = hostCommandsFrom(["provision_agent", "refresh_inventory", "remove_agent", "restart_agent", "rm_rf"]);
    assert.deepEqual([...current].sort(), ["provision_agent", "refresh_inventory", "remove_agent", "restart_agent"], "unknown names are ignored");
    assert.ok(planHostCommand("provision_agent", queued, { hostCommands: current }).ok);
});

test("protocol: hello carries the daemon's commands, a result the kept token's hash", () => {
    const hello = parseHostFrame(JSON.stringify({
        type: "hello", protocol: 1, hostdVersion: "0.22.0", hostFingerprint: "a".repeat(64), hostname: "pc",
        commands: ["provision_agent", "restart_agent"],
    }));
    assert.ok(hello && hello.type === "hello");
    assert.deepEqual(hello.commands, ["provision_agent", "restart_agent"]);
    const old = parseHostFrame(JSON.stringify({ type: "hello", protocol: 1, hostdVersion: "0.21.0", hostFingerprint: "a".repeat(64), hostname: "pc" }));
    assert.ok(old && old.type === "hello" && old.commands === undefined);
    const result = parseHostFrame(JSON.stringify({ type: "result", jobId: AGENT, ok: true, tokenSha256: "b".repeat(64) }));
    assert.ok(result && result.type === "result" && result.tokenSha256 === "b".repeat(64));
    assert.equal(parseHostFrame(JSON.stringify({ type: "result", jobId: AGENT, ok: true, tokenSha256: TOKEN })), null, "never a raw token");
});

test("profile slug: from the agent's name, Hermes-valid, never reserved, unique on the host", () => {
    assert.equal(profileSlugForAgent("Growth Hacker", []), "growth-hacker");
    assert.equal(profileSlugForAgent("Growth Hacker", ["growth-hacker"]), "growth-hacker-2");
    assert.equal(profileSlugForAgent("Growth Hacker", ["Growth-Hacker", "growth-hacker-2"]), "growth-hacker-3");
    assert.equal(profileSlugForAgent("Señor Ñoño", []), "senor-nono");
    assert.equal(profileSlugForAgent("QA", []), "qa");
    assert.equal(profileSlugForAgent("Default", []), "default-agent");
    assert.equal(profileSlugForAgent("Gateway", ["gateway-agent"]), "gateway-agent-2");
    assert.equal(profileSlugForAgent("!!!", []), "agent");
    assert.equal(profileSlugForAgent("_x_", []), "x");
    for (const name of ["Growth Hacker", "a".repeat(80), "日本語", "  ", "SEO / Ads (EU)", "test", "x--y--"]) {
        const slug = profileSlugForAgent(name, ["agent"]);
        assert.match(slug, HERMES_PROFILE_ID_RE, name);
        assert.match(slug, PROFILE_NAME_RE, name);
        assert.ok(!RESERVED_PROFILE_NAMES.has(slug), name);
        assert.ok(slug.length <= 44, name);
        assert.ok(planHostCommand("provision_agent", { ...queued, profile: slug }).ok, `${slug} is accepted by the validator`);
    }
});

test("models: every host provider has a valid default", () => {
    for (const provider of HOST_LLM_PROVIDERS) assert.ok(isValidHostModel(DEFAULT_HOST_MODEL[provider]), provider);
    assert.equal(isValidHostModel("a b"), false);
});

test("job states: a queued removal never expires and waits when its host is gone; other jobs do not", () => {
    assert.equal(expiresInQueue("remove_agent"), false);
    for (const command of ["restart_agent", "provision_agent", "refresh_inventory"]) assert.equal(expiresInQueue(command), true, command);
    assert.equal(statusWhenHostLost("remove_agent"), "queued");
    assert.equal(statusWhenHostLost("provision_agent"), "lost");
    assert.equal(JOB_QUEUE_EXPIRY_MS, 3_600_000);
});

const host = (patch: Partial<HireHostFacts> = {}): HireHostFacts => ({
    status: "online", revoked: false, commands: ["provision_agent", "refresh_inventory", "remove_agent", "restart_agent"],
    llmProviders: ["deepseek", "openrouter", "firecrawl"], memAvailMiB: 4000, browser: true,
    profiles: [{ topology: "standalone" }, { topology: "standalone" }], ...patch,
});

test("hire readiness: online, updated, a provider key and enough memory", () => {
    const ok = hireReadiness(host());
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.providers, ["openrouter", "deepseek"], "only providers a host can configure");
    assert.equal(ok.gateway, "standalone");
    assert.equal(ok.skipBrowser, false);
    assert.equal(hireReadiness(host({ browser: false })).skipBrowser, true);
    assert.equal(hireReadiness(host({ status: "offline" })).code, "offline");
    assert.equal(hireReadiness(host({ revoked: true })).code, "revoked");
    const legacy = hireReadiness(host({ commands: ["restart_agent", "refresh_inventory"] }));
    assert.equal(legacy.code, "update");
    assert.equal(legacy.reason, "Update this host to hire here");
    assert.equal(hireReadiness(host({ llmProviders: ["firecrawl"] })).code, "no_provider");
    const low = hireReadiness(host({ memAvailMiB: 300 }));
    assert.equal(low.code, "memory");
    assert.match(low.reason ?? "", /300 MB free/);
    assert.equal(hireReadiness(host({ memAvailMiB: null })).ok, true, "unknown memory does not block");
});

test("hire topology: shared only when every managed agent shares one gateway", () => {
    assert.equal(gatewayForNewAgent([]), "standalone");
    assert.equal(gatewayForNewAgent([{ topology: "shared" }, { topology: "shared" }, { topology: "standalone", legacy: true }]), "shared");
    assert.equal(gatewayForNewAgent([{ topology: "shared" }, { topology: "standalone" }]), "standalone");
    assert.equal(gatewayForNewAgent([{ topology: "unknown" }]), "standalone");
    const pi = hireReadiness(host({ profiles: [{ topology: "shared" }], memAvailMiB: 300 }));
    assert.equal(pi.gateway, "shared");
    assert.equal(pi.ok, true, "a shared gateway needs only its share (160 MB)");
});

test("review hardening: names with control or line-separator characters, and models starting with a dash, are refused", () => {
    for (const agentName of ["Growth EMPEROR_CLAW_API_URL=x", "a b", "a\u0085b", "a\u000bb", "a\u000cb", "a\u001cb", "a\u001eb", "a\u0000b", "a\u007fb", " lead", "trail "]) {
        assert.equal(planHostCommand("provision_agent", { ...queued, agentName }).ok, false, JSON.stringify(agentName));
    }
    for (const model of ["-x", "--help", ".hidden", "/abs", ":tag"]) {
        assert.equal(planHostCommand("provision_agent", { ...queued, model }).ok, false, model);
        assert.equal(isValidHostModel(model), false, model);
    }
    assert.ok(planHostCommand("provision_agent", { ...queued, agentName: "Señor Ñoño (EU)" }).ok);
});

test("hire readiness: memory promised to queued setups counts", () => {
    const busy = hireReadiness(host({ memAvailMiB: 1000, reservedMiB: 600 }));
    assert.equal(busy.code, "memory");
    assert.match(busy.reason ?? "", /setups already queued/);
    assert.equal(hireReadiness(host({ memAvailMiB: 1200, reservedMiB: 600 })).ok, true);
});
