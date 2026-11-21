"use client";
import { useTranslations } from "next-intl";
import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { previewStatusKey } from "@/lib/chat/delivery-state";

export type PendingText = { clientMessageId: string; text: string; attachments: string[]; mode: "queue" | "replace"; status: "sending" | "failed"; view: string; createdAt: string };
export function PendingReceipt({ message, onRetry }: { message: PendingText; onRetry: () => void }) {
    const t = useTranslations("chatExperience");
    return <div data-testid="pending-send" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
        {message.status === "sending" ? <><IconLoader2 aria-hidden className="h-3 w-3 motion-safe:animate-spin" />{t("sending")}</> :
            <><IconAlertCircle aria-hidden className="h-3 w-3" />{t("sendFailed")}
            {message.mode === "queue" && <button type="button" onClick={onRetry} className="min-h-8 rounded px-2 underline focus-visible:ring-2 focus-visible:ring-ring">{t("retry")}</button>}</>}
    </div>;
}
/**
 * One status line under a streaming preview. When `thinkingRowVisible`, the
 * chat's thinking row already reports the turn, so a second "Responding" is
 * noise and the line stays off until the run settles into a final or failure
 * state.
 */
export function PreviewState({ state, thinkingRowVisible = false }: { state: string; thinkingRowVisible?: boolean }) {
    const t = useTranslations("chatExperience");
    const key = previewStatusKey(state, thinkingRowVisible);
    if (!key) return null;
    const settled = key === "finishing" || key === "stepComplete";
    return <div data-testid="preview-state" data-state={key} className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground" role="status">
        {settled ? <IconCheck className="h-3 w-3" aria-hidden /> : key === "responding" ? <IconLoader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> : <IconAlertCircle className="h-3 w-3" aria-hidden />}
        {t(key)}
    </div>;
}
