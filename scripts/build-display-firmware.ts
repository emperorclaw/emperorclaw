// Builds the Throne Display firmware with PlatformIO and publishes the four flash
// images plus manifest.json to public/firmware/throne-display/, where the
// Settings -> Displays installer downloads them.
//
//   npm run firmware:build                 build, then package
//   npm run firmware:build -- --skip-build package the existing .pio build output
//
// Environment:
//   PIO_BIN              path to the `pio` executable (default: `pio` on PATH)
//   PLATFORMIO_CORE_DIR  PlatformIO home (default: ~/.platformio), used to find boot_app0.bin
//   BOOT_APP0            explicit path to boot_app0.bin
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildFirmwareManifest, readFirmwareVersion, THRONE_FIRMWARE_LAYOUT, type FirmwarePartName } from "../src/lib/throne-display/firmware-manifest";

const root = resolve(__dirname, "..");
const projectDir = join(root, "devices", "throne-display");
const buildDir = join(projectDir, ".pio", "build", "throne");
const outDir = join(root, "public", "firmware", "throne-display");

function bootApp0Path(): string {
    if (process.env.BOOT_APP0) return process.env.BOOT_APP0;
    const core = process.env.PLATFORMIO_CORE_DIR || join(homedir(), ".platformio");
    return join(core, "packages", "framework-arduinoespressif32", "tools", "partitions", "boot_app0.bin");
}

function sourceFor(name: FirmwarePartName): string {
    switch (name) {
        case "boot_app0": return bootApp0Path();
        case "bootloader": return join(buildDir, "bootloader.bin");
        case "partitions": return join(buildDir, "partitions.bin");
        case "firmware": return join(buildDir, "firmware.bin");
    }
}

function main() {
    const version = readFirmwareVersion(readFileSync(join(projectDir, "platformio.ini"), "utf8"));

    if (!process.argv.includes("--skip-build")) {
        const pio = process.env.PIO_BIN || "pio";
        console.log(`[firmware] building ${version} with ${pio}`);
        const res = spawnSync(pio, ["run", "-d", projectDir, "-e", "throne"], { stdio: "inherit", shell: process.platform === "win32" });
        if (res.status !== 0) {
            console.error(`[firmware] PlatformIO build failed (exit ${res.status ?? res.error?.message}). Set PIO_BIN if pio is not on PATH.`);
            process.exit(1);
        }
    }

    mkdirSync(outDir, { recursive: true });
    const parts = THRONE_FIRMWARE_LAYOUT.map((slot) => {
        const src = sourceFor(slot.name);
        if (!existsSync(src)) {
            console.error(`[firmware] missing ${slot.name}: ${src}`);
            process.exit(1);
        }
        const data = readFileSync(src);
        writeFileSync(join(outDir, slot.file), data);
        return { name: slot.name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    });

    const manifest = buildFirmwareManifest({ version, builtAt: new Date(), parts });
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const p of manifest.parts) console.log(`[firmware] ${p.file.padEnd(15)} @ 0x${p.offset.toString(16).padStart(5, "0")}  ${p.size} bytes`);
    console.log(`[firmware] wrote ${join(outDir, "manifest.json")} (version ${version})`);
}

main();
