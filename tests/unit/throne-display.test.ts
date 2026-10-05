import { test } from "node:test";
import assert from "node:assert/strict";
import {
    advanceProvision,
    checkDisplayServer,
    encodeProvisionCommand,
    isPrivateNetworkHost,
    initialProvisionProgress,
    isFirmwareCurrent,
    MAX_COMMAND_LENGTH,
    mergeScanNetworks,
    parseDisplayLine,
    SerialLineBuffer,
    signalBars,
    type DisplayEvent,
    type ProvisionProgress,
} from "../../src/lib/throne-display/serial-protocol";
import {
    buildFirmwareManifest,
    parseFirmwareManifest,
    readFirmwareVersion,
    THRONE_FIRMWARE_LAYOUT,
} from "../../src/lib/throne-display/firmware-manifest";

const SHA = "a".repeat(64);

function decodeProvision(command: string) {
    assert.ok(command.startsWith("provision "));
    return JSON.parse(Buffer.from(command.slice("provision ".length), "base64").toString("utf8"));
}

test("line buffer joins chunks, strips CR and bounds runaway lines", () => {
    const b = new SerialLineBuffer(16);
    assert.deepEqual(b.push("[ver"), []);
    assert.deepEqual(b.push("sion] 1.1.0\r\n[scan] st"), ["[version] 1.1.0"]);
    assert.deepEqual(b.push("art\n"), ["[scan] start"]);
    assert.deepEqual(b.push("x".repeat(20)), ["x".repeat(20)]);
});

test("version comes from the version reply and the boot banner", () => {
    assert.deepEqual(parseDisplayLine("[version] 1.1.0"), { kind: "version", version: "1.1.0" });
    assert.deepEqual(parseDisplayLine("[boot] firmware 1.1.0\r"), { kind: "version", version: "1.1.0" });
    assert.equal(parseDisplayLine("[boot] ESP32-C3 rev 4 @ 160 MHz").kind, "other");
    assert.deepEqual(parseDisplayLine("[cmd] unknown 'version' (try 'help')"), { kind: "unknown_command", command: "version" });
    assert.deepEqual(parseDisplayLine("=== Emperor Claw Throne Display ==="), { kind: "boot" });
});

test("scan lines parse to networks; malformed JSON is ignored", () => {
    assert.deepEqual(parseDisplayLine('[scan] {"ssid":"Home \\"2G\\"","rssi":-61,"secure":true,"ch":6}'), {
        kind: "scan_network",
        network: { ssid: 'Home "2G"', rssi: -61, secure: true, channel: 6 },
    });
    assert.deepEqual(parseDisplayLine('[scan] {"ssid":"Cafe","rssi":-80,"secure":false}'), {
        kind: "scan_network",
        network: { ssid: "Cafe", rssi: -80, secure: false, channel: null },
    });
    assert.equal(parseDisplayLine("[scan] {not json").kind, "other");
    assert.equal(parseDisplayLine('[scan] {"ssid":"","rssi":-50}').kind, "other");
    assert.deepEqual(parseDisplayLine("[scan] done 7"), { kind: "scan_done", count: 7 });
    assert.deepEqual(parseDisplayLine("[scan] error busy"), { kind: "scan_error", reason: "busy" });
    assert.deepEqual(parseDisplayLine("[scan] start"), { kind: "scan_start" });
});

test("provision and network lines parse", () => {
    assert.deepEqual(parseDisplayLine("[prov] ok ssid='Home' server='https://e.example'"), { kind: "provision_ok" });
    assert.deepEqual(parseDisplayLine("[prov] restarting"), { kind: "provision_restarting" });
    assert.deepEqual(parseDisplayLine("[prov] error pass"), { kind: "provision_error", reason: "pass" });
    assert.deepEqual(parseDisplayLine("[net] connecting to Wi-Fi 'Home'"), { kind: "wifi_connecting" });
    assert.deepEqual(parseDisplayLine("[net] Wi-Fi connected, IP 192.168.1.40 RSSI -58"), { kind: "wifi_connected", ip: "192.168.1.40" });
    assert.deepEqual(parseDisplayLine("[net] wifi_fail wrong_password reason=15"), { kind: "wifi_failed", reason: "wrong_password" });
    assert.deepEqual(parseDisplayLine("[net] wifi_fail weird reason=99"), { kind: "wifi_failed", reason: "timeout" });
    assert.deepEqual(parseDisplayLine("[net] 200 in 640ms agents=7 msgs=8 dm=3 heap=46000 json=9000 low=37000 min=30000"), { kind: "fetch_ok" });
    assert.deepEqual(parseDisplayLine("[net] fetch failed code=401 (token rejected: needs a read_only company token) after 300ms, retry in 60s"), { kind: "fetch_failed", status: 401 });
    assert.deepEqual(parseDisplayLine("[net] fetch failed code=-1 (connection refused) after 3ms, retry in 8s"), { kind: "fetch_failed", status: -1 });
});

test("scan list keeps the strongest entry per SSID, strongest first", () => {
    const merged = mergeScanNetworks([
        { ssid: "B", rssi: -70, secure: true, channel: 1 },
        { ssid: "A", rssi: -80, secure: true, channel: 6 },
        { ssid: "A", rssi: -50, secure: true, channel: 11 },
        { ssid: "", rssi: -30, secure: false, channel: 3 },
    ]);
    assert.deepEqual(merged.map((n) => [n.ssid, n.rssi]), [["A", -50], ["B", -70]]);
    assert.deepEqual([-40, -60, -70, -90].map(signalBars), [4, 3, 2, 1]);
});

test("provision command round-trips UTF-8 and trims the server URL", () => {
    const enc = encodeProvisionCommand({ ssid: "Café 2.4", password: "pässword 1", server: " https://emperor.example.com/ ", token: "ec_abc" });
    assert.ok(enc.ok);
    if (!enc.ok) return;
    assert.ok(!/\s/.test(enc.command.slice("provision ".length)), "payload is a single token");
    assert.deepEqual(decodeProvision(enc.command), { v: 1, ssid: "Café 2.4", pass: "pässword 1", server: "https://emperor.example.com", token: "ec_abc" });
});

test("provision command enforces the firmware's limits", () => {
    const base = { ssid: "Home", password: "secret123", server: "https://e.example", token: "ec_x" };
    assert.equal(encodeProvisionCommand({ ...base, ssid: "" }).ok, false);
    assert.equal(encodeProvisionCommand({ ...base, ssid: "x".repeat(33) }).ok, false);
    assert.equal(encodeProvisionCommand({ ...base, ssid: "é".repeat(17) }).ok, false, "32-byte limit is in UTF-8 bytes");
    assert.equal(encodeProvisionCommand({ ...base, password: "short" }).ok, false);
    assert.equal(encodeProvisionCommand({ ...base, password: "" }).ok, true, "open network");
    assert.equal(encodeProvisionCommand({ ...base, password: "p".repeat(65) }).ok, false);
    assert.equal(encodeProvisionCommand({ ...base, server: "emperor.example" }).ok, false);
    assert.equal(encodeProvisionCommand({ ...base, server: `https://${"a".repeat(130)}` }).ok, false);
    assert.equal(encodeProvisionCommand({ ...base, token: "" }).ok, false);
    const longest = encodeProvisionCommand({ ssid: "s".repeat(32), password: "p".repeat(64), server: `https://${"a".repeat(119)}`, token: `ec_${"f".repeat(48)}` });
    assert.ok(longest.ok && longest.command.length <= MAX_COMMAND_LENGTH);
});

test("provision progress follows the board to live", () => {
    const steps: DisplayEvent[] = [
        { kind: "provision_ok" },
        { kind: "provision_restarting" },
        { kind: "boot" },
        { kind: "wifi_connecting" },
        { kind: "wifi_connected", ip: "10.0.0.2" },
        { kind: "fetch_failed", status: 502 },
        { kind: "fetch_ok" },
        { kind: "fetch_failed", status: 401 },
    ];
    const phases: ProvisionProgress["phase"][] = [];
    let s = initialProvisionProgress;
    for (const e of steps) {
        s = advanceProvision(s, e);
        phases.push(s.phase);
    }
    assert.deepEqual(phases, ["restarting", "restarting", "joining_wifi", "joining_wifi", "wifi_connected", "wifi_connected", "live", "live"]);
});

test("provision failures are precise, and Wi-Fi failures can recover", () => {
    const rejected = advanceProvision(initialProvisionProgress, { kind: "provision_error", reason: "pass" });
    assert.equal(rejected.failure, "rejected_config");
    assert.equal(rejected.detail, "pass");

    let s = advanceProvision(advanceProvision(initialProvisionProgress, { kind: "provision_ok" }), { kind: "wifi_failed", reason: "wrong_password" });
    assert.equal(s.phase, "failed");
    assert.equal(s.failure, "wrong_password");
    s = advanceProvision(s, { kind: "wifi_connected", ip: null });
    assert.equal(s.phase, "wifi_connected");
    assert.equal(s.failure, null);

    assert.equal(advanceProvision(initialProvisionProgress, { kind: "wifi_failed", reason: "no_network" }).failure, "no_network");
    assert.equal(advanceProvision(initialProvisionProgress, { kind: "wifi_failed", reason: "timeout" }).failure, "wifi_timeout");
    const token = advanceProvision(s, { kind: "fetch_failed", status: 403 });
    assert.equal(token.failure, "token_rejected");
    assert.equal(advanceProvision(token, { kind: "wifi_connected", ip: null }).failure, "token_rejected");
});

test("firmware is current only on an exact version match", () => {
    assert.equal(isFirmwareCurrent("1.1.0", "1.1.0"), true);
    assert.equal(isFirmwareCurrent("1.0.0", "1.1.0"), false);
    assert.equal(isFirmwareCurrent("unknown", "1.1.0"), false);
    assert.equal(isFirmwareCurrent(null, "1.1.0"), false);
});

test("firmware version is read from platformio.ini", () => {
    assert.equal(readFirmwareVersion("[env:throne]\ncustom_fw_version = 1.2.3\nbuild_flags =\n"), "1.2.3");
    assert.throws(() => readFirmwareVersion("[env:throne]\n"));
});

test("manifest lists the four images at the C3 offsets and round-trips", () => {
    const parts = THRONE_FIRMWARE_LAYOUT.map((p) => ({ name: p.name, size: p.name === "firmware" ? 1_200_000 : 3000, sha256: SHA }));
    const manifest = buildFirmwareManifest({ version: "1.1.0", builtAt: new Date("2026-01-01T00:00:00Z"), parts });
    assert.deepEqual(manifest.parts.map((p) => [p.file, p.offset]), [
        ["bootloader.bin", 0x0],
        ["partitions.bin", 0x8000],
        ["boot_app0.bin", 0xe000],
        ["firmware.bin", 0x10000],
    ]);
    assert.equal(manifest.builtAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(parseFirmwareManifest(JSON.parse(JSON.stringify(manifest))), manifest);
});

test("manifest rejects missing, overlapping or tampered parts", () => {
    const ok = THRONE_FIRMWARE_LAYOUT.map((p) => ({ name: p.name, size: 100, sha256: SHA }));
    assert.throws(() => buildFirmwareManifest({ version: "1", builtAt: new Date(), parts: ok.slice(1) }));
    assert.throws(() => buildFirmwareManifest({ version: "1", builtAt: new Date(), parts: ok.map((p) => (p.name === "bootloader" ? { ...p, size: 0x9000 } : p)) }));
    assert.throws(() => buildFirmwareManifest({ version: "1", builtAt: new Date(), parts: ok.map((p) => ({ ...p, sha256: "xyz" })) }));
    const good = buildFirmwareManifest({ version: "1", builtAt: new Date(), parts: ok });
    assert.equal(parseFirmwareManifest({ ...good, parts: good.parts.map((p) => (p.name === "firmware" ? { ...p, offset: 0 } : p)) }), null);
    assert.equal(parseFirmwareManifest({ ...good, version: "" }), null);
    assert.equal(parseFirmwareManifest(null), null);
});

test("the published firmware matches platformio.ini and its manifest", async () => {
    const { readFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "../..");
    const dir = resolve(root, "public/firmware/throne-display");
    const manifest = parseFirmwareManifest(JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")));
    assert.ok(manifest, "manifest.json is valid");
    const version = readFirmwareVersion(readFileSync(resolve(root, "devices/throne-display/platformio.ini"), "utf8"));
    assert.equal(manifest.version, version, "run `npm run firmware:build` after changing custom_fw_version");
    for (const part of manifest.parts) {
        const data = readFileSync(resolve(dir, part.file));
        assert.equal(data.length, part.size, `${part.file} size`);
        assert.equal(createHash("sha256").update(data).digest("hex"), part.sha256, `${part.file} sha256`);
    }
});

test("plain http is only allowed for private-network hosts", () => {
    for (const host of ["10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "brain.local", "NAS.LOCAL"]) {
        assert.equal(isPrivateNetworkHost(host), true, host);
    }
    for (const host of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "localhost", "127.0.0.1", "example.com", "local", "10.0.0.256", "evil.local.example.com"]) {
        assert.equal(isPrivateNetworkHost(host), false, host);
    }
    assert.deepEqual(checkDisplayServer("https://brain.malecu.eu"), { ok: true });
    assert.deepEqual(checkDisplayServer("http://192.168.1.20:3000"), { ok: true });
    assert.equal(checkDisplayServer("http://brain.malecu.eu").ok, false);
    assert.equal(checkDisplayServer("http://localhost:3000").ok, false);
    assert.equal(checkDisplayServer("https://user:pw@brain.malecu.eu").ok, false);
    assert.equal(checkDisplayServer("ftp://192.168.1.2").ok, false);
});

test("provisioning refuses to send the token over plain http to a public host", () => {
    const base = { ssid: "Home", password: "secret123", token: "ec_x" };
    const refused = encodeProvisionCommand({ ...base, server: "http://emperor.example.com" });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
        assert.equal(refused.field, "server");
        assert.match(refused.error, /https/);
    }
    assert.equal(encodeProvisionCommand({ ...base, server: "http://192.168.1.20:3000" }).ok, true);
    assert.equal(encodeProvisionCommand({ ...base, server: "https://emperor.example.com" }).ok, true);
});

test("the auth middleware exempts /firmware/ but not look-alike paths", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "../../src/proxy.ts"), "utf8");
    const matcher = JSON.parse(source.match(/matcher:\s*\[(".*")\]/)![1]) as string;
    const protectedPath = new RegExp(`^${matcher}$`);
    assert.equal(protectedPath.test("/firmware/throne-display/manifest.json"), false, "firmware is public");
    assert.equal(protectedPath.test("/firmware/throne-display/firmware.bin"), false);
    assert.equal(protectedPath.test("/firmwareX"), true, "look-alike stays protected");
    assert.equal(protectedPath.test("/firmware"), true);
    assert.equal(protectedPath.test("/settings"), true);
});
