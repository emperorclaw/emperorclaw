/**
 * Minimal dotted-version comparison for the update checker. Non-numeric parts
 * (e.g. pre-release suffixes) are treated as 0. Callers should strip a leading
 * "v" before calling.
 */
export function isVersionNewer(latest: string, current: string): boolean {
    const parse = (v: string) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
    const l = parse(latest);
    const c = parse(current);
    for (let i = 0; i < Math.max(l.length, c.length); i++) {
        const a = l[i] || 0;
        const b = c[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false;
}
