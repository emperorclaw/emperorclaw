// The one-liner a person pastes on a host to connect it (0.21). Client-safe
// (no Node imports): the Connect a host dialog and the agent setup guide use it.
//
// It downloads emperor-hermes.sh and its .sha256 for the CURRENT bridge
// version from the GitHub release, verifies the checksum, installs it as
// ~/.local/bin/emperor-hermes and runs `emperor-hermes host connect`.

import { LATEST_HERMES_BRIDGE_VERSION } from "@/lib/hermes-bridge-version";

export const HERMES_RELEASE_BASE = "https://github.com/emperorclaw/emperorclaw/releases/download";

/** The installer of a bridge release (default: the version this server ships with). */
export function hermesInstallerUrl(version: string = LATEST_HERMES_BRIDGE_VERSION): string {
    return `${HERMES_RELEASE_BASE}/v${version}/emperor-hermes.sh`;
}

/** Download + verify + install the installer (a subshell, so a failed check stops before anything runs). */
export function installerDownloadCommand(version: string = LATEST_HERMES_BRIDGE_VERSION): string {
    const url = hermesInstallerUrl(version);
    return [
        "(set -e; mkdir -p ~/.local/bin; cd ~/.local/bin",
        `curl -fsSLO ${url}`,
        `curl -fsSLO ${url}.sha256`,
        "sha256sum -c emperor-hermes.sh.sha256",
        "mv emperor-hermes.sh emperor-hermes; rm -f emperor-hermes.sh.sha256; chmod 755 emperor-hermes)",
    ].join("; ");
}

/** An origin safe to paste into a shell (http(s), host, optional port; nothing else). */
export function safeOrigin(origin: string): string | null {
    try {
        const url = new URL(origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (!/^[A-Za-z0-9.-]+$/.test(url.hostname) && !/^\[[0-9a-fA-F:]+\]$/.test(url.hostname)) return null;
        return url.origin;
    } catch {
        return null;
    }
}

/**
 * Plain http that `host connect` accepts without --insecure: localhost or a
 * LITERAL private address (10/8, 172.16/12, 192.168/16, 127/8, ::1). A name
 * like 10.evil.com is not one. https is always fine.
 */
export function originNeedsInsecure(origin: string): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    if (url.protocol !== "http:") return false;
    const host = url.hostname;
    if (host === "localhost" || host === "[::1]") return false;
    const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
    if (!m) return true;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return !(a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31));
}

/** The whole command for a pairing code. */
export function hostConnectCommand(origin: string, code: string, version: string = LATEST_HERMES_BRIDGE_VERSION): string {
    const url = safeOrigin(origin) ?? "<this-emperor-url>";
    const safeCode = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code) ? code : "<code>";
    return `${installerDownloadCommand(version)} && ~/.local/bin/emperor-hermes host connect --url ${url} ${safeCode}`;
}
