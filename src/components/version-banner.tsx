"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { ArrowUpCircle, ExternalLink } from "lucide-react";

interface VersionInfo {
    version: string;
    name: string;
    repo: string;
}

interface GitHubRelease {
    tag_name: string;
    html_url: string;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LS_KEY = "emperorclaw_version_last_check";

function getLatestCheck(): number {
    try {
        return parseInt(localStorage.getItem(LS_KEY) || "0", 10);
    } catch {
        return 0;
    }
}

function setLatestCheck(ts: number) {
    try {
        localStorage.setItem(LS_KEY, String(ts));
    } catch {
        // localStorage unavailable
    }
}

export function VersionBanner() {
    const [banner, setBanner] = useState<{
        current: string;
        latest: string;
        url: string;
    } | null>(null);

    const checkForUpdate = useCallback(async () => {
        try {
            // 1. Get current version from our API
            const res = await fetch("/api/version");
            if (!res.ok) return;
            const current: VersionInfo = await res.json();
            if (!current.version) return;

            // 2. Check GitHub for the latest release (client-side, no token needed)
            const ghRes = await fetch(
                `https://api.github.com/repos/${current.repo}/releases/latest`,
                { headers: { Accept: "application/vnd.github+json" } },
            );
            if (!ghRes.ok) return;
            const latest: GitHubRelease = await ghRes.json();
            if (!latest.tag_name) return;

            // Normalize: strip leading 'v' if present
            const latestVer = latest.tag_name.replace(/^v/, "");
            const currentVer = current.version;

            if (latestVer !== currentVer) {
                setBanner({
                    current: currentVer,
                    latest: latestVer,
                    url: latest.html_url,
                });
            }
        } catch {
            // Silently ignore — version check is best-effort
        }
    }, []);

    useEffect(() => {
        const lastCheck = getLatestCheck();
        if (Date.now() - lastCheck > CHECK_INTERVAL_MS) {
            setLatestCheck(Date.now());
            checkForUpdate();
        }
    }, [checkForUpdate]);

    useEffect(() => {
        if (!banner) return;

        // Show a persistent toast with a link to the release
        toast(
            <div className="flex flex-col gap-1">
                <span className="font-semibold text-sm">
                    Update available: v{banner.latest}
                </span>
                <span className="text-xs text-muted-foreground">
                    You're running v{banner.current}. Run{" "}
                    <code className="bg-muted px-1 rounded text-[11px]">
                        ./install.sh --upgrade
                    </code>{" "}
                    to update.
                </span>
            </div>,
            {
                duration: Infinity,
                dismissible: true,
                icon: <ArrowUpCircle className="h-4 w-4 text-emerald-500" />,
                action: {
                    label: (
                        <span className="flex items-center gap-1">
                            Release notes <ExternalLink className="h-3 w-3" />
                        </span>
                    ),
                    onClick: () => window.open(banner.url, "_blank"),
                },
            },
        );
    }, [banner]);

    // This component renders nothing in the DOM — it only shows toasts
    return null;
}
