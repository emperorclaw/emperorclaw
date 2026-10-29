import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CLOSE_HOST_REVOKED, HOST_PROTOCOL, parseHostFrame, redactHostText,
} from "../../src/lib/runtime-hosts/protocol";
import {
    CROCKFORD_ALPHABET, bearerToken, generateHostToken, generatePairingCode, hashHostToken, hashPairingCode, hostDisplayName,
    isHostTokenShape, normalizePairingCode,
} from "../../src/lib/runtime-hosts/pairing";
import {
    ALL_HOST_COMMANDS, ENABLED_HOST_COMMANDS, planHostCommand, redactJobArgs, validateCommandArgs,
} from "../../src/lib/runtime-hosts/commands";
import { JOB_STATUSES, MAX_JOB_ATTEMPTS, isTerminalJobStatus, jobEventSources, nextJobStatus } from "../../src/lib/runtime-hosts/job-state";
import { planAdoption, type AdoptionAgent } from "../../src/lib/runtime-hosts/adoption";
import { hermesInstallerUrl, hostConnectCommand, safeOrigin } from "../../src/lib/runtime-hosts/connect-command";
import { LATEST_HERMES_BRIDGE_VERSION } from "../../src/lib/hermes-bridge-version";
import { RUNTIME_HOST_COMMANDS, RUNTIME_HOST_JOB_STATUSES } from "../../src/db/schema";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const FP = "a".repeat(64);

// ── protocol ────────────────────────────────────────────────────────────────

test("protocol: a hello parses with defaults; unknown or malformed frames are null", () => {
    const hello = parseHostFrame(JSON.stringify({
        type: "hello", protocol: HOST_PROTOCOL, hostdVersion: "0.21.0", hostFingerprint: FP, hostname: "pc", os: "Linux", arch: "x86_64",
    }));
    assert.ok(hello && hello.type === "hello");
    assert.deepEqual(hello.jobs, []);
    assert.equal(parseHostFrame("not json"), null);
    assert.equal(parseHostFrame(JSON.stringify({ type: "shell", cmd: "rm -rf /" })), null);
    assert.equal(parseHostFrame(JSON.stringify({ type: "hello", protocol: 1, hostdVersion: "x", hostFingerprint: "short", hostname: "pc" })), null);
    assert.equal(CLOSE_HOST_REVOKED, 4401);
});

test("protocol: inventory keeps provider names only and validates profile names", () => {
    const inv = parseHostFrame(JSON.stringify({
        type: "inventory",
        resources: { cpus: 8, memTotalMiB: 16000, memAvailMiB: 9000, diskFreeMiB: 50000, load1: 0.4 },
        capabilities: { browser: true, linger: true, systemdUser: true },
        llmProviders: ["deepseek", "openai"],
        profiles: [{ profile: "viktor", agentId: UUID_A, sameEmperor: true, topology: "standalone", health: { registered: true } }],
    }));
    assert.ok(inv && inv.type === "inventory");
    assert.equal(inv.profiles[0].legacy, false);
    assert.equal(parseHostFrame(JSON.stringify({ type: "inventory", llmProviders: ["sk-abc DEEPSEEK_API_KEY=x"] })), null);
    assert.equal(parseHostFrame(JSON.stringify({ type: "inventory", profiles: [{ profile: "../etc" }] })), null);
    assert.equal(parseHostFrame(JSON.stringify({ type: "inventory", profiles: [{ profile: "a;rm" }] })), null);
});

test("protocol: ack, progress and result frames", () => {
    assert.ok(parseHostFrame(JSON.stringify({ type: "ack", jobId: UUID_A, accepted: false, reason: "busy" })));
    assert.ok(parseHostFrame(JSON.stringify({ type: "progress", jobId: UUID_A, seq: 1, step: "Restarting" })));
    assert.equal(parseHostFrame(JSON.stringify({ type: "progress", jobId: UUID_A, seq: 0 })), null);
    assert.ok(parseHostFrame(JSON.stringify({ type: "result", jobId: UUID_A, ok: true, exitCode: 0, summary: "done", logTail: "ok" })));
    assert.equal(parseHostFrame(JSON.stringify({ type: "result", jobId: "nope", ok: true })), null);
});

test("protocol: redactHostText removes tokens and keys", () => {
    const text = redactHostText(`token ech_${"a".repeat(64)} key sk-abcdef123456 Bearer abc.def.ghi DEEPSEEK_API_KEY=sk-zzz ec_${"b".repeat(48)}`)!;
    assert.ok(!text.includes("a".repeat(64)));
    assert.ok(!text.includes("sk-abcdef123456"));
    assert.ok(!text.includes("abc.def.ghi"));
    assert.ok(!text.includes("sk-zzz"));
    assert.ok(!text.includes("b".repeat(48)));
    assert.equal(redactHostText(null), null);
});

// ── pairing ─────────────────────────────────────────────────────────────────

test("pairing: codes are 8 Crockford characters shown XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) {
        const code = generatePairingCode();
        assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        for (const ch of code.replace("-", "")) assert.ok(CROCKFORD_ALPHABET.includes(ch));
        assert.equal(normalizePairingCode(code), code.replace("-", ""));
    }
});

test("pairing: normalization forgives case, dashes and look-alikes; hashes match", () => {
    assert.equal(normalizePairingCode("abcd-efgh"), "ABCDEFGH");
    assert.equal(normalizePairingCode(" 0o1l-ii23 "), "00111123");
    assert.equal(normalizePairingCode("ABCD-EFG"), null);
    assert.equal(normalizePairingCode("ABCD-EFGU"), null); // U is not Crockford
    assert.equal(normalizePairingCode(42), null);
    assert.equal(hashPairingCode("abcd-efgh"), hashPairingCode("ABCDEFGH"));
    assert.equal(hashPairingCode("bad"), null);
});

test("pairing: host tokens have their own prefix and are hashed", () => {
    const token = generateHostToken();
    assert.ok(isHostTokenShape(token));
    assert.ok(token.startsWith("ech_"));
    assert.ok(!isHostTokenShape(`ec_${"a".repeat(48)}`), "a company token is never a host token");
    assert.equal(hashHostToken(token).length, 64);
    assert.notEqual(hashHostToken(token), token);
    assert.equal(bearerToken(`Bearer ${token}`), token);
    assert.equal(bearerToken("Basic x"), null);
    assert.equal(bearerToken(undefined), null);
    assert.equal(hostDisplayName("malecu-hermes-1"), "malecu-hermes-1");
    assert.equal(hostDisplayName("<script>"), "script");
    assert.equal(hostDisplayName(""), "host");
});

// ── commands ────────────────────────────────────────────────────────────────

test("commands: the DB allowlist matches the code allowlist", () => {
    assert.deepEqual([...RUNTIME_HOST_COMMANDS].sort(), [...ALL_HOST_COMMANDS].sort());
    assert.deepEqual([...RUNTIME_HOST_JOB_STATUSES].sort(), [...JOB_STATUSES].sort());
});

test("commands: 0.22 queues restart, refresh, provision and remove only", () => {
    assert.deepEqual([...ENABLED_HOST_COMMANDS].sort(), ["provision_agent", "refresh_inventory", "remove_agent", "restart_agent"]);
    for (const command of ["update_runtime", "rotate_agent_token", "disconnect"]) {
        const plan = planHostCommand(command, {});
        assert.equal(plan.ok, false, `${command} is refused`);
        assert.match((plan as { error: string }).error, /not available/);
    }
    assert.equal(planHostCommand("rm", {}).ok, false);
    const plan = planHostCommand("restart_agent", { profile: "viktor" });
    assert.ok(plan.ok);
    assert.deepEqual(plan.args, { profile: "viktor", target: "bridge" }, "no topology, no idle policy: the host decides");
    assert.equal(plan.deadlineSec, 420, "idle wait (240 s) + restart + ready fit with margin");
});

test("commands: restart_agent rejects injection and unexpected arguments", () => {
    for (const profile of ["a;rm", "../x", "a b", "", "-rf", "$(id)", "x".repeat(65), "a\nb", "a`b`"]) {
        assert.equal(validateCommandArgs("restart_agent", { profile }).ok, false, `profile ${JSON.stringify(profile)} is refused`);
    }
    assert.equal(validateCommandArgs("restart_agent", { profile: "ok", target: "everything" }).ok, false);
    assert.equal(validateCommandArgs("restart_agent", { profile: "ok", url: "https://evil.example" }).ok, false);
    assert.equal(validateCommandArgs("restart_agent", { profile: "ok", argv: ["sh"] }).ok, false);
    assert.equal(validateCommandArgs("restart_agent", "profile=ok").ok, false);
    assert.equal(validateCommandArgs("refresh_inventory", { extra: 1 }).ok, false);
});

test("commands: the server never states a topology or idle policy; force only when chosen", () => {
    // Stale or unknown topology on the server side cannot reach the host: the fields do not exist.
    assert.equal(validateCommandArgs("restart_agent", { profile: "qa", target: "gateway", topology: "standalone" }).ok, false);
    assert.equal(validateCommandArgs("restart_agent", { profile: "qa", target: "gateway", whenIdle: false }).ok, false);
    const plain = validateCommandArgs("restart_agent", { profile: "qa", target: "gateway" });
    assert.ok(plain.ok);
    assert.deepEqual(plain.args, { profile: "qa", target: "gateway" }, "absent force = the host waits for idle on a shared gateway");
    const notForced = validateCommandArgs("restart_agent", { profile: "qa", target: "gateway", force: false });
    assert.ok(notForced.ok && !("force" in notForced.args), "force:false is dropped, never sent");
    const forced = validateCommandArgs("restart_agent", { profile: "qa", target: "gateway", force: true });
    assert.ok(forced.ok && forced.args.force === true);
    assert.equal(validateCommandArgs("restart_agent", { profile: "qa", force: "yes" }).ok, false);
});

test("socket limits: the frame token bucket allows a burst, then 20 frames a second", async () => {
    const { takeFrameToken } = await import("../../src/lib/runtime-hosts/socket-server");
    const ws: { tokens?: number; tokensAt?: number } = {};
    let allowed = 0;
    for (let i = 0; i < 150; i++) if (takeFrameToken(ws, 1000)) allowed++;
    assert.equal(allowed, 100, "burst of 100");
    assert.equal(takeFrameToken(ws, 1000), false);
    assert.equal(takeFrameToken(ws, 1100), true, "0.1 s later: 2 tokens back");
    assert.equal(takeFrameToken(ws, 1100), true);
    assert.equal(takeFrameToken(ws, 1100), false);
});

test("commands: future validators reject bad tokens, URLs and versions; args never store tokens", () => {
    const base = { profile: "p", agentId: UUID_A, agentName: "Viktor", apiToken: `ec_${"0".repeat(48)}`, gateway: "standalone", llmProvider: "deepseek" };
    assert.ok(validateCommandArgs("provision_agent", base).ok);
    assert.equal(validateCommandArgs("provision_agent", { ...base, apiToken: "ec_short" }).ok, false);
    assert.equal(validateCommandArgs("provision_agent", { ...base, agentName: 'x"; rm -rf ~' }).ok, false);
    assert.equal(validateCommandArgs("provision_agent", { ...base, apiUrl: "https://evil.example" }).ok, false);
    assert.equal(validateCommandArgs("update_runtime", { version: "0.22.0; curl evil" }).ok, false);
    assert.ok(validateCommandArgs("update_runtime", { version: "0.22.0" }).ok);
    assert.deepEqual(redactJobArgs({ profile: "p", apiToken: "ec_x", llmApiKey: "k", target: "bridge" }), { profile: "p", target: "bridge" });
});

// ── job state machine ───────────────────────────────────────────────────────

test("job state: the happy path", () => {
    assert.equal(nextJobStatus("queued", { type: "dispatch" }), "sent");
    assert.equal(nextJobStatus("sent", { type: "ack", accepted: true, attempts: 1 }), "running");
    assert.equal(nextJobStatus("running", { type: "result", ok: true }), "succeeded");
    assert.equal(nextJobStatus("running", { type: "result", ok: false }), "failed");
});

test("job state: busy and missing acks requeue until the attempts run out", () => {
    assert.equal(nextJobStatus("sent", { type: "ack", accepted: false, reason: "busy", attempts: 1 }), "queued");
    assert.equal(nextJobStatus("sent", { type: "ack", accepted: false, reason: "busy", attempts: MAX_JOB_ATTEMPTS }), "failed");
    assert.equal(nextJobStatus("sent", { type: "ack", accepted: false, reason: "invalid_args", attempts: 1 }), "failed");
    assert.equal(nextJobStatus("sent", { type: "ack_timeout", attempts: 1 }), "queued");
    assert.equal(nextJobStatus("sent", { type: "ack_timeout", attempts: 3 }), "failed");
    assert.equal(nextJobStatus("running", { type: "ack", accepted: false, reason: "busy", attempts: 1 }), null, "a late refusal never undoes a run");
});

test("job state: timeouts, loss, cancel; terminal states never move", () => {
    assert.equal(nextJobStatus("running", { type: "deadline" }), "timed_out");
    assert.equal(nextJobStatus("running", { type: "host_lost" }), "lost");
    assert.equal(nextJobStatus("running", { type: "unknown_to_host", attempts: 1 }), "lost");
    assert.equal(nextJobStatus("sent", { type: "unknown_to_host", attempts: 1 }), "queued");
    assert.equal(nextJobStatus("queued", { type: "cancel" }), "canceled");
    assert.equal(nextJobStatus("queued", { type: "result", ok: true }), null);
    for (const terminal of ["succeeded", "failed", "timed_out", "canceled", "lost"] as const) {
        assert.ok(isTerminalJobStatus(terminal));
        assert.equal(nextJobStatus(terminal, { type: "result", ok: true }), null, `${terminal} is final (a duplicate result is ignored)`);
        assert.equal(nextJobStatus(terminal, { type: "dispatch" }), null);
    }
    assert.deepEqual(jobEventSources({ type: "result", ok: true }), ["sent", "running"]);
});

// ── adoption ────────────────────────────────────────────────────────────────

function agentsMap(list: AdoptionAgent[]) {
    return new Map(list.map((a) => [a.id, a]));
}

test("adoption: same-company agents on this Emperor are adopted; others conflict", () => {
    const plan = planAdoption({
        hostId: "host-1", companyId: "co-1",
        profiles: [
            { profile: "viktor", agentId: UUID_A, sameEmperor: true, legacy: false },
            { profile: "foreign", agentId: UUID_B, sameEmperor: true, legacy: false },
            { profile: "elsewhere", agentId: UUID_C, sameEmperor: false, legacy: false },
            { profile: "old", agentId: UUID_C, sameEmperor: true, legacy: true },
            { profile: "blank", agentId: null, sameEmperor: true, legacy: false },
        ],
        agentsById: agentsMap([
            { id: UUID_A, companyId: "co-1", deleted: false, runtimeHostId: null, runtimeProfile: null },
            { id: UUID_B, companyId: "co-2", deleted: false, runtimeHostId: null, runtimeProfile: null },
        ]),
        currentlyOnHost: [],
    });
    assert.deepEqual(plan.adopt, [{ agentId: UUID_A, profile: "viktor" }]);
    assert.deepEqual(plan.conflicts.map((c) => [c.profile, c.reason]), [["foreign", "unknown_agent"], ["elsewhere", "other_emperor"]]);
    assert.deepEqual(plan.release, []);
});

test("adoption: an agent on another live host is not taken; a revoked host frees it", () => {
    const base = { hostId: "host-1", companyId: "co-1", profiles: [{ profile: "viktor", agentId: UUID_A, sameEmperor: true, legacy: false }], currentlyOnHost: [] };
    const taken = planAdoption({ ...base, agentsById: agentsMap([{ id: UUID_A, companyId: "co-1", deleted: false, runtimeHostId: "host-2", runtimeProfile: "viktor" }]) });
    assert.deepEqual(taken.adopt, []);
    assert.equal(taken.conflicts[0].reason, "other_host");
    const freed = planAdoption({ ...base, agentsById: agentsMap([{ id: UUID_A, companyId: "co-1", deleted: false, runtimeHostId: "host-2", runtimeProfile: "viktor", runtimeHostRevoked: true }]) });
    assert.deepEqual(freed.adopt, [{ agentId: UUID_A, profile: "viktor" }]);
});

test("adoption: unchanged agents are not rewritten, deleted ones conflict, gone profiles are released", () => {
    const plan = planAdoption({
        hostId: "host-1", companyId: "co-1",
        profiles: [
            { profile: "viktor", agentId: UUID_A, sameEmperor: true, legacy: false },
            { profile: "dup", agentId: UUID_A, sameEmperor: true, legacy: false },
            { profile: "ghost", agentId: UUID_B, sameEmperor: true, legacy: false },
        ],
        agentsById: agentsMap([
            { id: UUID_A, companyId: "co-1", deleted: false, runtimeHostId: "host-1", runtimeProfile: "viktor" },
            { id: UUID_B, companyId: "co-1", deleted: true, runtimeHostId: null, runtimeProfile: null },
        ]),
        currentlyOnHost: [{ id: UUID_A }, { id: UUID_C }],
    });
    assert.deepEqual(plan.adopt, []);
    assert.deepEqual(plan.served, [{ agentId: UUID_A, profile: "viktor" }]);
    assert.deepEqual(plan.conflicts.map((c) => c.reason), ["duplicate_profile", "unknown_agent"]);
    assert.deepEqual(plan.release, [UUID_C]);
});

// ── connect command ─────────────────────────────────────────────────────────

test("connect command: current bridge version, checksum verified, safe origin and code", () => {
    assert.equal(hermesInstallerUrl(), `https://github.com/emperorclaw/emperorclaw/releases/download/v${LATEST_HERMES_BRIDGE_VERSION}/emperor-hermes.sh`);
    const cmd = hostConnectCommand("https://emperor.example.com/settings?tab=x", "ABCD-EFGH");
    assert.ok(cmd.includes(`v${LATEST_HERMES_BRIDGE_VERSION}/emperor-hermes.sh.sha256`));
    assert.ok(cmd.includes("sha256sum -c emperor-hermes.sh.sha256"));
    assert.ok(cmd.endsWith("emperor-hermes host connect --url https://emperor.example.com ABCD-EFGH"));
    assert.ok(cmd.indexOf("sha256sum -c") < cmd.indexOf("host connect"));
    assert.equal(safeOrigin("javascript:alert(1)"), null);
    assert.ok(hostConnectCommand("https://x.example", "$(id)").endsWith("<code>"));
});

test("settings: Runtime hosts is an admin tab", async () => {
    const { settingsSections, resolveSettingsTab } = await import("../../src/lib/settings-navigation");
    const ids = (access: { isAdmin: boolean; instanceAdmin: boolean }) => settingsSections(access).flatMap((s) => s.items.map((i) => i.id as string));
    assert.ok(ids({ isAdmin: true, instanceAdmin: false }).includes("runtime-hosts"));
    assert.ok(!ids({ isAdmin: false, instanceAdmin: false }).includes("runtime-hosts"));
    assert.equal(resolveSettingsTab("runtime-hosts", { isAdmin: false, instanceAdmin: false }), "connections");
});

test("connect command: plain http needs --insecure unless localhost or a literal private address", async () => {
    const { originNeedsInsecure } = await import("../../src/lib/runtime-hosts/connect-command");
    for (const ok of ["https://emperor.example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://10.1.2.3", "http://172.16.0.9", "http://192.168.0.100:3000"]) {
        assert.equal(originNeedsInsecure(ok), false, ok);
    }
    for (const bad of ["http://emperor.example.com", "http://10.evil.com", "http://172.32.0.1", "http://8.8.8.8"]) {
        assert.equal(originNeedsInsecure(bad), true, bad);
    }
});
