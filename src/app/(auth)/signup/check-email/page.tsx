"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, Mail, RefreshCcw } from "lucide-react";
import { AuthBackground } from "@/components/auth-background";
import { CustomLogo } from "@/components/custom-logo";

function CheckEmailContent() {
    const searchParams = useSearchParams();
    const email = searchParams?.get("email")?.trim().toLowerCase() || "";
    const [isResending, setIsResending] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const handleResend = async () => {
        if (!email) {
            setError("Enter your email again from the signup page to request a new activation link.");
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
                throw new Error(data.error || "Failed to resend verification email.");
            }

            setMessage(data.message || "Verification email sent.");
        } catch (err: any) {
            setError(err.message || "Failed to resend verification email.");
        } finally {
            setIsResending(false);
        }
    };

    return (
        <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]">
            <div className="text-center mb-8">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                    <CheckCircle2 className="h-7 w-7" />
                </div>
                <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">Check your inbox</h1>
                <p className="text-zinc-500 text-sm mt-2">
                    We sent an activation link to {email ? <span className="text-zinc-300">{email}</span> : "your email address"}.
                </p>
            </div>

            <div className="space-y-4 text-sm text-zinc-300">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4">
                    <p className="font-medium text-zinc-100">Next step</p>
                    <p className="mt-2 text-zinc-400">
                        Open the verification email and click the activation link. The workspace stays locked until the address is confirmed.
                    </p>
                </div>

                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-zinc-300">
                    <p className="font-medium text-amber-200">Beta reminder</p>
                    <p className="mt-2 text-zinc-400">
                        Emperor Claw is beta software provided as-is. Do not store critical secrets, regulated data, or anything you cannot afford to expose, lose, or recreate.
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
                    {isResending ? <Loader2 className="h-5 w-5 animate-spin" /> : <><RefreshCcw className="mr-2 h-4 w-4" />Resend Activation Email</>}
                </button>

                <div className="flex items-center justify-between text-xs text-zinc-500">
                    <Link href="/signup" className="hover:text-zinc-300 transition-colors">
                        Use a different email
                    </Link>
                    <Link href="/login" className="hover:text-zinc-300 transition-colors">
                        Back to login
                    </Link>
                </div>
            </div>
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

                <Suspense fallback={
                    <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)] text-center text-zinc-400">
                        <Mail className="mx-auto mb-4 h-8 w-8 text-indigo-400" />
                        Loading activation details...
                    </div>
                }>
                    <CheckEmailContent />
                </Suspense>
            </div>
        </div>
    );
}
