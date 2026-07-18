"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "next/navigation";
import { IconArrowLeft, IconArrowRight, IconRosetteDiscountCheck, IconBook, IconRobot, IconFolder, IconGitBranch, IconDeviceSdCard, IconKey, IconLayoutDashboard, IconMessage, IconFileText, IconShieldCheck, IconX } from "@tabler/icons-react";

const TOUR_DONE_KEY = "emperor:interactive-tour:v1";

interface TourStep {
    title: string;
    body: string;
    href: string;
    icon: typeof IconLayoutDashboard;
}

const steps: TourStep[] = [
    {
        title: "Dashboard — your command center",
        body: "Your home base. See agent status, recent activity, team chat, and open issues at a glance. The sidebar on the left takes you everywhere.",
        href: "/",
        icon: IconLayoutDashboard,
    },
    {
        title: "Projects — where work lives",
        body: "Create projects for each business goal. Inside, break work into tasks that agents claim, execute, and submit for review. Drag tasks across the Kanban as they progress.",
        href: "/projects",
        icon: IconFolder,
    },
    {
        title: "Automations — recurring work on autopilot",
        body: "Set up pipelines and recurring task definitions. Agents register their automations here so you always know what's running.",
        href: "/pipelines",
        icon: IconGitBranch,
    },
    {
        title: "Knowledge Base — durable context",
        body: "Store SOPs, customer rules, templates, and operating doctrine. Agents read from here before executing tasks — this is their long-term memory.",
        href: "/resources",
        icon: IconFileText,
    },
    {
        title: "Messages — team coordination",
        body: "Live conversations between you and your agents. Direct threads for human-to-agent control, team channel for broadcast visibility.",
        href: "/messages",
        icon: IconMessage,
    },
    {
        title: "Approvals — human-in-the-loop",
        body: "Tasks needing your sign-off land here. Review agent output, approve or request changes, and keep quality gates enforced.",
        href: "/approvals",
        icon: IconRosetteDiscountCheck,
    },
    {
        title: "Agents — your AI workforce",
        body: "Register and manage your connected OpenClaw workers. Each agent has a profile, capabilities, and runtime config.",
        href: "/agents",
        icon: IconRobot,
    },
    {
        title: "Customers — client context",
        body: "Organize work by customer. Link projects, tasks, and knowledge to specific clients for clear separation.",
        href: "/customers",
        icon: IconShieldCheck,
    },
    {
        title: "Files — persistent storage",
        body: "Deliverables, proofs, reports, and uploads that survive beyond chat. Agents store output here for you to review.",
        href: "/artifacts",
        icon: IconDeviceSdCard,
    },
    {
        title: "Settings — workspace config",
        body: "Manage API tokens for agent connections, configure instance settings, and control workspace access. The Members tab lets you invite your team and manage roles.",
        href: "/settings",
        icon: IconKey,
    },
    {
        title: "Docs — learn more anytime",
        body: "Full guides for OpenClaw agents, Hermes bridges, pipelines, webhooks, and advanced config. Available anytime from the sidebar.",
        href: "/docs",
        icon: IconBook,
    },
];

export function InteractiveTour() {
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
        [close, router],
    );

    if (!ready || !open) return null;

    const s = steps[step];
    if (!s) return null;
    const Icon = s.icon;
    const first = step === 0;
    const last = step === steps.length - 1;

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-end justify-center pointer-events-none">
            <div className="pointer-events-auto mb-6 mx-4 w-full max-w-lg animate-in slide-in-from-bottom-4 fade-in duration-300">
                <div className="relative rounded-2xl border border-cyan-400/20 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-xl">
                    {/* Progress */}
                    <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl bg-white/5">
                        <div className="h-full rounded-t-2xl bg-cyan-400/60 transition-all duration-300" style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
                    </div>

                    <div className="flex items-start gap-4 px-5 pt-5 pb-3">
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10">
                            <Icon className="h-5 w-5 text-cyan-300" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                                <h2 className="text-base font-semibold text-white">{s.title}</h2>
                                <button onClick={close} className="shrink-0 cursor-pointer rounded-lg p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-300" aria-label="Close tour">
                                    <IconX className="h-4 w-4" />
                                </button>
                            </div>
                            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{s.body}</p>
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 px-5 pb-5 pt-1">
                        <span className="text-xs text-zinc-600 tabular-nums">{step + 1} / {steps.length}</span>
                        <div className="flex items-center gap-2">
                            {!first && (
                                <button onClick={() => goTo(step - 1)} className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900">
                                    <IconArrowLeft className="h-3.5 w-3.5" /> Back
                                </button>
                            )}
                            <button onClick={close} className="cursor-pointer rounded-xl px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-300">Skip</button>
                            <button onClick={() => last ? close() : goTo(step + 1)} className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-cyan-400/10 border border-cyan-400/25 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-400/15">
                                {last ? "Done" : "Next"}
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
