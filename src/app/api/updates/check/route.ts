import { NextResponse } from "next/server";
import pkg from "@/../package.json" assert { type: "json" };

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface GitHubRelease {
    tag_name: string;
    name: string;
    body: string;
    published_at: string;
    html_url: string;
}

let cached: {
    latestVersion: string;
    changelog: string;
    publishedAt: string;
    downloadUrl: string;
    fetchedAt: number;
} | null = null;

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function GET() {
    const currentVersion = pkg.version;

    // Serve from cache if fresh
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return NextResponse.json({
            currentVersion,
            latestVersion: cached.latestVersion,
            isUpdateAvailable: isNewer(cached.latestVersion, currentVersion),
            changelog: cached.changelog,
            publishedAt: cached.publishedAt,
            downloadUrl: cached.downloadUrl,
        });
    }

    try {
        const res = await fetch(
            "https://api.github.com/repos/emperorclaw/emperorclaw/releases/latest",
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "User-Agent": "emperorclaw-update-check/1.0",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                signal: AbortSignal.timeout(8000),
            },
        );

        if (!res.ok) {
            return NextResponse.json({
                currentVersion,
                latestVersion: currentVersion,
                isUpdateAvailable: false,
                error: `GitHub API returned ${res.status}`,
            });
        }

        const release: GitHubRelease = await res.json();
        const latestVersion = release.tag_name.replace(/^v/, "");

        cached = {
            latestVersion,
            changelog: release.body || "",
            publishedAt: release.published_at,
            downloadUrl: release.html_url,
            fetchedAt: Date.now(),
        };

        return NextResponse.json({
            currentVersion,
            latestVersion,
            isUpdateAvailable: isNewer(latestVersion, currentVersion),
            changelog: cached.changelog,
            publishedAt: cached.publishedAt,
            downloadUrl: cached.downloadUrl,
        });
    } catch {
        // Network error or timeout — don't bother the user
        return NextResponse.json({
            currentVersion,
            latestVersion: currentVersion,
            isUpdateAvailable: false,
            error: "Could not reach GitHub API",
        });
    }
}

function isNewer(latest: string, current: string): boolean {
    const parse = (v: string) =>
        v.split(".").map((n) => parseInt(n, 10) || 0);
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
