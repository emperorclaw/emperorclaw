// Pairing codes and host tokens (0.21). Pure: no DB.
//
// A pairing code is 8 Crockford base32 characters shown as XXXX-XXXX, valid
// for 10 minutes and usable once; only its sha256 is stored. Pairing returns
// a host token ("ech_" + 32 random bytes, hex); only its sha256 is stored, in
// runtime_hosts (never company_tokens, so it cannot authenticate MCP).

import { createHash, randomBytes, randomInt } from "node:crypto";

/** Crockford base32: no I, L, O or U, so a code read aloud cannot be mistyped into another. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const HOST_TOKEN_PREFIX = "ech_";
const HOST_TOKEN_RE = /^ech_[0-9a-f]{64}$/;

export function sha256Hex(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** A fresh code, formatted XXXX-XXXX. */
export function generatePairingCode(): string {
    let raw = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) raw += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
    return formatPairingCode(raw);
}

export function formatPairingCode(raw: string): string {
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * The canonical 8 characters of what a person typed: case-insensitive, dashes
 * and spaces ignored, and the Crockford look-alikes mapped (O->0, I/L->1).
 * Null when it cannot be a code.
 */
export function normalizePairingCode(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const cleaned = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    if (cleaned.length !== PAIRING_CODE_LENGTH) return null;
    for (const ch of cleaned) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
    return cleaned;
}

/** sha256 of the canonical code (what runtime_host_pairings.code_hash stores). */
export function hashPairingCode(code: string): string | null {
    const normalized = normalizePairingCode(code);
    return normalized ? sha256Hex(`pairing:${normalized}`) : null;
}

export function generateHostToken(): string {
    return `${HOST_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function isHostTokenShape(token: unknown): token is string {
    return typeof token === "string" && HOST_TOKEN_RE.test(token);
}

export function hashHostToken(token: string): string {
    return sha256Hex(token);
}

/** The bearer token of an Authorization header, or null. */
export function bearerToken(header: string | string[] | null | undefined): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith("Bearer ")) return null;
    const token = value.slice("Bearer ".length).trim();
    return token || null;
}

/** A host name for display: the hostname the daemon sent, clipped and printable. */
export function hostDisplayName(hostname: unknown): string {
    const text = typeof hostname === "string" ? hostname.replace(/[^\w.-]/g, "").slice(0, 63) : "";
    return text || "host";
}
