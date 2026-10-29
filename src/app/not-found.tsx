"use client";

// A client component, so the 404 page stays static (no server-side locale read).
import Link from "next/link";
import { IconFileUnknown } from "@tabler/icons-react";
import { useTranslations } from "next-intl";

export default function NotFound() {
    const t = useTranslations("errors");
    return (
        <div className="flex h-screen items-center justify-center bg-background">
            <div className="emperor-panel max-w-md space-y-4 rounded-2xl p-8 text-center">
                <IconFileUnknown className="mx-auto h-10 w-10 text-cyan-400" />
                <h1 className="text-lg font-semibold text-foreground">{t("notFoundTitle")}</h1>
                <p className="text-sm text-muted-foreground">
                    {t("notFoundBody")}
                </p>
                <Link
                    href="/"
                    className="inline-block rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-400 transition-colors hover:bg-cyan-400/10"
                >
                    {t("backToDashboard")}
                </Link>
            </div>
        </div>
    );
}
