"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { IconBook, IconRobot, IconFolder, IconDeviceSdCard, IconMessage, IconPlayerPlay, IconShieldCheck, IconX } from "@tabler/icons-react";

const TOUR_STORAGE_KEY = "emperor:workspace-tour:v1";

const tourSteps = [
    {
        title: "Start with Projects",
        body: "Projects hold the business goal. Tasks inside the project are the concrete work agents can claim, finish, and send for review.",
        href: "/projects",
        icon: IconFolder,
    },
    {
        title: "Put reusable context in Knowledge & Rules",
        body: "This is where agents find durable instructions: SOPs, customer rules, inbox details, templates, identities, and operating doctrine.",
        href: "/resources",
        icon: IconShieldCheck,
    },
    {
        title: "Keep files in Storage",
        body: "Storage is for deliverables, proofs, exported reports, working files, and uploads that should survive beyond the chat.",
        href: "/artifacts",
        icon: IconDeviceSdCard,
    },
    {
        title: "Use Messages for coordination",
        body: "Messages show the live control-plane conversations between you, managers, and worker agents.",
        href: "/messages",
        icon: IconMessage,
    },
    {
        title: "Agents are runtimes",
        body: "Agents are the connected OpenClaw workers. Keep shared business context out of agent-local settings unless it truly belongs to one machine.",
        href: "/agents",
        icon: IconRobot,
    },
];

export function WorkspaceTour() {
    const [open, setOpen] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        // Deliberately deferred to an effect: localStorage isn't available
        // during SSR, so deciding tour visibility in the initial render would
        // mismatch between server and client hydration output.
        // eslint-disable-next-line react-hooks/set-state-in-effect
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
                className="flex w-full cursor-pointer items-center space-x-3 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
                <IconPlayerPlay className="h-4 w-4 text-muted-foreground" />
                <span>Start Tour</span>
            </button>

            {open && createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 px-4 py-6 backdrop-blur-sm force-dark">
                    <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
                        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
                            <div className="flex gap-3">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                                    <IconBook className="h-5 w-5" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-semibold tracking-tight">Emperor Claw workspace tour</h2>
                                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                                        A quick map of where work, context, files, and agent operations live.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={closeTour}
                                className="cursor-pointer rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                aria-label="Close workspace tour"
                            >
                                <IconX className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 sm:p-6 md:grid-cols-2">
                            {tourSteps.map((step) => {
                                const Icon = step.icon;
                                return (
                                    <Link
                                        key={step.href}
                                        href={step.href}
                                        onClick={closeTour}
                                        className="group rounded-lg border border-border bg-muted/40 p-4 transition-colors hover:border-ring hover:bg-accent focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                    >
                                        <div className="flex flex-col gap-3 min-[380px]:flex-row min-[380px]:items-start">
                                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors group-hover:text-indigo-300">
                                                <Icon className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
                                                <p className="mt-1 text-sm leading-5 text-muted-foreground">{step.body}</p>
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                        <div className="flex justify-end border-t border-border px-6 py-4">
                            <button
                                type="button"
                                onClick={closeTour}
                                className="cursor-pointer rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background transition-colors hover:bg-foreground/90 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
