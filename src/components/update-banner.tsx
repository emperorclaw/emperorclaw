"use client";

import { useEffect, useState } from "react";
import { IconArrowUp, IconX, IconExternalLink } from "@tabler/icons-react";
import Link from "next/link";

const DISMISS_KEY = "emperor-update-banner-dismissed";

interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    isUpdateAvailable: boolean;
    publishedAt: string;
    downloadUrl: string;
}

export function UpdateBanner() {
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [dismissed, setDismissed] = useState(true);

    useEffect(() => {
        // Check if user previously dismissed this version
        const stored = localStorage.getItem(DISMISS_KEY);
        if (stored) {
            try {
                const data = JSON.parse(stored);
                // Only respect dismissals from the last 7 days
                if (Date.now() - data.ts < 7 * 24 * 60 * 60 * 1000) {
                    setDismissed(true);
                    // Still check in background for the Settings page
                } else {
                    setDismissed(false);
                }
            } catch {
                setDismissed(false);
            }
        } else {
            setDismissed(false);
        }

        let cancelled = false;
        const check = async () => {
            try {
                const res = await fetch("/api/updates/check");
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (!cancelled && data.isUpdateAvailable) {
                    setUpdate(data);
                    // Re-check dismissal against this specific version
                    const stored = localStorage.getItem(DISMISS_KEY);
                    if (stored) {
                        try {
                            const parsed = JSON.parse(stored);
                            if (parsed.version === data.latestVersion) {
                                return; // Still dismissed for this version
                            }
                        } catch { /* ignore */ }
                    }
                    setDismissed(false);
                }
            } catch { /* non-critical */ }
        };
        void check();
        return () => { cancelled = true; };
    }, []);

    const handleDismiss = () => {
        if (update) {
            localStorage.setItem(
                DISMISS_KEY,
                JSON.stringify({ version: update.latestVersion, ts: Date.now() }),
            );
        }
        setDismissed(true);
    };

    if (!update || !update.isUpdateAvailable || dismissed) return null;

    const publishedDate = update.publishedAt
        ? new Date(update.publishedAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
          })
        : "";

    return (
        <div className="mx-auto mb-4 flex w-full max-w-[1800px] items-center gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-400/8 px-4 py-3 sm:px-5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-cyan-400/15">
                <IconArrowUp className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-cyan-100">
                    EmperorClaw <span className="font-bold">{update.latestVersion}</span> is available
                    {" — "}
                    <span className="text-cyan-200/70">you&apos;re on v{update.currentVersion}</span>
                    {publishedDate && (
                        <span className="text-cyan-200/50"> · {publishedDate}</span>
                    )}
                </p>
            </div>
            <Link
                href="/settings?tab=updates"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-400/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-400/25"
            >
                View update
                <IconExternalLink className="h-3 w-3" />
            </Link>
            <button
                type="button"
                onClick={handleDismiss}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-cyan-300/50 transition-colors hover:bg-white/5 hover:text-cyan-200"
                aria-label="Dismiss update notification"
            >
                <IconX className="h-4 w-4" />
            </button>
        </div>
    );
}
