"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { signIn } from "next-auth/react";
import { AuthBackground } from "@/components/auth-background";
import { CustomLogo } from "@/components/custom-logo";

export default function SignupPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [acceptBetaDisclaimer, setAcceptBetaDisclaimer] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedCompanyName = companyName.trim().replace(/\s+/g, " ");
    const passwordsMatch = password === confirmPassword;

    const validateClientInput = () => {
        if (!normalizedCompanyName || normalizedCompanyName.length < 2) {
            return "Enter a company name with at least 2 characters.";
        }
        if (!normalizedEmail) {
            return "Enter your work email.";
        }
        if (password.length < 8) {
            return "Password must be at least 8 characters.";
        }
        if (!passwordsMatch) {
            return "Passwords do not match.";
        }
        if (!acceptBetaDisclaimer) {
            return "You must acknowledge the beta data disclaimer.";
        }
        return "";
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        const validationError = validateClientInput();
        if (validationError) {
            setError(validationError);
            return;
        }

        setLoading(true);

        try {
            const res = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: normalizedEmail,
                    password,
                    companyName: normalizedCompanyName,
                    acceptBetaDisclaimer,
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to register");
            }

            const loginRes = await signIn("credentials", {
                redirect: false,
                email: normalizedEmail,
                password,
            });

            if (loginRes?.error) {
                throw new Error("Login failed after registration");
            }

            router.push("/");
            router.refresh();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
            <AuthBackground />

            <div className="relative z-10 w-full max-w-xl px-6 py-10">
                <div className="flex justify-center mb-8">
                    <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 backdrop-blur-md shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                        <CustomLogo className="w-8 h-8 text-indigo-400" />
                    </div>
                </div>

                <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]">
                    <div className="text-center mb-8">
                        <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">Create an account</h1>
                        <p className="text-zinc-500 text-sm mt-2">Set up your Emperor Claw workspace.</p>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {error && (
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm text-center">
                                {error}
                            </div>
                        )}

                        <div className="space-y-1">
                            <label className="text-sm font-medium text-zinc-400">Company Name</label>
                            <input
                                type="text"
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                required
                                minLength={2}
                                maxLength={120}
                                autoComplete="organization"
                                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="Acme Corp"
                            />
                        </div>

                        <div className="space-y-1">
                            <label className="text-sm font-medium text-zinc-400">Work Email</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                maxLength={254}
                                autoComplete="email"
                                inputMode="email"
                                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="name@acme.com"
                            />
                        </div>

                        <div className="space-y-1">
                            <label className="text-sm font-medium text-zinc-400">Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                minLength={8}
                                maxLength={128}
                                autoComplete="new-password"
                                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="........"
                            />
                            <p className="text-xs text-zinc-500">Use at least 8 characters.</p>
                        </div>

                        <div className="space-y-1">
                            <label className="text-sm font-medium text-zinc-400">Confirm Password</label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                minLength={8}
                                maxLength={128}
                                autoComplete="new-password"
                                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="........"
                            />
                            {confirmPassword && !passwordsMatch && (
                                <p className="text-xs text-amber-400">Passwords do not match yet.</p>
                            )}
                        </div>

                        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-sm text-zinc-300">
                            <div className="flex items-start gap-3">
                                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                                <div className="space-y-2">
                                    <p className="font-medium text-amber-200">Beta notice</p>
                                    <p className="text-zinc-300/90">
                                        Emperor Claw is still in beta. We do not guarantee safety, retention, recovery, or suitability of stored data.
                                        You are responsible for the data you place here.
                                    </p>
                                    <p className="text-zinc-400">
                                        Do not store critical secrets, regulated data, production-only credentials, or other information you cannot afford to expose, lose, or recreate.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-300">
                            <input
                                type="checkbox"
                                checked={acceptBetaDisclaimer}
                                onChange={(e) => setAcceptBetaDisclaimer(e.target.checked)}
                                className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500/50"
                                required
                            />
                            <span>
                                I understand this product is in beta, that I am responsible for the data I store here, and that I should not place critical or sensitive information in this workspace.
                            </span>
                        </label>

                        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3 text-xs text-zinc-500">
                            <div className="flex items-start gap-2">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                                <p>
                                    Create only one workspace per company unless you intentionally want separate isolated datasets and agent state.
                                </p>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading || Boolean(validateClientInput())}
                            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-lg flex items-center justify-center transition-colors disabled:opacity-50 mt-6"
                        >
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Create Workspace"}
                        </button>
                    </form>

                    <div className="mt-6 text-center text-sm text-zinc-500">
                        Already have an account?{" "}
                        <Link href="/login" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
                            Log in
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
