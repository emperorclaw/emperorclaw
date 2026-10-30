"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconAlertTriangle, IconCircleCheck, IconLoader2, IconMailCheck } from "@tabler/icons-react";
import { AuthBackground } from "@/components/auth-background";
import { useTranslations } from "next-intl";
import { CustomLogo } from "@/components/custom-logo";
import { useApiError } from "@/lib/i18n/use-api-error";

function VerifyEmailContent() {
    const t = useTranslations("auth.verify");
    const apiError = useApiError();
    const searchParams = useSearchParams();
    const email = searchParams?.get("email")?.trim().toLowerCase() || "";
    const token = searchParams?.get("token")?.trim() || "";
    const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
    // A server message, or one of ours (kept as a key so a language switch re-renders it).
    const [message, setMessage] = useState<{ text: string } | { key: "incomplete" | "invalid" | "verified" | "networkError" } | null>(null);
    const messageText = message === null ? t("verifying") : "text" in message ? apiError(message.text, message.text) : t(message.key);

    useEffect(() => {
        let cancelled = false;

        async function verifyEmail() {
            if (!email || !token) {
                if (!cancelled) {
                    setStatus("error");
                    setMessage({ key: "incomplete" });
                }
                return;
            }

            try {
                const res = await fetch("/api/auth/verify-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email, token }),
                });
                const data = await res.json();

                if (!cancelled) {
                    if (!res.ok) {
                        setStatus("error");
                        setMessage(data.error ? { text: data.error } : { key: "invalid" });
                        return;
                    }

                    setStatus("success");
                    setMessage(data.message ? { text: data.message } : { key: "verified" });
                }
            } catch {
                if (!cancelled) {
                    setStatus("error");
                    setMessage({ key: "networkError" });
                }
            }
        }

        void verifyEmail();

        return () => {
            cancelled = true;
        };
    }, [email, token]);

    if (status === "loading") {
        return (
            <div className="text-center space-y-4">
                <IconLoader2 className="mx-auto h-8 w-8 animate-spin text-indigo-400" />
                <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">{t("verifyingTitle")}</h1>
                <p className="text-sm text-zinc-500">{messageText}</p>
            </div>
        );
    }

    if (status === "success") {
        return (
            <div className="text-center space-y-4">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                    <IconCircleCheck className="h-7 w-7" />
                </div>
                <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">{t("activatedTitle")}</h1>
                <p className="text-sm text-zinc-400">{messageText}</p>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4 text-left text-sm text-zinc-400">
                    <p className="font-medium text-zinc-200">{t("beforeContinue")}</p>
                    <p className="mt-2">
                        {t("betaBody")}
                    </p>
                </div>
                <Link href="/login" className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-500">
                    {t("logIn")}
                </Link>
            </div>
        );
    }

    return (
        <div className="text-center space-y-4">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-500/20 bg-rose-500/10 text-rose-300">
                <IconAlertTriangle className="h-7 w-7" />
            </div>
            <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">{t("failedTitle")}</h1>
            <p className="text-sm text-zinc-400">{messageText}</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                <Link href={`/signup/check-email?email=${encodeURIComponent(email)}`} className="inline-flex items-center justify-center rounded-lg border border-zinc-700 px-5 py-3 font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900">
                    {t("resendActivation")}
                </Link>
                <Link href="/signup" className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-500">
                    {t("createAgain")}
                </Link>
            </div>
        </div>
    );
}

function VerifyLoading() {
    const t = useTranslations("auth.verify");
    return (
        <div className="text-center space-y-4">
            <IconMailCheck className="mx-auto h-8 w-8 text-indigo-400" />
            <p className="text-sm text-zinc-500">{t("loading")}</p>
        </div>
    );
}

export default function SignupVerifyPage() {
    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
            <AuthBackground />

            <div className="relative z-10 w-full max-w-xl px-6 py-10">
                <div className="flex justify-center mb-8">
                    <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 backdrop-blur-md shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                        <CustomLogo className="w-12 h-12 text-indigo-400" />
                    </div>
                </div>

                <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]">
                    <Suspense fallback={<VerifyLoading />}>
                        <VerifyEmailContent />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}
