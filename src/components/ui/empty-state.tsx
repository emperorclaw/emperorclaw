import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * The one empty state: an icon, a short title and one line that names the
 * cause ("No tasks match these filters", not just "Nothing here"), plus an
 * optional action. `compact` is for sidebars and panels inside a page;
 * `bordered` (default) draws the dashed outline used for page-level states.
 */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
    compact = false,
    bordered = true,
    className,
    children,
}: {
    icon?: IconComponent;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    compact?: boolean;
    bordered?: boolean;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <div
            role="status"
            className={cn(
                "flex flex-col items-center text-center",
                compact ? "gap-1 px-3 py-5" : "gap-1.5 px-5 py-10 sm:py-12",
                bordered && "rounded-2xl border border-dashed border-border bg-card/60",
                className,
            )}
        >
            {Icon && (
                <span className={cn("mb-1.5 flex items-center justify-center rounded-2xl bg-muted text-muted-foreground", compact ? "h-8 w-8" : "h-11 w-11")}>
                    <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} aria-hidden />
                </span>
            )}
            <p className={cn("font-medium text-foreground", compact ? "text-sm" : "text-base")}>{title}</p>
            {description && <p className={cn("max-w-md text-muted-foreground", compact ? "text-xs leading-5" : "text-sm leading-6")}>{description}</p>}
            {children}
            {action && <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{action}</div>}
        </div>
    );
}
