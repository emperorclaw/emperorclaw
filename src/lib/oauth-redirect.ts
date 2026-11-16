// Which redirect_uris a dynamically registered OAuth client may use.
//
// https:// is always fine. Native CLI clients (Codex's `codex mcp login`,
// Claude Code) instead catch the code on a local listener such as
// http://127.0.0.1:53682/callback — RFC 8252 §7.3 and OAuth 2.1 allow plain
// http for loopback IP literals and `localhost`, since the code never leaves
// the machine. Anything else over http, and every other scheme, is refused.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function isAllowedRedirectUri(uri: unknown): boolean {
    if (typeof uri !== "string") return false;
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        return false;
    }
    // A fragment would carry the code somewhere the client may not read it (RFC 6749 §3.1.2).
    if (parsed.hash) return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}
