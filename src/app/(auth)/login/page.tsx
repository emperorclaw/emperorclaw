"use client";

import { useState, useRef, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconLoader2, IconArrowRight, IconShield, IconCpu } from "@tabler/icons-react";
import { AuthBackground } from "@/components/auth-background";
import { CustomLogo } from "@/components/custom-logo";

function FadeUp({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
    return (
        <div
            className={className}
            style={{ animation: `fadeUp 0.8s ${delay}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
        >
            {children}
        </div>
    );
}

const stagger = { emblem: 0, title: 0.15, subtitle: 0.2, email: 0.25, password: 0.3, button: 0.35, footer: 0.4 };

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [focused, setFocused] = useState<"email" | "password" | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const card = cardRef.current;
        if (!card) return;
        const onMove = (e: MouseEvent) => {
            const rect = card.getBoundingClientRect();
            card.style.setProperty("--mx", `${((e.clientX - rect.left) / rect.width) * 100}%`);
            card.style.setProperty("--my", `${((e.clientY - rect.top) / rect.height) * 100}%`);
        };
        window.addEventListener("mousemove", onMove);
        return () => window.removeEventListener("mousemove", onMove);
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        const normalizedEmail = email.trim().toLowerCase();
        const res = await signIn("credentials", { redirect: false, email: normalizedEmail, password });
        setLoading(false);
        if (res?.error) {
            if (res.error === "EMAIL_NOT_VERIFIED") {
                setError("Verify your email before logging in. We sent an activation link during signup.");
                return;
            }
            setError("Invalid email or password");
        } else {
            router.push("/");
            router.refresh();
        }
    };

    const inputClass = (name: "email" | "password") =>
        `relative rounded-xl border transition-all duration-500 bg-white/[0.03] ${
            focused === name
                ? "border-cyan-400/50 shadow-[0_0_25px_rgba(6,182,212,0.08),0_0_0_1px_rgba(6,182,212,0.1)]"
                : "border-white/[0.08] hover:border-white/[0.14]"
        }`;

    return (
        <div className="min-h-screen flex flex-col justify-center items-center relative overflow-hidden selection:bg-cyan-500/30 font-sans">
            <AuthBackground />
            <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent z-10" />

            <div className="relative z-10 w-full max-w-[440px] px-6">
                {/* Emblem */}
                <FadeUp delay={stagger.emblem} className="flex justify-center mb-8">
                    <div className="relative">
                        <div className="absolute inset-[-24px] rounded-full bg-cyan-500/8 blur-2xl animate-[pulse_4s_ease-in-out_infinite]" />
                        <div className="absolute inset-[-48px] rounded-full bg-gradient-to-br from-cyan-500/4 to-amber-500/3 blur-3xl animate-[pulse_7s_ease-in-out_infinite_1s]" />
                        <div className="absolute inset-[-8px] rounded-full border border-cyan-500/15" style={{ animation: "spin 25s linear infinite" }} />
                        <div className="absolute inset-[-20px] rounded-full border border-cyan-500/8" style={{ animation: "spin 35s linear infinite reverse" }} />
                        <div className="relative w-[108px] h-[108px] rounded-2xl bg-gradient-to-br from-cyan-500/8 via-cyan-500/3 to-transparent flex items-center justify-center border border-cyan-400/15 backdrop-blur-2xl shadow-[0_0_80px_rgba(6,182,212,0.12),inset_0_1px_0_rgba(255,255,255,0.04)]">
                            <div className="absolute inset-0 rounded-2xl bg-gradient-to-t from-cyan-500/5 to-transparent" />
                            <CustomLogo className="relative w-[54px] h-[54px] drop-shadow-[0_0_20px_rgba(6,182,212,0.4)]" />
                        </div>
                    </div>
                </FadeUp>

                {/* Card */}
                <FadeUp delay={stagger.title}>
                    <div
                        ref={cardRef}
                        className="relative rounded-2xl overflow-hidden"
                        style={{
                            background: "radial-gradient(circle at var(--mx, 50%) var(--my, 50%), rgba(6,182,212,0.05) 0%, transparent 45%), linear-gradient(180deg, rgba(9,9,11,0.5) 0%, rgba(9,9,11,0.35) 100%)",
                            backdropFilter: "blur(40px)",
                            WebkitBackdropFilter: "blur(40px)",
                            boxShadow: "0 30px 80px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.04) inset, 0 0 0 1px rgba(255,255,255,0.02)",
                        }}
                    >
                        <div className="absolute inset-0 rounded-2xl pointer-events-none ring-1 ring-inset ring-cyan-400/20" />

                        <div className="relative p-8">
                            <div className="text-center mb-7">
                                <h1 className="text-[26px] font-light text-white tracking-[-0.02em]">Welcome back</h1>
                                <p className="text-zinc-300 text-sm mt-2 font-light tracking-wide">Command your AI workforce</p>
                            </div>

                            <form onSubmit={handleSubmit} className="space-y-4">
                                {error && (
                                    <div className="p-3 bg-red-500/8 border border-red-500/15 rounded-xl text-red-400 text-sm text-center backdrop-blur-sm" style={{ animation: "fadeUp 0.3s ease-out both" }}>
                                        {error}
                                    </div>
                                )}

                                {/* Email */}
                                <FadeUp delay={stagger.email}>
                                    <div className="space-y-1.5">
                                        <label className="text-[11px] font-medium uppercase tracking-[0.15em] text-zinc-300">Email</label>
                                        <div className={inputClass("email")}>
                                            <input
                                                type="email" value={email} required
                                                onChange={(e) => setEmail(e.target.value)}
                                                onFocus={() => setFocused("email")} onBlur={() => setFocused(null)}
                                                className="w-full bg-transparent rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none font-light tracking-wide"
                                                placeholder="name@company.com"
                                            />
                                        </div>
                                    </div>
                                </FadeUp>

                                {/* Password */}
                                <FadeUp delay={stagger.password}>
                                    <div className="space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <label className="text-[11px] font-medium uppercase tracking-[0.15em] text-zinc-300">Password</label>
                                            <Link href="/forgot-password" className="text-[11px] text-cyan-300 hover:text-cyan-200 transition-colors duration-300 tracking-wide">Forgot?</Link>
                                        </div>
                                        <div className={inputClass("password")}>
                                            <input
                                                type="password" value={password} required
                                                onChange={(e) => setPassword(e.target.value)}
                                                onFocus={() => setFocused("password")} onBlur={() => setFocused(null)}
                                                className="w-full bg-transparent rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none font-light tracking-wide"
                                                placeholder="************"
                                            />
                                        </div>
                                    </div>
                                </FadeUp>

                                {/* Submit */}
                                <FadeUp delay={stagger.button}>
                                    <button
                                        type="submit" disabled={loading}
                                        className="relative w-full group overflow-hidden rounded-xl mt-3 text-white font-medium py-3.5 text-sm flex items-center justify-center gap-2 transition-all duration-500 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                                        style={{
                                            background: "linear-gradient(135deg, #0891b2 0%, #06b6d4 30%, #22d3ee 50%, #06b6d4 70%, #0891b2 100%)",
                                            backgroundSize: "200% 200%",
                                            animation: "shimmer 4s ease infinite",
                                            boxShadow: "0 4px 24px rgba(6,182,212,0.25), 0 0 0 0.5px rgba(255,255,255,0.1) inset",
                                        }}
                                    >
                                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/8 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                                        {loading ? <IconLoader2 className="w-5 h-5 animate-spin" /> : (
                                            <>
                                                <span className="tracking-wide">Access Command Center</span>
                                                <IconArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
                                            </>
                                        )}
                                    </button>
                                </FadeUp>
                            </form>

                            {/* Footer */}
                            <FadeUp delay={stagger.footer}>
                                <div className="mt-7 pt-6 border-t border-white/[0.05] text-center">
                                    <p className="text-xs text-zinc-400 mb-3 font-light">
                                        New workspaces must verify their email first.{" "}
                                        <Link href={`/signup/check-email?email=${encodeURIComponent(email.trim().toLowerCase())}`} className="text-cyan-300 hover:text-cyan-200 transition-colors duration-300">
                                            Resend activation
                                        </Link>
                                    </p>
                                    <div className="flex items-center justify-center gap-6 text-xs">
                                        <Link href="/signup" className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors duration-300 group">
                                            <IconShield className="w-3 h-3 transition-colors duration-300 group-hover:text-cyan-300" />Create account
                                        </Link>
                                        <span className="text-zinc-600 select-none">|</span>
                                        <a href="/docs" className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors duration-300 group">
                                            <IconCpu className="w-3 h-3 transition-colors duration-300 group-hover:text-cyan-300" />Documentation
                                        </a>
                                    </div>
                                </div>
                            </FadeUp>
                        </div>
                    </div>
                </FadeUp>

                <FadeUp delay={stagger.footer + 0.05} className="flex justify-center mt-6">
                    <div className="flex items-center gap-3 text-[10px] text-zinc-500 tracking-[0.2em] uppercase font-medium">
                        <span className="w-1 h-1 rounded-full bg-cyan-500/30" />Self-hosted control plane<span className="w-1 h-1 rounded-full bg-amber-500/30" />
                    </div>
                </FadeUp>
            </div>
        </div>
    );
}
