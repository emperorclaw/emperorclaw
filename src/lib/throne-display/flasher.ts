// Browser-only firmware installer: downloads the images listed in manifest.json,
// checks their SHA-256 and writes them with esptool-js over Web Serial.
// esptool-js is loaded on demand so it never weighs on the Settings bundle.
import { FIRMWARE_BASE_PATH, parseFirmwareManifest, type FirmwareManifest } from "./firmware-manifest";

export async function fetchFirmwareManifest(): Promise<FirmwareManifest> {
    const res = await fetch(`${FIRMWARE_BASE_PATH}/manifest.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Firmware manifest not available (HTTP ${res.status}).`);
    const manifest = parseFirmwareManifest(await res.json());
    if (!manifest) throw new Error("The firmware manifest on this server is invalid.");
    return manifest;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function downloadFirmwareImages(manifest: FirmwareManifest): Promise<Uint8Array[]> {
    return Promise.all(
        manifest.parts.map(async (part) => {
            const res = await fetch(`${FIRMWARE_BASE_PATH}/${part.file}?v=${encodeURIComponent(manifest.version)}`);
            if (!res.ok) throw new Error(`Could not download ${part.file} (HTTP ${res.status}).`);
            const data = new Uint8Array(await res.arrayBuffer());
            if (data.length !== part.size || (await sha256Hex(data)) !== part.sha256) {
                throw new Error(`${part.file} failed its integrity check. Reload the page and try again.`);
            }
            return data;
        }),
    );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type FlashProgress = { percent: number; label: string };

/**
 * Writes the firmware (the port must be closed; esptool-js opens it), then
 * hard-resets the board into the new firmware and closes the port again.
 * Settings in NVS are untouched: only the four image regions are written.
 */
export async function flashDisplayFirmware(
    port: SerialPort,
    manifest: FirmwareManifest,
    images: Uint8Array[],
    onProgress: (p: FlashProgress) => void,
    onLog?: (line: string) => void,
): Promise<void> {
    const { ESPLoader, Transport } = await import("esptool-js");
    const transport = new Transport(port, false);
    const terminal = {
        clean: () => undefined,
        writeLine: (data: string) => onLog?.(data),
        write: (data: string) => onLog?.(data),
    };
    const loader = new ESPLoader({ transport, baudrate: 460800, romBaudrate: 115200, terminal });
    try {
        onProgress({ percent: 0, label: "Putting the display in update mode" });
        const chip = await loader.main("default_reset");
        if (!/ESP32-C3/i.test(chip)) throw new Error(`This is not a Throne Display board (found ${chip}).`);
        const total = manifest.parts.reduce((n, p) => n + p.size, 0);
        const before = manifest.parts.map((_, i) => manifest.parts.slice(0, i).reduce((n, p) => n + p.size, 0));
        await loader.writeFlash({
            fileArray: images.map((data, i) => ({ data, address: manifest.parts[i].offset })),
            flashMode: manifest.flash.mode,
            flashFreq: manifest.flash.freq,
            flashSize: manifest.flash.size,
            eraseAll: false,
            compress: true,
            reportProgress: (fileIndex, written, size) => {
                const done = before[fileIndex] + (written / Math.max(1, size)) * manifest.parts[fileIndex].size;
                onProgress({ percent: Math.min(100, Math.round((done / total) * 100)), label: `Writing ${manifest.parts[fileIndex].file}` });
            },
        });
        onProgress({ percent: 100, label: "Restarting the display" });
        // Hard reset over USB-Serial/JTAG: RTS high with DTR low resets, then release.
        await transport.setDTR(false);
        await transport.setRTS(true);
        await sleep(120);
        await transport.setRTS(false);
    } finally {
        await transport.disconnect().catch(() => undefined);
    }
}
