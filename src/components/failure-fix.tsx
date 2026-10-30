"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useApiError } from "@/lib/i18n/use-api-error";
import { IconArrowRight, IconBellRinging, IconPlugConnected, IconRefresh } from "@tabler/icons-react";
import { agentFixMessage, type FailureFix } from "@/lib/failure-cause";
import { useCopy } from "@/lib/i18n/use-copy";
import { cn } from "@/lib/utils";

async function errorOf(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
    return data.error || data.message || fallback;
}

/** Runs a fix's action against the existing endpoints. Links never reach here. */
async function runFix(fix: FailureFix, t: ReturnType<typeof useTranslations<"failureFix">>): Promise<string> {
    const { action } = fix;
    switch (action.kind) {
        case "retry_message": {
            const res = await fetch(`/api/chat/messages/${encodeURIComponent(action.messageId)}`, { method: "POST" });
            if (!res.ok) throw new Error(await errorOf(res, t("retryFailed")));
            return t("sentAgain");
        }
        case "message_agent": {
            const res = await fetch("/api/chat", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetAgentId: action.agentId, text: agentFixMessage(action) }),
            });
            if (!res.ok) throw new Error(await errorOf(res, t("reachFailed")));
            return action.mode === "nudge" ? t("nudged") : t("askedRetry");
        }
        case "restart_runtime": {
            const res = await fetch(`/api/agents/${encodeURIComponent(action.agentId)}/recreate-runtime`, { method: "POST" });
            const data = await res.json().catch(() => ({})) as { error?: string; success?: boolean; message?: string };
            if (!res.ok || data.success === false) throw new Error(data.error || data.message || t("restartFailed"));
            return t("restarting");
        }
        case "link":
            return "";
    }
}

/** Re-renders once `notBefore` passes, so a held Retry enables itself. Returns the seconds left. */
function useSecondsUntil(notBefore: string | null | undefined): number {
    const target = notBefore ? Date.parse(notBefore) : NaN;
    const [nowMs, setNowMs] = useState(() => Date.now());
    const left = Number.isFinite(target) ? Math.max(0, Math.ceil((target - nowMs) / 1000)) : 0;
    useEffect(() => {
        if (left <= 0) return;
        const id = window.setTimeout(() => setNowMs(Date.now()), 1000);
        return () => window.clearTimeout(id);
    }, [left, nowMs]);
    return left;
}

const ICON = {
    link: IconArrowRight,
    retry_message: IconRefresh,
    message_agent: IconBellRinging,
    restart_runtime: IconPlugConnected,
} as const;

/**
 * The one fix button for a failure (src/lib/failure-cause.ts). Navigation
 * fixes are links; action fixes call the existing endpoints and refresh the
 * page. The caller passes its own button classes so it matches the surface.
 */
export function FailureFixButton({ fix, className, disabled = false, onDone }: {
    fix: FailureFix;
    className?: string;
    disabled?: boolean;
    /** Called after a successful action (not for links). */
    onDone?: () => void;
}) {
    const t = useTranslations("failureFix");
    const apiError = useApiError();
    const render = useCopy();
    const label = render(fix.labelCopy, fix.label);
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const wait = useSecondsUntil(fix.notBefore);
    const Icon = busy ? IconRefresh : ICON[fix.action.kind];

    if (fix.action.kind === "link") {
        const external = fix.action.href.startsWith("/docs/");
        return (
            <Link href={fix.action.href} target={external ? "_blank" : undefined} className={className}>
                {label}<Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
        );
    }

    const onClick = async () => {
        setBusy(true);
        try {
            const message = await runFix(fix, t);
            if (message) toast.success(message);
            onDone?.();
            router.refresh();
        } catch (error) {
            toast.error(apiError(error instanceof Error ? error.message : null, t("somethingWrong")));
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            disabled={disabled || busy || wait > 0}
            onClick={() => void onClick()}
            title={wait > 0 ? t("rateLimited") : undefined}
            className={className}
        >
            <Icon className={cn("h-3.5 w-3.5", busy && "animate-spin")} aria-hidden="true" />
            {wait > 0 ? t("labelIn", { label, seconds: wait }) : label}
        </button>
    );
}
