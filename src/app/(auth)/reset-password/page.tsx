"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { KeyRound, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";
import { AuthBackground } from "@/components/auth-background";
import Link from "next/link";

function ResetPasswordForm() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const token = searchParams?.get("token");
    const email = searchParams?.get("email");

    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);
    const [error, setError] = useState("");

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        if (password.length < 8) {
            setError("Password must be at least 8 characters");
            return;
        }

        setIsLoading(true);

        try {
            const res = await fetch("/api/auth/reset-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, token, newPassword: password }),
            });

            if (res.ok) {
                setIsSuccess(true);
                setTimeout(() => {
                    router.push("/login");
                }, 3000);
            } else {
                const data = await res.json();
                setError(data.error || "An error occurred setting the new password");
            }
        } catch (err) {
            setError("Network error. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    if (!token || !email) {
        return (
            <div className="flex flex-col items-center justify-center p-8 text-center space-y-4">
                <AlertTriangle className="w-12 h-12 text-rose-500 mb-2" />
                <h3 className="text-xl font-semibold text-zinc-100">Invalid Reset Link</h3>
                <p className="text-zinc-400 text-sm">
                    This password reset link is invalid or malformed. Please request a new one.
                </p>
                <Link href="/forgot-password" className="mt-4 text-indigo-400 hover:text-indigo-300 underline underline-offset-4">
                    Request New Link
                </Link>
            </div>
        );
    }

    if (isSuccess) {
        return (
            <div className="flex flex-col items-center justify-center py-6 text-center space-y-4 relative z-10">
                <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center border border-emerald-500/30 mb-2 shadow-[0_0_30px_rgba(16,185,129,0.2)]">
                    <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                </div>
                <h3 className="text-xl font-semibold text-zinc-100">Password Reset Successful</h3>
                <p className="text-zinc-400 text-sm">
                    Your password has been securely updated. Redirecting you to login...
                </p>
                <Link href="/login" className="w-full mt-6 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center">
                    Proceed to Login <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-5 relative z-10">
            <div className="space-y-1.5 align-left text-left w-full">
                <p className="text-sm text-zinc-400 mb-4 bg-zinc-900 p-3 rounded-md border border-zinc-800 flex justify-between">
                    <span>Resetting for:</span>
                    <strong className="text-zinc-200">{email}</strong>
                </p>
            </div>

            <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300 ml-1">New Password</label>
                <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <KeyRound className="h-5 w-5 text-zinc-500" />
                    </div>
                    <input
                        type="password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 bg-zinc-900/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-white placeholder-zinc-500 transition-all outline-none"
                        placeholder="••••••••"
                    />
                </div>
            </div>

            <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300 ml-1">Confirm New Password</label>
                <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <KeyRound className="h-5 w-5 text-zinc-500" />
                    </div>
                    <input
                        type="password"
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 bg-zinc-900/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-white placeholder-zinc-500 transition-all outline-none"
                        placeholder="••••••••"
                    />
                </div>
            </div>

            {error && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-400 flex items-center">
                    <span className="mr-2">⚠️</span> {error}
                </div>
            )}

            <button
                type="submit"
                disabled={isLoading}
                className="w-full mt-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(79,70,229,0.3)] hover:shadow-[0_0_25px_rgba(79,70,229,0.5)]"
            >
                {isLoading ? "Updating..." : "Set New Password"}
            </button>
        </form>
    );
}

export default function ResetPasswordPage() {
    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
            <AuthBackground />
            <div className="relative z-10 w-full max-w-md animate-in fade-in zoom-in-95 duration-500 mx-4">
                <div className="flex flex-col items-center mb-8">
                    <div className="w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30 mb-4 shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                        <KeyRound className="w-6 h-6 text-indigo-400" />
                    </div>
                    <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Create New Password</h2>
                    <p className="text-zinc-400 text-center">
                        Secure your account with a strong new password.
                    </p>
                </div>

                <div className="bg-zinc-950/80 backdrop-blur-xl border border-zinc-800/80 p-8 rounded-2xl shadow-2xl relative overflow-hidden">
                    <div className="absolute -top-32 -left-32 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
                    <Suspense fallback={<div className="p-8 text-center text-zinc-500">Loading secure tunnel...</div>}>
                        <ResetPasswordForm />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}
