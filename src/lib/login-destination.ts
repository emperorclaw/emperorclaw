/** Preserve consent/deep-link destinations without creating an open redirect. */
export function loginDestination(callback: string | null, origin: string): string {
    if (!callback || /[\\\u0000-\u001f\u007f]/.test(callback)) return "/";
    try {
        const target = new URL(callback, origin);
        if (target.origin !== origin || target.username || target.password || !["https:", "http:"].includes(target.protocol)) return "/";
        if (target.pathname === "/login" || target.pathname === "/signup") return "/";
        return target.pathname + target.search + target.hash;
    } catch { return "/"; }
}
