"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export default function AppError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("App route error:", error);
    }, [error]);

    return (
        <div className="flex h-screen items-center justify-center">
            <div className="emperor-panel max-w-md text-center space-y-4">
                <AlertTriangle className="mx-auto h-10 w-10 text-cyan-400" />
                <h1 className="text-lg font-semibold text-white">Something went wrong</h1>
                <p className="text-sm text-white/60">
                    {error.message || "An unexpected error occurred. Please try again."}
                </p>
                <button
                    onClick={reset}
                    className="rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-300 hover:bg-cyan-400/10 transition-colors"
                >
                    Try again
                </button>
            </div>
        </div>
    );
}
