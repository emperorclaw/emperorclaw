// Pure, client-safe helpers behind the agent-visibility work: the "Live"
// status pill, the "Also working on" row in a direct chat, and the privacy
// labelling that keeps another person's private thread and out-of-scope tasks
// from leaking. No DB, no React: everything here is unit-testable.

import { directThreadLink } from "@/lib/direct-chat-mode";
import { taskHref } from "@/lib/task-story";

export type RealtimeStatusLike = "connecting" | "open" | "closed";

/**
 * What a run's thread means to the viewer:
 * - "own-private"   — the viewer's own private direct thread with the agent;
 * - "other-private" — another person's private direct thread (never revealed);
 * - "operations"    — the agent's shared thread (the "Work log" in private mode);
 * - "team"/"group"  — a public team or group thread;
 * - "other"         — unknown or unreadable.
 */
export type RunThreadKind = "own-private" | "other-private" | "operations" | "team" | "group" | "other";

/** The thread columns the classifier needs (a subset of `message_threads`). */
export interface RunThreadDetails {
    type: string;
    ownerUserId?: string | null;
    isPrivate?: boolean | null;
}

/**
 * A running run as the browser sees it, already privacy-resolved by the server:
 * `threadId` is null when the thread must stay hidden, `taskId`/`taskTitle` are
 * null when there is no task or the task is out of the viewer's scope.
 */
export interface RunningRun {
    runId: string;
    agentId: string;
    threadId: string | null;
    threadKind: RunThreadKind;
    taskId: string | null;
    taskTitle: string | null;
    /** True when the run has a task the viewer cannot see (out of member scope). */
    taskHidden: boolean;
    /** Null for another person's private chat: its timing is not shown. */
    startedAt: string | null;
}

/** Classify a run's thread for the viewer: its kind and whether the thread is visible. */
export function classifyRunThread(
    thread: RunThreadDetails | null | undefined,
    viewerUserId: string | null | undefined,
): { kind: RunThreadKind; visible: boolean } {
    if (!thread) return { kind: "other", visible: false };
    if (thread.type === "team") return { kind: "team", visible: true };
    if (thread.type === "group") return { kind: "group", visible: true };
    if (thread.type === "direct") {
        const isPrivate = Boolean(thread.isPrivate) || Boolean(thread.ownerUserId);
        if (isPrivate) {
            return viewerUserId && thread.ownerUserId === viewerUserId
                ? { kind: "own-private", visible: true }
                : { kind: "other-private", visible: false };
        }
        return { kind: "operations", visible: true };
    }
    return { kind: "other", visible: false };
}

/** The one line and link for a running run: task title, thread, or a private/out-of-scope stand-in. */
export function runWorkLabel(run: RunningRun): { text: string; href: string | null } {
    // Another person's private chat says nothing more, whatever task it is on.
    if (run.threadKind === "other-private") return { text: "a private chat", href: null };
    if (run.taskId && run.taskTitle) return { text: run.taskTitle, href: taskHref(run.taskId) };
    if (run.taskHidden) return { text: "other work", href: null };
    switch (run.threadKind) {
        case "operations":
            return { text: "the work log", href: run.threadId ? directThreadLink(run.threadId, run.agentId) : null };
        case "team":
            return { text: "the team channel", href: "/messages" };
        case "group":
            return { text: "a group chat", href: "/messages" };
        case "own-private":
        case "other":
        default:
            return { text: "a chat", href: run.threadId ? directThreadLink(run.threadId, run.agentId) : null };
    }
}

/** The "● Live" pill copy by realtime socket status. */
export interface LivePillCopy { label: string; live: boolean }

export function livePillCopy(status: RealtimeStatusLike, fallbackSeconds: number): LivePillCopy {
    if (status === "open") return { label: "Live", live: true };
    return { label: `Reconnecting… refreshing every ${fallbackSeconds} s`, live: false };
}

export interface AlsoWorkingItem {
    runId: string;
    text: string;
    href: string | null;
    startedAt: string | null;
}

export interface AlsoWorkingSummary {
    primary: AlsoWorkingItem | null;
    /** Additional running runs beyond the primary one. */
    more: number;
}

/**
 * The "Also working on" line for the agent's running runs in OTHER threads
 * (the current chat's own runs are excluded). Picks the newest run as the
 * primary line; the rest collapse into "+N more".
 */
export function summarizeAlsoWorking(runs: readonly RunningRun[], excludeThreadId: string | null | undefined): AlsoWorkingSummary {
    const others = runs
        .filter((run) => !excludeThreadId || run.threadId !== excludeThreadId)
        .sort((a, b) => (b.startedAt ? Date.parse(b.startedAt) : 0) - (a.startedAt ? Date.parse(a.startedAt) : 0));
    if (others.length === 0) return { primary: null, more: 0 };
    const [first, ...rest] = others;
    const label = runWorkLabel(first);
    return { primary: { runId: first.runId, text: label.text, href: label.href, startedAt: first.startedAt }, more: rest.length };
}
