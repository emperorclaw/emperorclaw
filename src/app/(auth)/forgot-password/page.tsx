"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { AuthBackground } from "@/components/auth-background";

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);
    const [error, setError] = useState("");

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setIsLoading(true);

        try {
            const res = await fetch("/api/auth/forgot-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            });

            if (res.ok) {
                setIsSuccess(true);
            } else {
                const data = await res.json();
                setError(data.error || "An error occurred");
            }
        } catch (err) {
            setError("Network error. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
            <AuthBackground />
            <div className="relative z-10 w-full max-w-md animate-in fade-in zoom-in-95 duration-500 mx-4">
                <div className="flex flex-col items-center mb-8">
                    <div className="w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30 mb-4 shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                        <Mail className="w-6 h-6 text-indigo-400" />
                    </div>
                    <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Reset Password</h2>
                    <p className="text-zinc-400 text-center">
                        Enter your email address and we'll send you a link to reset your password.
                    </p>
                </div>

                <div className="bg-zinc-950/80 backdrop-blur-xl border border-zinc-800/80 p-8 rounded-2xl shadow-2xl relative overflow-hidden">
                    {/* Decorative gradient orb */}
                    <div className="absolute -top-32 -right-32 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

                    {isSuccess ? (
                        <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                            <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center border border-emerald-500/30 mb-2 shadow-[0_0_30px_rgba(16,185,129,0.2)]">
                                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                            </div>
                            <h3 className="text-xl font-semibold text-zinc-100">Check your inbox</h3>
                            <p className="text-zinc-400 text-sm">
                                We've sent a password reset link to <strong>{email}</strong>.
                            </p>
                            <Link href="/login" className="w-full mt-6 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center">
                                <ArrowLeft className="w-4 h-4 mr-2" />
                                Back to Login
                            </Link>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-6 relative z-10">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-zinc-300 ml-1">Account Email</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Mail className="h-5 w-5 text-zinc-500" />
                                    </div>
                                    <input
                                        type="email"
                                        required
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="w-full pl-10 pr-4 py-3 bg-zinc-900/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-white placeholder-zinc-500 transition-all outline-none"
                                        placeholder="you@company.com"
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
                                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(79,70,229,0.3)] hover:shadow-[0_0_25px_rgba(79,70,229,0.5)]"
                            >
                                {isLoading ? "Sending Link..." : "Send Reset Link"}
                            </button>

                            <div className="text-center pt-2">
                                <Link href="/login" className="text-sm text-zinc-400 hover:text-indigo-400 transition-colors inline-flex items-center">
                                    <ArrowLeft className="w-4 h-4 mr-1" />
                                    Back to login
                                </Link>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
