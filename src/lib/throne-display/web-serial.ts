// Browser-only Web Serial session for the Throne Display (Chrome / Edge on desktop).
// Line parsing and the protocol itself live in serial-protocol.ts (pure, unit-tested).
import {
    DISPLAY_BAUD_RATE,
    ESPRESSIF_USB_VENDOR_ID,
    parseDisplayLine,
    SerialLineBuffer,
    type DisplayEvent,
} from "./serial-protocol";

export function isWebSerialSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator && !!navigator.serial;
}

export function requestDisplayPort(): Promise<SerialPort> {
    return navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VENDOR_ID }] });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type LineListener = (event: DisplayEvent, raw: string) => void;

export class DisplaySerialSession {
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private readonly listeners = new Set<LineListener>();
    private readonly closeListeners = new Set<() => void>();
    private readonly lines = new SerialLineBuffer();
    private readLoop: Promise<void> | null = null;
    private closing = false;
    closed = false;

    private constructor(readonly port: SerialPort) {}

    /**
     * Opens the port at 115200 and immediately releases DTR and RTS. On the
     * ESP32-C3 USB-Serial/JTAG, RTS asserted with DTR released resets the chip, so
     * both are set low in one request to leave the running firmware alone.
     */
    static async open(port: SerialPort): Promise<DisplaySerialSession> {
        await port.open({ baudRate: DISPLAY_BAUD_RATE });
        try {
            await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        } catch {
            // Some drivers reject setSignals; the firmware still works without it.
        }
        const session = new DisplaySerialSession(port);
        session.start();
        return session;
    }

    private start() {
        const decoder = new TextDecoder();
        this.readLoop = (async () => {
            try {
                while (this.port.readable && !this.closing) {
                    this.reader = this.port.readable.getReader();
                    try {
                        for (;;) {
                            const { value, done } = await this.reader.read();
                            if (done) break;
                            if (value) this.dispatch(decoder.decode(value, { stream: true }));
                        }
                    } finally {
                        this.reader.releaseLock();
                        this.reader = null;
                    }
                }
            } catch {
                // Device lost (the board restarted or USB dropped).
            } finally {
                if (!this.closing) {
                    this.closed = true;
                    try {
                        await this.port.close();
                    } catch {
                        // already gone
                    }
                    for (const l of this.closeListeners) l();
                }
            }
        })();
    }

    private dispatch(text: string) {
        for (const raw of this.lines.push(text)) {
            const event = parseDisplayLine(raw);
            for (const l of this.listeners) l(event, raw);
        }
    }

    onEvent(listener: LineListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onClose(listener: () => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    /** Sends one command line. The caller must never log a provision command. */
    async send(line: string): Promise<void> {
        if (this.closed || !this.port.writable) throw new Error("The display is not connected.");
        const writer = this.port.writable.getWriter();
        try {
            await writer.write(new TextEncoder().encode(`${line}\n`));
        } finally {
            writer.releaseLock();
        }
    }

    /** Resolves with the first event `pick` maps to a value, or null on timeout / disconnect. */
    waitFor<T>(pick: (event: DisplayEvent) => T | undefined, timeoutMs: number): Promise<T | null> {
        return new Promise((resolve) => {
            let done = false;
            const finish = (value: T | null) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                offEvent();
                offClose();
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            const offEvent = this.onEvent((event) => {
                const v = pick(event);
                if (v !== undefined) finish(v);
            });
            const offClose = this.onClose(() => finish(null));
        });
    }

    /**
     * Asks for the firmware version. Returns the version, "unknown" for firmware
     * that predates the setup commands, or null when nothing answered.
     */
    async queryVersion(timeoutMs = 4000): Promise<string | null> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !this.closed) {
            const pending = this.waitFor((e) => (e.kind === "version" ? e.version : e.kind === "unknown_command" && e.command === "version" ? "unknown" : undefined), 1300);
            await this.send("version").catch(() => undefined);
            const v = await pending;
            if (v) return v;
        }
        return null;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closing = true;
        try {
            await this.reader?.cancel();
        } catch {
            // ignore
        }
        await this.readLoop?.catch(() => undefined);
        try {
            await this.port.close();
        } catch {
            // ignore
        }
        this.closed = true;
    }
}

/**
 * After the board restarts its USB device can disappear and come back as a new
 * port. Chrome keeps the permission, so poll the granted ports and reopen the
 * first Espressif one. Returns null on timeout (the page then asks the user to
 * pick the port again).
 */
export async function reconnectDisplay(timeoutMs: number, preferred?: SerialPort): Promise<DisplaySerialSession | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ports = await navigator.serial.getPorts();
        const candidates = ports.filter((p) => p.getInfo().usbVendorId === ESPRESSIF_USB_VENDOR_ID);
        if (preferred && !candidates.includes(preferred)) candidates.unshift(preferred);
        for (const port of candidates) {
            try {
                return await DisplaySerialSession.open(port);
            } catch {
                // Not back yet, or still held open elsewhere.
            }
        }
        await sleep(700);
    }
    return null;
}
