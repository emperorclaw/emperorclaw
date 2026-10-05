// Manifest for the Throne Display firmware served from /firmware/throne-display/.
// Written by scripts/build-display-firmware.ts, read by the browser installer.
// Pure (no node: imports) so the client bundle can use the parser.

export const FIRMWARE_BASE_PATH = "/firmware/throne-display";

export type FirmwarePartName = "bootloader" | "partitions" | "boot_app0" | "firmware";

/** ESP32-C3 flash layout for the huge_app.csv partition table. */
export const THRONE_FIRMWARE_LAYOUT: ReadonlyArray<{ name: FirmwarePartName; file: string; offset: number }> = [
    { name: "bootloader", file: "bootloader.bin", offset: 0x0 },
    { name: "partitions", file: "partitions.bin", offset: 0x8000 },
    { name: "boot_app0", file: "boot_app0.bin", offset: 0xe000 },
    { name: "firmware", file: "firmware.bin", offset: 0x10000 },
];

export type FirmwarePart = { name: FirmwarePartName; file: string; offset: number; size: number; sha256: string };

export type FirmwareManifest = {
    name: "throne-display";
    chip: "ESP32-C3";
    version: string;
    builtAt: string;
    /** Flash parameters written into the bootloader header (match platformio.ini). */
    flash: { mode: "dio"; freq: "80m"; size: "4MB" };
    parts: FirmwarePart[];
};

/** Reads `custom_fw_version` from platformio.ini: the one place the version is defined. */
export function readFirmwareVersion(platformioIni: string): string {
    const m = platformioIni.match(/^\s*custom_fw_version\s*=\s*([0-9A-Za-z.+-]+)\s*$/m);
    if (!m) throw new Error("custom_fw_version is missing from platformio.ini");
    return m[1];
}

export function buildFirmwareManifest(input: {
    version: string;
    builtAt: Date;
    parts: ReadonlyArray<{ name: FirmwarePartName; size: number; sha256: string }>;
}): FirmwareManifest {
    const parts = THRONE_FIRMWARE_LAYOUT.map((slot) => {
        const part = input.parts.find((p) => p.name === slot.name);
        if (!part) throw new Error(`missing firmware part: ${slot.name}`);
        if (!(part.size > 0)) throw new Error(`empty firmware part: ${slot.name}`);
        if (!/^[0-9a-f]{64}$/.test(part.sha256)) throw new Error(`bad sha256 for ${slot.name}`);
        return { ...slot, size: part.size, sha256: part.sha256 };
    });
    // Images must not overlap.
    for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1];
        if (prev.offset + prev.size > parts[i].offset) throw new Error(`${prev.name} overlaps ${parts[i].name}`);
    }
    return {
        name: "throne-display",
        chip: "ESP32-C3",
        version: input.version,
        builtAt: input.builtAt.toISOString(),
        flash: { mode: "dio", freq: "80m", size: "4MB" },
        parts,
    };
}

/** Validates a fetched manifest; returns null when it is not usable. */
export function parseFirmwareManifest(raw: unknown): FirmwareManifest | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (m.name !== "throne-display" || typeof m.version !== "string" || !m.version || !Array.isArray(m.parts)) return null;
    const parts: FirmwarePart[] = [];
    for (const slot of THRONE_FIRMWARE_LAYOUT) {
        const p = (m.parts as unknown[]).find((x) => !!x && typeof x === "object" && (x as Record<string, unknown>).name === slot.name) as
            | Record<string, unknown>
            | undefined;
        if (!p) return null;
        if (p.offset !== slot.offset || p.file !== slot.file) return null;
        if (typeof p.size !== "number" || p.size <= 0 || typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) return null;
        parts.push({ name: slot.name, file: slot.file, offset: slot.offset, size: p.size, sha256: p.sha256 });
    }
    return {
        name: "throne-display",
        chip: "ESP32-C3",
        version: m.version,
        builtAt: typeof m.builtAt === "string" ? m.builtAt : "",
        flash: { mode: "dio", freq: "80m", size: "4MB" },
        parts,
    };
}
