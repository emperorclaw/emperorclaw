"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconCircleCheck, IconLoader2, IconMail, IconRefresh } from "@tabler/icons-react";
import { AuthBackground } from "@/components/auth-background";
import { useTranslations } from "next-intl";
import { CustomLogo } from "@/components/custom-logo";
import { useApiError } from "@/lib/i18n/use-api-error";

function CheckEmailContent() {
    const t = useTranslations("auth.checkEmail");
    const apiError = useApiError();
    const searchParams = useSearchParams();
    const email = searchParams?.get("email")?.trim().toLowerCase() || "";
    const [isResending, setIsResending] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const handleResend = async () => {
        if (!email) {
            setError(t("noEmail"));
            return;
        }

        setIsResending(true);
        setError("");
        setMessage("");

        try {
            const res = await fetch("/api/auth/resend-verification", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(apiError(data.error, t("resendFailed")));
            }

            setMessage(data.message || t("resent"));
        } catch (err: any) {
            setError(err.message || t("resendFailed"));
        } finally {
            setIsResending(false);
        }
    };

    return (
        <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]">
            <div className="text-center mb-8">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                    <IconCircleCheck className="h-7 w-7" />
                </div>
                <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">{t("title")}</h1>
                <p className="text-zinc-500 text-sm mt-2">
                    {email
                        ? t.rich("sentTo", { email, address: (chunks) => <span className="text-zinc-300">{chunks}</span> })
                        : t("sentToYou")}
                </p>
            </div>

            <div className="space-y-4 text-sm text-zinc-300">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4">
                    <p className="font-medium text-zinc-100">{t("nextStep")}</p>
                    <p className="mt-2 text-zinc-400">
                        {t("nextStepBody")}
                    </p>
                </div>

                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-zinc-300">
                    <p className="font-medium text-amber-200">{t("betaTitle")}</p>
                    <p className="mt-2 text-zinc-400">
                        {t("betaBody")}
                    </p>
                </div>

                {message && (
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-emerald-300">
                        {message}
                    </div>
                )}

                {error && (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-rose-300">
                        {error}
                    </div>
                )}

                <button
                    type="button"
                    onClick={handleResend}
                    disabled={isResending}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-lg flex items-center justify-center transition-colors disabled:opacity-50"
                >
                    {isResending ? <IconLoader2 className="h-5 w-5 animate-spin" /> : <><IconRefresh className="mr-2 h-4 w-4" />{t("resend")}</>}
                </button>

                <div className="flex items-center justify-between text-xs text-zinc-500">
                    <Link href="/signup" className="hover:text-zinc-300 transition-colors">
                        {t("differentEmail")}
                    </Link>
                    <Link href="/login" className="hover:text-zinc-300 transition-colors">
                        {t("backToLogin")}
                    </Link>
                </div>
            </div>
        </div>
    );
}

function CheckEmailLoading() {
    const t = useTranslations("auth.checkEmail");
    return (
        <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)] text-center text-zinc-400">
            <IconMail className="mx-auto mb-4 h-8 w-8 text-indigo-400" />
            {t("loading")}
        </div>
    );
}

export default function SignupCheckEmailPage() {
    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
            <AuthBackground />

            <div className="relative z-10 w-full max-w-xl px-6 py-10">
                <div className="flex justify-center mb-8">
                    <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 backdrop-blur-md shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                        <CustomLogo className="w-12 h-12 text-indigo-400" />
                    </div>
                </div>

                <Suspense fallback={<CheckEmailLoading />}>
                    <CheckEmailContent />
                </Suspense>
            </div>
        </div>
    );
}
