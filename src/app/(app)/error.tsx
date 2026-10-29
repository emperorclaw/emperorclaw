"use client";

import { useEffect } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslations } from "next-intl";

export default function AppError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const t = useTranslations("errors");
    useEffect(() => {
        console.error("App route error:", error);
    }, [error]);

    return (
        <div className="flex h-screen items-center justify-center">
            <div className="emperor-panel max-w-md text-center space-y-4">
                <IconAlertTriangle className="mx-auto h-10 w-10 text-cyan-400" />
                <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">
                    {error.message || t("unexpected")}
                </p>
                <button
                    onClick={reset}
                    className="rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-300 hover:bg-cyan-400/10 transition-colors"
                >
                    {t("tryAgain")}
                </button>
            </div>
        </div>
    );
}
