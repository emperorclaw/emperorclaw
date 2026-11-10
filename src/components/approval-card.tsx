"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { TextSwap } from "@/components/ui/motion";
import { useRealtimeTopics } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { WaitingOn } from "@/lib/approval-routing";

/**
 * An approval card in a chat thread (lib/approval-card.ts posts the system
 * message; the message text is the neutral one-line summary). This component
 * adds the live state under it, read from GET /api/approvals/[id]/card:
 * status for everyone who may see the approval; the rationale, the note and
 * Approve / Reject only for people who may decide it. Deciding calls the same
 * PATCH /api/approvals/[id] the Inbox and the Approvals page use, so the
 * permission checks are identical. Someone who may not see the approval sees
 * only the message text.
 */

type CardStatus = "pending" | "approved" | "rejected" | "dismissed" | "expired";

type CardState = {
    approvalId: string;
    status: CardStatus | string;
    label: string;
    requesterName: string | null;
    mayDecide: boolean;
    /** A pending routed ask: who it waits on (lib/approval-routing.ts). */
    waitingOn?: WaitingOn | null;
    /** Decided by a boss agent (decide_approval), not a person. */
    resolverIsAgent?: boolean;
    /** "Always allow" is offered (a pending action ask, and this person may change the agent's permissions). */
    mayAlwaysAllow?: boolean;
    /** Approved with "Always allow". */
    alwaysAllowed?: boolean;
    rationale?: string | null;
    resolutionNote?: string | null;
    resolverName?: string | null;
    tasks?: { id: string; title: string }[];
};

const STATUS_TONE: Record<CardStatus, string> = {
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    rejected: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    dismissed: "border-border bg-muted text-muted-foreground",
    expired: "border-border bg-muted text-muted-foreground",
};

/** Pending-only parts collapse (height + opacity) on the shared spring when the approval is decided. */
const COLLAPSE = {
    initial: { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1 },
    exit: { height: 0, opacity: 0 },
} as const;

function isKnownStatus(status: string): status is CardStatus {
    return status in STATUS_TONE;
}

export function ApprovalCard({ approvalId }: { approvalId: string }) {
    const t = useTranslations("approvalCard");
    const [card, setCard] = useState<CardState | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmAlways, setConfirmAlways] = useState(false);
    // Reduced motion: the fold becomes a short fade-paced change, not a slide.
    const collapse = useReducedMotion() ? { ...COLLAPSE, transition: { duration: 0.16 } } : COLLAPSE;

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/approvals/${approvalId}/card`, { cache: "no-store" });
            if (res.status === 403 || res.status === 404) {
                setCard(null);
                return;
            }
            if (!res.ok) return;
            const data = (await res.json()) as { card?: CardState };
            if (data.card) setCard(data.card);
        } catch {
            // Offline or a transient failure: keep what is shown; the next event or focus retries.
        }
    }, [approvalId]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        const onFocus = () => { void load(); };
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [load]);
    const topics = useMemo(() => [`approval:${approvalId}`], [approvalId]);
    useRealtimeTopics(topics, () => { void load(); });

    const decide = async (status: "approved" | "rejected", alwaysAllow = false) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/approvals/${approvalId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status, resolutionNote: note.trim() || null, ...(alwaysAllow ? { alwaysAllow: true } : {}) }),
            });
            if (res.status === 409) {
                // First decision wins: say who decided it.
                const data = (await res.json().catch(() => ({}))) as { decidedBy?: string | null };
                setError(data.decidedBy ? t("alreadyDecidedBy", { name: data.decidedBy }) : t("decideFailed"));
            } else if (!res.ok) setError(t("decideFailed"));
            else {
                setNote("");
                setConfirmAlways(false);
            }
            await load();
        } catch {
            setError(t("decideFailed"));
        } finally {
            setBusy(false);
        }
    };

    if (!card) return null;

    const status = isKnownStatus(card.status) ? card.status : "pending";
    const pending = card.status === "pending";
    const statusLabel = {
        pending: t("status.pending"),
        approved: t("status.approved"),
        rejected: t("status.rejected"),
        dismissed: t("status.dismissed"),
        expired: t("status.expired"),
    }[status];

    return (
        <div className="mt-2 rounded-xl border border-border bg-muted/40 p-3 text-xs text-foreground" data-approval-card={card.approvalId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{t("title")}</span>
                <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors", STATUS_TONE[status])}>
                    <TextSwap id={status}>{statusLabel}</TextSwap>
                </span>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t("requestedBy")}</dt>
                <dd className="min-w-0 break-words">{card.requesterName ?? t("unknownAgent")}</dd>
                <dt className="text-muted-foreground">{t("action")}</dt>
                <dd className="min-w-0 break-words">{card.label}</dd>
                {pending && card.waitingOn ? (
                    <>
                        <dt className="text-muted-foreground">{t("waitingOn")}</dt>
                        <dd className="min-w-0 break-words">
                            {card.waitingOn.kind === "agent" ? t("waitingOnAgent", { name: card.waitingOn.names[0] ?? t("unknownAgent") })
                                : card.waitingOn.kind === "users" ? card.waitingOn.names.join(", ")
                                    : card.waitingOn.kind === "hidden" ? t("waitingOnApprover")
                                        : t("waitingOnAdmins")}
                        </dd>
                    </>
                ) : null}
            </dl>
            {card.rationale ? (
                <div className="mt-2">
                    <div className="text-muted-foreground">{t("rationale")}</div>
                    {/* Plain text: the agent wrote it, so it is never rendered as Markdown or HTML here. */}
                    <p className="mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{card.rationale}</p>
                </div>
            ) : null}
            {card.tasks && card.tasks.length > 0 ? (
                <div className="mt-2 text-muted-foreground">
                    {t("tasks")}{" "}
                    {card.tasks.map((task, index) => (
                        <span key={task.id} className="text-foreground">
                            {index > 0 ? ", " : ""}{task.title}
                        </span>
                    ))}
                </div>
            ) : null}
            <AnimatePresence initial={false}>
                {card.alwaysAllowed ? (
                    <motion.p key="always" {...collapse} className="overflow-hidden">
                        <span className="block pt-2 text-emerald-600 dark:text-emerald-300">{t("alwaysAllowedFor", { name: card.requesterName ?? t("unknownAgent") })}</span>
                    </motion.p>
                ) : null}
                {!pending && (card.mayDecide || card.resolverName !== undefined) ? (
                    <motion.div key="resolved" {...collapse} className="overflow-hidden">
                        <p className="pt-2 text-muted-foreground">
                            {card.resolverName ? t(card.resolverIsAgent ? "decidedByAgent" : "decidedBy", { status: statusLabel, name: card.resolverName }) : statusLabel}
                            {card.resolutionNote ? <span className="block whitespace-pre-wrap break-words text-foreground">{t("note", { note: card.resolutionNote })}</span> : null}
                        </p>
                    </motion.div>
                ) : null}
                {pending && card.mayDecide ? (
                    <motion.div key="decide" {...collapse} className="overflow-hidden">
                        <div className="flex flex-col gap-2 pt-2">
                            <textarea
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                                placeholder={t("notePlaceholder")}
                                aria-label={t("noteLabel")}
                                maxLength={2000}
                                rows={2}
                                disabled={busy}
                                className="w-full resize-y rounded-lg border border-input bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                            <div className="flex flex-wrap gap-2">
                                <Button type="button" size="xs" onClick={() => void decide("approved")} disabled={!pending || busy}>
                                    {t("approve")}
                                </Button>
                                <Button type="button" size="xs" variant="outline" onClick={() => void decide("rejected")} disabled={!pending || busy}
                                    className="text-destructive hover:text-destructive">
                                    {t("reject")}
                                </Button>
                                {card.mayAlwaysAllow && !confirmAlways ? (
                                    <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmAlways(true)} disabled={busy}>
                                        {t("alwaysAllow")}
                                    </Button>
                                ) : null}
                            </div>
                            {card.mayAlwaysAllow && confirmAlways ? (
                                <div className="rounded-lg border border-border bg-background p-2">
                                    <p>{t("alwaysAllowConfirm", { name: card.requesterName ?? t("unknownAgent"), action: card.label })}</p>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <Button type="button" size="xs" onClick={() => void decide("approved", true)} disabled={busy}>
                                            {t("alwaysAllowYes")}
                                        </Button>
                                        <Button type="button" size="xs" variant="outline" onClick={() => setConfirmAlways(false)} disabled={busy}>
                                            {t("cancel")}
                                        </Button>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
            {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
        </div>
    );
}
