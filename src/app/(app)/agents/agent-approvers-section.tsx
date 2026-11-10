"use client";

import { useCallback, useEffect, useState } from "react";
import { IconRoute } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ApproverPicker, approverSettingComplete, sanitizeApproverSetting, useWaitingOnLabel, type ApproverOptions } from "@/components/approver-picker";
import type { ApproverSetting, AuthorityRefusal, WaitingOn } from "@/lib/approval-routing";

type View = {
    approvers: ApproverSetting;
    chain: { steps: WaitingOn[]; skipped: { name: string; reason: AuthorityRefusal }[] };
    canEdit: boolean;
    options?: ApproverOptions;
};

/**
 * "Who approves this agent's requests" (approval routing): Automatic (the org
 * chart), a specific agent, or specific people, and the chain an ask gets now
 * ("Asks go to: Architect → Jose → owners and admins"). Owners and admins edit.
 */
export function AgentApproversSection({ agentId }: { agentId: string }) {
    const t = useTranslations("approvers");
    const stepLabel = useWaitingOnLabel();
    const [view, setView] = useState<View | null>(null);
    const [draft, setDraft] = useState<ApproverSetting>({ mode: "auto" });
    const [saving, setSaving] = useState(false);
    // Saved approvers who left (removed people, deleted agents) are dropped from the form.
    const [cleared, setCleared] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/agents/${agentId}/approvers`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("loadFailed")))))
            .then((data: View) => {
                if (cancelled) return;
                setView(data);
                const clean = sanitizeApproverSetting(data.approvers, data.options ?? null);
                setDraft(clean.value);
                setCleared(clean.cleared);
            })
            .catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : t("loadFailed")); });
        return () => { cancelled = true; };
    }, [agentId, t]);

    const dirty = view !== null && JSON.stringify(view.approvers) !== JSON.stringify(draft);
    const save = useCallback(async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/approvers`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ approvers: draft }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : t("saveFailed"));
            setView(data as View);
            setDraft((data as View).approvers);
            setCleared(false);
            toast.success(t("saved"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("saveFailed"));
        } finally {
            setSaving(false);
        }
    }, [agentId, draft, t]);

    return (
        <section className="space-y-2" aria-labelledby="agent-approvers-title">
            <div>
                <div className="flex items-center gap-2 text-foreground">
                    <IconRoute className="h-4 w-4 text-primary" aria-hidden />
                    <h4 id="agent-approvers-title" className="text-sm font-medium">{t("title")}</h4>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("intro")}</p>
            </div>
            <div className="space-y-3 rounded-xl border border-border bg-card p-3">
                {view ? (
                    <>
                        <ApproverPicker id={`agent-${agentId}-approvers`} value={draft} onChange={setDraft} options={view.options ?? null}
                            disabled={!view.canEdit || saving} autoLabel={t("modes.auto")} />
                        {cleared && <p className="text-xs text-amber-700 dark:text-amber-300">{t("cleared")}</p>}
                        {view.canEdit && dirty && (
                            <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" onClick={() => void save()} disabled={saving || !approverSettingComplete(draft)}>{t("save")}</Button>
                                <Button type="button" size="sm" variant="outline" onClick={() => setDraft(view.approvers)} disabled={saving}>{t("cancel")}</Button>
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{t("asksGoTo")}</span>{" "}
                            {view.chain.steps.map(stepLabel).join(" → ")}
                        </p>
                        {view.chain.skipped.length > 0 && (
                            <ul className="space-y-0.5 text-xs text-muted-foreground">
                                {view.chain.skipped.map((skip) => (
                                    <li key={`${skip.name}-${skip.reason}`}>{t("skipped", { name: skip.name, reason: t(`reasons.${skip.reason}`) })}</li>
                                ))}
                            </ul>
                        )}
                        <p className="text-xs text-muted-foreground">{t("riskyNote")}</p>
                        {!view.canEdit && <p className="text-xs text-muted-foreground">{t("adminsOnly")}</p>}
                    </>
                ) : (
                    <p className="text-xs text-muted-foreground">{t("loading")}</p>
                )}
            </div>
        </section>
    );
}
