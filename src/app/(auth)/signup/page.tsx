"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Loader2, ShieldAlert, Mail, CheckCircle2 } from "lucide-react";
import { AuthBackground } from "@/components/auth-background";
import { CustomLogo } from "@/components/custom-logo";

function SignupForm() {
    const router = useRouter();
    const searchParams = useSearchParams();

    const inviteParam = searchParams.get("invite") || "";
    const emailParam = searchParams.get("email") || "";

    const [email, setEmail] = useState(emailParam);
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [acceptBetaDisclaimer, setAcceptBetaDisclaimer] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    // Invite validation state
    const [inviteValid, setInviteValid] = useState<boolean | null>(null);
    const [inviteInfo, setInviteInfo] = useState<{
        email: string;
        role: string;
        companyName: string;
    } | null>(null);
    const [inviteChecking, setInviteChecking] = useState(!!inviteParam);

    // Registration state
    const [regMode, setRegMode] = useState<"loading" | "bootstrap" | "invite-only" | "open" | "invited">(
        inviteParam ? "invited" : "loading"
    );

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedCompanyName = companyName.trim().replace(/\s+/g, " ");
    const passwordsMatch = password === confirmPassword;

    useEffect(() => {
        if (inviteParam) {
            // Validate invitation token
            const validateUrl = `/api/auth/validate-invite?token=${encodeURIComponent(inviteParam)}${emailParam ? `&email=${encodeURIComponent(emailParam)}` : ""}`;

            fetch(validateUrl)
                .then((res) => res.json())
                .then((data) => {
                    setInviteChecking(false);
                    if (data.valid) {
                        setInviteValid(true);
                        setInviteInfo({
                            email: data.email,
                            role: data.role,
                            companyName: data.companyName,
                        });
                        setEmail(data.email);
                        setRegMode("invited");
                    } else {
                        setInviteValid(false);
                        const reasonMessages: Record<string, string> = {
                            expired: "This invitation has expired. Please contact your administrator for a new one.",
                            consumed: "This invitation has already been used. Log in instead.",
                            not_found: "Invalid or expired invitation token.",
                            email_mismatch: "This invitation is for a different email address.",
                        };
                        setError(reasonMessages[data.reason] || "Invalid invitation.");
                        setRegMode("invite-only");
                    }
                })
                .catch(() => {
                    setInviteChecking(false);
                    setInviteValid(false);
                    setError("Could not validate the invitation. Please try again.");
                    setRegMode("invite-only");
                });
        } else {
            // Determine registration state
            fetch("/api/auth/register-state")
                .then((res) => res.json())
                .then((data) => {
                    if (data.isBootstrap) {
                        setRegMode("bootstrap");
                    } else if (data.registrationMode === "open") {
                        setRegMode("open");
                    } else {
                        setRegMode("invite-only");
                    }
                })
                .catch(() => {
                    // Default to bootstrap if the endpoint doesn't exist yet (cloud mode / fallback)
                    setRegMode("bootstrap");
                });
        }
    }, [inviteParam, emailParam]);

    const validateClientInput = () => {
        // In bootstrap mode, companyName is required
        if (regMode === "bootstrap") {
            if (!normalizedCompanyName || normalizedCompanyName.length < 2) {
                return "Enter a company name with at least 2 characters.";
            }
            if (!acceptBetaDisclaimer) {
                return "You must acknowledge the beta data disclaimer.";
            }
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
            const body: Record<string, unknown> = {
                email: normalizedEmail,
                password,
            };

            if (regMode === "bootstrap") {
                body.companyName = normalizedCompanyName;
                body.acceptBetaDisclaimer = acceptBetaDisclaimer;
            }

            // Include invite token if available
            if (inviteParam && inviteValid) {
                body.inviteToken = inviteParam;
            }

            const res = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to register");
            }

            const data = await res.json();
            // Bootstrap: first user is auto-verified, go straight to login
            if (data.instanceCreated) {
                router.push("/login?setup=complete");
            } else {
                // Invited/open signup: still needs email verification
                router.push(`/signup/check-email?email=${encodeURIComponent(normalizedEmail)}`);
            }
            router.refresh();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Registration failed");
        } finally {
            setLoading(false);
        }
    };

    // ── Loading state ────────────────────────────────────────────────────
    if (regMode === "loading" || inviteChecking) {
        return (
            <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
                <AuthBackground />
                <div className="relative z-10 w-full max-w-xl px-6 py-10 text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
                    <p className="text-zinc-400 mt-4">Loading...</p>
                </div>
            </div>
        );
    }

    // ── Invite-only blocked state ────────────────────────────────────────
    if (regMode === "invite-only" && !inviteValid) {
        return (
            <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
                <AuthBackground />
                <div className="relative z-10 w-full max-w-xl px-6 py-10">
                    <div className="flex justify-center mb-8">
                        <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 backdrop-blur-md shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                            <CustomLogo className="w-12 h-12 text-indigo-400" />
                        </div>
                    </div>
                    <div className="bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/80 p-8 rounded-3xl shadow-[0_8px_40px_rgba(0,0,0,0.4)] text-center">
                        <ShieldAlert className="w-12 h-12 text-amber-400 mx-auto mb-4" />
                        <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight mb-3">Invite-Only Instance</h1>
                        <p className="text-zinc-400 text-sm mb-6">
                            {error || "This instance is invite-only. Contact your administrator for an invitation."}
                        </p>
                        <Link
                            href="/login"
                            className="inline-flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 px-6 rounded-lg transition-colors"
                        >
                            Go to Login
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    // ── Determine heading and fields based on state ──────────────────────
    const heading = regMode === "bootstrap"
        ? "Set up your instance"
        : regMode === "invited"
            ? "Accept your invitation"
            : "Create an account";

    const subtitle = regMode === "bootstrap"
        ? "Set up your Emperor Claw workspace and verify your email to activate it."
        : regMode === "invited" && inviteInfo
            ? `You've been invited to join ${inviteInfo.companyName} as ${inviteInfo.role}.`
            : "Create your Emperor Claw account and verify your email to activate it.";

    const showCompanyName = regMode === "bootstrap";
    const showBetaDisclaimer = regMode === "bootstrap";
    const showInviteBanner = regMode === "invited" && inviteInfo;

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
                    <div className="text-center mb-8">
                        <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">{heading}</h1>
                        <p className="text-zinc-500 text-sm mt-2">{subtitle}</p>
                    </div>

                    {showInviteBanner && (
                        <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/8 p-4 text-sm text-zinc-300">
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-indigo-400" />
                                <div>
                                    <p className="font-medium text-indigo-200">
                                        Invited to join {inviteInfo?.companyName}
                                    </p>
                                    <p className="text-zinc-400 mt-1">
                                        Role: <span className="text-zinc-300 font-medium capitalize">{inviteInfo?.role}</span>
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {error && (
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm text-center">
                                {error}
                            </div>
                        )}

                        {showCompanyName && (
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
                        )}

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
                                readOnly={!!showInviteBanner}
                                className={`w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all ${showInviteBanner ? "opacity-60 cursor-not-allowed" : ""}`}
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

                        {showBetaDisclaimer && (
                            <>
                                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-sm text-zinc-300">
                                    <div className="flex items-start gap-3">
                                        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                                        <div className="space-y-2">
                                            <p className="font-medium text-amber-200">Beta notice</p>
                                            <p className="text-zinc-300/90">
                                                Emperor Claw is beta software provided as-is. We do not guarantee safety, retention, recovery, availability, or suitability of stored data or agent output.
                                                You are responsible for how the system is used and for the data you place here.
                                            </p>
                                            <p className="text-zinc-400">
                                                Do not store critical secrets, regulated data, production-only credentials, or other information you cannot afford to expose, lose, or recreate.
                                            </p>
                                            <p className="text-zinc-500">
                                                By creating a workspace, you confirm you are authorized to use this email address for the company you enter below.
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
                                        I understand this product is in beta, is provided without warranty, and that I am responsible for the data and operations I run inside this workspace.
                                    </span>
                                </label>
                            </>
                        )}

                        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3 text-xs text-zinc-500">
                            <div className="flex items-start gap-2">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                                <p>
                                    We will send a verification link to this email before the workspace can be used.
                                    {showCompanyName && " Create only one workspace per company unless you intentionally want separate isolated datasets and agent state."}
                                </p>
                            </div>
                        </div>

                        {/* Hidden invite token field — populated from URL query param */}
                        {inviteParam && (
                            <input type="hidden" name="inviteToken" value={inviteParam} />
                        )}

                        <button
                            type="submit"
                            disabled={loading || Boolean(validateClientInput())}
                            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-lg flex items-center justify-center transition-colors disabled:opacity-50 mt-6"
                        >
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : regMode === "bootstrap" ? "Create Workspace" : regMode === "invited" ? "Accept Invitation" : "Create Account"}
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

export default function SignupPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
                <AuthBackground />
                <div className="relative z-10 w-full max-w-xl px-6 py-10 text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
                    <p className="text-zinc-400 mt-4">Loading...</p>
                </div>
            </div>
        }>
            <SignupForm />
        </Suspense>
    );
}
