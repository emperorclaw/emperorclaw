"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { IconArrowLeft, IconArrowRight, IconRosetteDiscountCheck, IconBook, IconRobot, IconFolder, IconGitBranch, IconDeviceSdCard, IconKey, IconLayoutDashboard, IconMessage, IconFileText, IconShieldCheck, IconX } from "@tabler/icons-react";

import { pathEnabled, type ModuleState } from "@/lib/modules";

const TOUR_DONE_KEY = "emperor:interactive-tour:v1";

interface TourStep {
    /** Title and body: onboarding.interactiveTour.steps.{id} in messages/*.json. */
    id: "dashboard" | "projects" | "automations" | "knowledge" | "messages" | "approvals" | "agents" | "customers" | "files" | "settings" | "docs";
    href: string;
    icon: typeof IconLayoutDashboard;
}

const TOUR_STEPS: TourStep[] = [
    { id: "dashboard", href: "/", icon: IconLayoutDashboard },
    { id: "projects", href: "/projects", icon: IconFolder },
    { id: "automations", href: "/pipelines", icon: IconGitBranch },
    { id: "knowledge", href: "/resources", icon: IconFileText },
    { id: "messages", href: "/messages", icon: IconMessage },
    { id: "approvals", href: "/approvals", icon: IconRosetteDiscountCheck },
    { id: "agents", href: "/agents", icon: IconRobot },
    { id: "customers", href: "/customers", icon: IconShieldCheck },
    { id: "files", href: "/artifacts", icon: IconDeviceSdCard },
    { id: "settings", href: "/settings", icon: IconKey },
    { id: "docs", href: "/docs", icon: IconBook },
];

export function InteractiveTour({ modules }: { modules?: ModuleState | null }) {
    const t = useTranslations("onboarding.interactiveTour");
    const steps = useMemo(() => TOUR_STEPS.filter((s) => pathEnabled(s.href, modules)), [modules]);
    const router = useRouter();
    const pathname = usePathname();
    const [step, setStep] = useState(0);
    const [open, setOpen] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        setReady(true);
        const done = window.localStorage.getItem(TOUR_DONE_KEY);
        if (done !== "done") {
            setTimeout(() => setOpen(true), 700);
        }
    }, []);

    const close = useCallback(() => {
        window.localStorage.setItem(TOUR_DONE_KEY, "done");
        setOpen(false);
    }, []);

    const goTo = useCallback(
        (idx: number) => {
            if (idx < 0 || idx >= steps.length) { close(); return; }
            setStep(idx);
            router.push(steps[idx].href);
        },
        [close, router, steps],
    );

    if (!ready || !open) return null;

    const s = steps[step];
    if (!s) return null;
    const Icon = s.icon;
    const first = step === 0;
    const last = step === steps.length - 1;

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-end justify-center pointer-events-none">
            <div className="pointer-events-auto mb-6 mx-4 w-full max-w-lg animate-in slide-in-from-bottom-4 fade-in duration-300 force-dark">
                <div className="relative rounded-2xl border border-cyan-400/20 bg-card shadow-2xl shadow-black/60 backdrop-blur-xl">
                    {/* Progress */}
                    <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl bg-muted">
                        <div className="h-full rounded-t-2xl bg-cyan-400/60 transition-all duration-300" style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
                    </div>

                    <div className="flex items-start gap-4 px-5 pt-5 pb-3">
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10">
                            <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                                <h2 className="text-base font-semibold text-foreground">{t(`steps.${s.id}.title`)}</h2>
                                <button onClick={close} className="shrink-0 cursor-pointer rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("close")}>
                                    <IconX className="h-4 w-4" />
                                </button>
                            </div>
                            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t(`steps.${s.id}.body`)}</p>
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 px-5 pb-5 pt-1">
                        <span className="text-xs text-muted-foreground tabular-nums">{step + 1} / {steps.length}</span>
                        <div className="flex items-center gap-2">
                            {!first && (
                                <button onClick={() => goTo(step - 1)} className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:border-ring hover:bg-accent">
                                    <IconArrowLeft className="h-3.5 w-3.5" /> {t("back")}
                                </button>
                            )}
                            <button onClick={close} className="cursor-pointer rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">{t("skip")}</button>
                            <button onClick={() => last ? close() : goTo(step + 1)} className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-cyan-400/10 border border-cyan-400/25 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-400/15">
                                {last ? t("done") : t("next")}
                                {!last && <IconArrowRight className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
