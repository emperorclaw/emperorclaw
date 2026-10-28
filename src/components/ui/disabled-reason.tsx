import { useId, type ReactNode } from "react";

/**
 * Says why a control is disabled. A disabled button gets no pointer events,
 * so its own `title` never shows; the wrapper carries the tooltip, and the
 * reason is also in the accessibility tree (focusable wrapper + described-by
 * text) so keyboard and screen-reader users hear it too. With no reason the
 * children render untouched.
 */
export function DisabledReason({ reason, children, className }: { reason: string | null | undefined; children: ReactNode; className?: string }) {
    const id = useId();
    if (!reason) return <>{children}</>;
    return (
        <span title={reason} tabIndex={0} aria-describedby={id} className={className ?? "inline-flex cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"}>
            {children}
            <span id={id} className="sr-only">{reason}</span>
        </span>
    );
}
