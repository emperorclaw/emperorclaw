"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRealtimeTopics } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";

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
    rationale?: string | null;
    resolutionNote?: string | null;
    resolverName?: string | null;
    tasks?: { id: string; title: string }[];
};

const STATUS_TONE: Record<CardStatus, string> = {
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    rejected: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    dismissed: "border-zinc-600 bg-zinc-800/60 text-zinc-400",
    expired: "border-zinc-600 bg-zinc-800/60 text-zinc-400",
};

function isKnownStatus(status: string): status is CardStatus {
    return status in STATUS_TONE;
}

export function ApprovalCard({ approvalId }: { approvalId: string }) {
    const t = useTranslations("approvalCard");
    const [card, setCard] = useState<CardState | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

    const decide = async (status: "approved" | "rejected") => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/approvals/${approvalId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status, resolutionNote: note.trim() || null }),
            });
            if (!res.ok) setError(t("decideFailed"));
            else setNote("");
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
        <div className="mt-2 rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-3 text-xs text-zinc-300" data-approval-card={card.approvalId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-zinc-100">{t("title")}</span>
                <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", STATUS_TONE[status])}>
                    {statusLabel}
                </span>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-zinc-500">{t("requestedBy")}</dt>
                <dd className="min-w-0 break-words text-zinc-200">{card.requesterName ?? t("unknownAgent")}</dd>
                <dt className="text-zinc-500">{t("action")}</dt>
                <dd className="min-w-0 break-words text-zinc-200">{card.label}</dd>
            </dl>
            {card.mayDecide && card.rationale ? (
                <div className="mt-2">
                    <div className="text-zinc-500">{t("rationale")}</div>
                    {/* Plain text: the agent wrote it, so it is never rendered as Markdown or HTML here. */}
                    <p className="mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-zinc-200">{card.rationale}</p>
                </div>
            ) : null}
            {card.mayDecide && card.tasks && card.tasks.length > 0 ? (
                <div className="mt-2 text-zinc-500">
                    {t("tasks")}{" "}
                    {card.tasks.map((task, index) => (
                        <span key={task.id} className="text-zinc-300">
                            {index > 0 ? ", " : ""}{task.title}
                        </span>
                    ))}
                </div>
            ) : null}
            {!pending && card.mayDecide ? (
                <p className="mt-2 text-zinc-400">
                    {card.resolverName ? t("decidedBy", { status: statusLabel, name: card.resolverName }) : statusLabel}
                    {card.resolutionNote ? <span className="block whitespace-pre-wrap break-words text-zinc-300">{t("note", { note: card.resolutionNote })}</span> : null}
                </p>
            ) : null}
            {card.mayDecide ? (
                <div className="mt-2 flex flex-col gap-2">
                    {pending ? (
                        <textarea
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder={t("notePlaceholder")}
                            aria-label={t("noteLabel")}
                            maxLength={2000}
                            rows={2}
                            disabled={busy}
                            className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                        />
                    ) : null}
                    {pending ? <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => void decide("approved")}
                            disabled={!pending || busy}
                            className="inline-flex items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {t("approve")}
                        </button>
                        <button
                            type="button"
                            onClick={() => void decide("rejected")}
                            disabled={!pending || busy}
                            className="inline-flex items-center rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 font-semibold text-rose-300 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {t("reject")}
                        </button>
                    </div> : null}
                    {error ? <p role="alert" className="text-rose-300">{error}</p> : null}
                </div>
            ) : null}
        </div>
    );
}
