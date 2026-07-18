"use client";

import { useEffect } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";

export default function RootError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("Root route error:", error);
    }, [error]);

    return (
        <div className="flex h-screen items-center justify-center bg-zinc-950">
            <div className="emperor-panel max-w-md space-y-4 rounded-2xl p-8 text-center">
                <IconAlertTriangle className="mx-auto h-10 w-10 text-cyan-400" />
                <h1 className="text-lg font-semibold text-white">Something went wrong</h1>
                <p className="text-sm text-white/60">
                    {error.message || "An unexpected error occurred. Please try again."}
                </p>
                <button
                    onClick={reset}
                    className="cursor-pointer rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-300 transition-colors hover:bg-cyan-400/10"
                >
                    Try again
                </button>
            </div>
        </div>
    );
}
