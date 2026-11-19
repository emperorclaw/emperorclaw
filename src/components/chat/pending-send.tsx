"use client";
import { useTranslations } from "next-intl";
import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";

export type PendingText = { clientMessageId: string; text: string; attachments: string[]; mode: "queue" | "replace"; status: "sending" | "failed"; view: string; createdAt: string };
export function PendingReceipt({ message, onRetry }: { message: PendingText; onRetry: () => void }) {
    const t = useTranslations("chatExperience");
    return <div data-testid="pending-send" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
        {message.status === "sending" ? <><IconLoader2 aria-hidden className="h-3 w-3 motion-safe:animate-spin" />{t("sending")}</> :
            <><IconAlertCircle aria-hidden className="h-3 w-3" />{t("sendFailed")}
            {message.mode === "queue" && <button type="button" onClick={onRetry} className="min-h-8 rounded px-2 underline focus-visible:ring-2 focus-visible:ring-ring">{t("retry")}</button>}</>}
    </div>;
}
export function PreviewState({ state }: { state: string }) {
    const t = useTranslations("chatExperience");
    const running = state === "running";
    return <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground" role="status">
        {running ? <IconLoader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> : state === "succeeded" || state === "sealed" ? <IconCheck className="h-3 w-3" aria-hidden /> : <IconAlertCircle className="h-3 w-3" aria-hidden />}
        {running ? t("responding") : state === "succeeded" ? t("finishing") : state === "sealed" ? t("stepComplete") : state === "capped" ? t("previewCapped") : t("interrupted")}
    </div>;
}
