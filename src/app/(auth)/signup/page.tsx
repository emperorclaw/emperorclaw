"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconAlertTriangle, IconLoader2, IconShieldX, IconMail, IconCircleCheck } from "@tabler/icons-react";
import { AuthBackground } from "@/components/auth-background";
import { useTranslations } from "next-intl";
import { CustomLogo } from "@/components/custom-logo";
import { useApiError } from "@/lib/i18n/use-api-error";

const INVITE_ROLES = ["admin", "member", "viewer"] as const;
const INVITE_FAILURES = ["expired", "consumed", "not_found", "email_mismatch"] as const;
type InviteFailure = (typeof INVITE_FAILURES)[number] | "invalid" | "checkFailed";

function SignupForm() {
    const t = useTranslations("auth.signup");
    const tRoles = useTranslations("settings.members.roles");
    const apiError = useApiError();
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
    // Kept as a code and rendered below, so the fetch effect does not depend on
    // the translator (PublicIntlProvider swaps messages after mount).
    const [inviteFailure, setInviteFailure] = useState<InviteFailure | null>(null);

    // Registration state
    const [regMode, setRegMode] = useState<"loading" | "bootstrap" | "invite-only" | "open" | "invited">(
        inviteParam ? "invited" : "loading"
    );
    // Whether SMTP is configured. When it isn't, accounts are auto-verified, so
    // we must not tell the user to check their email. Assume configured until we
    // learn otherwise (cloud default), then correct from register-state.
    const [emailConfigured, setEmailConfigured] = useState(true);

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
                        setInviteFailure(INVITE_FAILURES.find((r) => r === data.reason) ?? "invalid");
                        setRegMode("invite-only");
                    }
                })
                .catch(() => {
                    setInviteChecking(false);
                    setInviteValid(false);
                    setInviteFailure("checkFailed");
                    setRegMode("invite-only");
                });
        } else {
            // Determine registration state
            fetch("/api/auth/register-state")
                .then((res) => res.json())
                .then((data) => {
                    setEmailConfigured(data.emailConfigured !== false);
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
                return t("validation.companyName");
            }
            if (!acceptBetaDisclaimer) {
                return t("validation.disclaimer");
            }
        }
        if (!normalizedEmail) {
            return t("validation.email");
        }
        if (password.length < 8) {
            return t("validation.passwordLength");
        }
        if (!passwordsMatch) {
            return t("validation.passwordMismatch");
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
                throw new Error(apiError(data.error, t("registerFailed")));
            }

            const data = await res.json();
            // Go straight to login when no verification is needed:
            //  - bootstrap (first user is always auto-verified), or
            //  - SMTP not configured, so the account was auto-verified
            //    (emailVerificationRequired === false).
            if (data.instanceCreated || data.emailVerificationRequired === false) {
                router.push("/login?setup=complete");
            } else {
                // Verification email was sent — tell them to check their inbox.
                router.push(`/signup/check-email?email=${encodeURIComponent(normalizedEmail)}`);
            }
            router.refresh();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t("registrationFailed"));
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
                    <IconLoader2 className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
                    <p className="text-zinc-400 mt-4">{t("loading")}</p>
                </div>
            </div>
        );
    }

    // ── Invite-only blocked state ────────────────────────────────────────
    const inviteFailureText = inviteFailure === null ? ""
        : inviteFailure === "invalid" ? t("inviteInvalid")
            : inviteFailure === "checkFailed" ? t("inviteCheckFailed")
                : t(`inviteFailures.${inviteFailure}`);
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
                        <IconShieldX className="w-12 h-12 text-amber-400 mx-auto mb-4" />
                        <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight mb-3">{t("inviteOnlyTitle")}</h1>
                        <p className="text-zinc-400 text-sm mb-6">
                            {error || inviteFailureText || t("inviteOnlyBody")}
                        </p>
                        <Link
                            href="/login"
                            className="inline-flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 px-6 rounded-lg transition-colors"
                        >
                            {t("goToLogin")}
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    // ── Determine heading and fields based on state ──────────────────────
    const heading = regMode === "bootstrap"
        ? t("headingBootstrap")
        : regMode === "invited"
            ? t("headingInvited")
            : t("headingOpen");

    const inviteRole = INVITE_ROLES.find((role) => role === inviteInfo?.role);
    const roleLabel = inviteRole ? tRoles(inviteRole) : inviteInfo?.role ?? "";
    const subtitle = regMode === "bootstrap"
        ? t("subtitleBootstrap", { verify: emailConfigured ? "yes" : "no" })
        : regMode === "invited" && inviteInfo
            ? t("subtitleInvited", { company: inviteInfo.companyName, role: roleLabel })
            : t("subtitleOpen", { verify: emailConfigured ? "yes" : "no" });

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
                                <IconCircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-400" />
                                <div>
                                    <p className="font-medium text-indigo-200">
                                        {t("invitedTo", { company: inviteInfo?.companyName ?? "" })}
                                    </p>
                                    <p className="text-zinc-400 mt-1">
                                        {t("roleLabel")} <span className="text-zinc-300 font-medium">{roleLabel}</span>
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
                                <label htmlFor="signup-company" className="text-sm font-medium text-zinc-400">{t("companyName")}</label>
                                <input
                                    id="signup-company"
                                    type="text"
                                    value={companyName}
                                    onChange={(e) => setCompanyName(e.target.value)}
                                    required
                                    minLength={2}
                                    maxLength={120}
                                    autoComplete="organization"
                                    className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                    placeholder={t("companyPlaceholder")}
                                />
                            </div>
                        )}

                        <div className="space-y-1">
                            <label htmlFor="signup-email" className="text-sm font-medium text-zinc-400">{t("workEmail")}</label>
                            <input
                                id="signup-email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                maxLength={254}
                                autoComplete="email"
                                inputMode="email"
                                readOnly={!!showInviteBanner}
                                className={`w-full bg-zinc-950/50 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all ${showInviteBanner ? "opacity-60 cursor-not-allowed" : ""}`}
                                placeholder={t("emailPlaceholder")}
                            />
                        </div>

                        <div className="space-y-1">
                            <label htmlFor="signup-password" className="text-sm font-medium text-zinc-400">{t("password")}</label>
                            <input
                                id="signup-password"
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
                            <p className="text-xs text-zinc-500">{t("passwordHint")}</p>
                        </div>

                        <div className="space-y-1">
                            <label htmlFor="signup-confirm-password" className="text-sm font-medium text-zinc-400">{t("confirmPassword")}</label>
                            <input
                                id="signup-confirm-password"
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
                                <p className="text-xs text-amber-400">{t("passwordsDiffer")}</p>
                            )}
                        </div>

                        {showBetaDisclaimer && (
                            <>
                                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-sm text-zinc-300">
                                    <div className="flex items-start gap-3">
                                        <IconShieldX className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                                        <div className="space-y-2">
                                            <p className="font-medium text-amber-200">{t("betaTitle")}</p>
                                            <p className="text-zinc-300/90">
                                                {t("betaBody")}
                                            </p>
                                            <p className="text-zinc-400">
                                                {t("betaSecrets")}
                                            </p>
                                            <p className="text-zinc-500">
                                                {t("betaAuthorized")}
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
                                        {t("betaAccept")}
                                    </span>
                                </label>
                            </>
                        )}

                        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3 text-xs text-zinc-500">
                            <div className="flex items-start gap-2">
                                <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                                <p>
                                    {emailConfigured ? t("verificationNotice") : t("noEmailServer")}
                                    {showCompanyName && ` ${t("oneWorkspace")}`}
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
                            {loading ? <IconLoader2 className="w-5 h-5 animate-spin" /> : regMode === "bootstrap" ? t("submitBootstrap") : regMode === "invited" ? t("submitInvited") : t("submitOpen")}
                        </button>
                    </form>

                    <div className="mt-6 text-center text-sm text-zinc-500">
                        {t("haveAccount")}{" "}
                        <Link href="/login" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
                            {t("logIn")}
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SignupLoading() {
    const t = useTranslations("auth.signup");
    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden">
            <AuthBackground />
            <div className="relative z-10 w-full max-w-xl px-6 py-10 text-center">
                <IconLoader2 className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
                <p className="text-zinc-400 mt-4">{t("loading")}</p>
            </div>
        </div>
    );
}

export default function SignupPage() {
    return (
        <Suspense fallback={<SignupLoading />}>
            <SignupForm />
        </Suspense>
    );
}
