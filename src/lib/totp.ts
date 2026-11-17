import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function generateTotpSecret(): string {
    const bytes = randomBytes(20);
    let bits = 0, value = 0, out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return out;
}
function decode(secret: string): Buffer {
    let bits = 0, value = 0;
    const bytes: number[] = [];
    for (const char of secret) {
        const n = ALPHABET.indexOf(char);
        if (n < 0) throw new Error("Invalid TOTP secret");
        value = (value << 5) | n; bits += 5;
        if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(bytes);
}
/** RFC 6238, SHA-1, six digits, 30-second steps. */
export function totpAt(secret: string, step: number, digits = 6): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac("sha1", decode(secret)).update(counter).digest();
    const offset = mac[mac.length - 1] & 15;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, "0");
}
export function matchingTotpStep(secret: string, code: string, lastStep = -1, now = Date.now()): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const step = Math.floor(now / 30_000);
    for (const candidate of [step, step - 1, step + 1]) {
        if (candidate <= lastStep || candidate < 0) continue;
        if (timingSafeEqual(Buffer.from(totpAt(secret, candidate)), Buffer.from(code))) return candidate;
    }
    return null;
}
export function recoveryHash(code: string): string {
    return createHash("sha256").update(code.trim().toLowerCase().replace(/-/g, "")).digest("hex");
}
export function generateRecoveryCodes(): string[] {
    return Array.from({ length: 10 }, () => randomBytes(10).toString("hex").match(/.{1,5}/g)!.join("-"));
}
