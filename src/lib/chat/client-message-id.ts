/** UUID request identity also works on self-hosted HTTP (randomUUID is HTTPS-only). */
export function newClientMessageId(source: { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => Uint8Array } | undefined = globalThis.crypto): string {
    if (source?.randomUUID) return source.randomUUID();
    const bytes = new Uint8Array(16);
    if (source?.getRandomValues) source.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    // Request IDs are uniqueness keys, never authentication credentials.
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
