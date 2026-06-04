"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Bot, FolderKanban, HardDrive, MessageSquare, PlayCircle, ShieldCheck, X } from "lucide-react";

const TOUR_STORAGE_KEY = "emperor:workspace-tour:v1";

const tourSteps = [
    {
        title: "Start with Projects",
        body: "Projects hold the business goal. Tasks inside the project are the concrete work agents can claim, finish, and send for review.",
        href: "/projects",
        icon: FolderKanban,
    },
    {
        title: "Put reusable context in Knowledge & Rules",
        body: "This is where agents find durable instructions: SOPs, customer rules, inbox details, templates, identities, and operating doctrine.",
        href: "/resources",
        icon: ShieldCheck,
    },
    {
        title: "Keep files in Storage",
        body: "Storage is for deliverables, proofs, exported reports, working files, and uploads that should survive beyond the chat.",
        href: "/artifacts",
        icon: HardDrive,
    },
    {
        title: "Use Messages for coordination",
        body: "Messages show the live control-plane conversations between you, managers, and worker agents.",
        href: "/messages",
        icon: MessageSquare,
    },
    {
        title: "Agents are runtimes",
        body: "Agents are the connected OpenClaw workers. Keep shared business context out of agent-local settings unless it truly belongs to one machine.",
        href: "/agents",
        icon: Bot,
    },
];

export function WorkspaceTour() {
    const [open, setOpen] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        setReady(true);
        if (window.localStorage.getItem(TOUR_STORAGE_KEY) !== "seen") {
            setOpen(true);
        }
    }, []);

    const closeTour = () => {
        window.localStorage.setItem(TOUR_STORAGE_KEY, "seen");
        setOpen(false);
    };

    if (!ready) return null;

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex w-full cursor-pointer items-center space-x-3 rounded-md px-3 py-2 text-left text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
                <PlayCircle className="h-4 w-4 text-zinc-500" />
                <span>Start Tour</span>
            </button>

            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
                    <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl">
                        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-5">
                            <div className="flex gap-3">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                                    <BookOpen className="h-5 w-5" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-semibold tracking-tight">Emperor Claw workspace tour</h2>
                                    <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">
                                        A quick map of where work, context, files, and agent operations live.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={closeTour}
                                className="cursor-pointer rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                aria-label="Close workspace tour"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="grid gap-3 p-6 sm:grid-cols-2">
                            {tourSteps.map((step) => {
                                const Icon = step.icon;
                                return (
                                    <Link
                                        key={step.href}
                                        href={step.href}
                                        onClick={closeTour}
                                        className="group rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-400 transition-colors group-hover:text-indigo-300">
                                                <Icon className="h-4 w-4" />
                                            </div>
                                            <div>
                                                <h3 className="text-sm font-semibold text-zinc-100">{step.title}</h3>
                                                <p className="mt-1 text-sm leading-5 text-zinc-500">{step.body}</p>
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                        <div className="flex justify-end border-t border-zinc-800 px-6 py-4">
                            <button
                                type="button"
                                onClick={closeTour}
                                className="cursor-pointer rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
