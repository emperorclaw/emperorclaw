import { Children } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
    AlertTriangle,
    Info,
    CheckCircle2,
    Clock,
} from "lucide-react";

// ── Stat Card ──────────────────────────────────────────────────────

export function OpsStatCard({
    title,
    value,
    detail,
    icon: Icon,
    accent = "indigo",
    trend,
}: {
    title: string;
    value: string;
    detail: string;
    icon?: React.ElementType;
    accent?: "indigo" | "emerald" | "amber" | "rose" | "violet" | "cyan";
    trend?: { direction: "up" | "down"; label: string };
}) {
    const accentStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
        indigo: { border: "border-indigo-500/20", bg: "bg-indigo-500/5", text: "text-indigo-400", icon: "text-indigo-400" },
        emerald: { border: "border-emerald-500/20", bg: "bg-emerald-500/5", text: "text-emerald-400", icon: "text-emerald-400" },
        amber: { border: "border-amber-500/20", bg: "bg-amber-500/5", text: "text-amber-400", icon: "text-amber-400" },
        rose: { border: "border-rose-500/20", bg: "bg-rose-500/5", text: "text-rose-400", icon: "text-rose-400" },
        violet: { border: "border-violet-500/20", bg: "bg-violet-500/5", text: "text-violet-400", icon: "text-violet-400" },
        cyan: { border: "border-cyan-500/20", bg: "bg-cyan-500/5", text: "text-cyan-400", icon: "text-cyan-400" },
    };

    const style = accentStyles[accent];

    return (
        <div
            className={cn(
                "group relative overflow-hidden rounded-xl border bg-zinc-900/40 p-5 transition-all duration-200 hover:bg-zinc-900/70",
                style.border
            )}
        >
            {/* Accent bar */}
            <div className={cn("absolute left-0 top-0 h-full w-0.5", style.bg)} />

            <div className="flex items-start justify-between">
                <div className="space-y-1">
                    <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{title}</div>
                    <div className="text-2xl font-bold text-zinc-100">{value}</div>
                </div>
                {Icon && (
                    <div className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-lg",
                        style.bg
                    )}>
                        <Icon className={cn("h-5 w-5", style.icon)} />
                    </div>
                )}
            </div>
            <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-zinc-500">{detail}</span>
                {trend && (
                    <span className={cn(
                        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        trend.direction === "up" ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"
                    )}>
                        {trend.direction === "up" ? "\u2191" : "\u2193"} {trend.label}
                    </span>
                )}
            </div>
        </div>
    );
}

// ── Status Badge ───────────────────────────────────────────────────

export function OpsStatusBadge({
    status,
    label,
}: {
    status: "active" | "inactive" | "error" | "warning" | "success" | "pending" | string;
    label?: string;
}) {
    const styles: Record<string, { border: string; bg: string; text: string; dot: string }> = {
        active: { border: "border-emerald-500/25", bg: "bg-emerald-500/8", text: "text-emerald-300", dot: "bg-emerald-400" },
        success: { border: "border-emerald-500/25", bg: "bg-emerald-500/8", text: "text-emerald-300", dot: "bg-emerald-400" },
        error: { border: "border-rose-500/25", bg: "bg-rose-500/8", text: "text-rose-300", dot: "bg-rose-400" },
        warning: { border: "border-amber-500/25", bg: "bg-amber-500/8", text: "text-amber-300", dot: "bg-amber-400" },
        pending: { border: "border-amber-500/25", bg: "bg-amber-500/8", text: "text-amber-300", dot: "bg-amber-400" },
        inactive: { border: "border-zinc-600/25", bg: "bg-zinc-700/8", text: "text-zinc-400", dot: "bg-zinc-500" },
        info: { border: "border-sky-500/25", bg: "bg-sky-500/8", text: "text-sky-300", dot: "bg-sky-400" },
    };

    const s = styles[status] || styles.info;

    return (
        <span className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider",
            s.border, s.bg, s.text
        )}>
            <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
            {label || status}
        </span>
    );
}

// ── Level Badge (for error levels) ─────────────────────────────────

export function OpsLevelBadge({ level }: { level: string }) {
    const icons: Record<string, React.ElementType> = {
        error: AlertTriangle,
        warn: AlertTriangle,
        info: Info,
        debug: Info,
    };
    const Icon = icons[level] || Info;

    const styles: Record<string, string> = {
        error: "border-rose-500/25 bg-rose-500/8 text-rose-300",
        warn: "border-amber-500/25 bg-amber-500/8 text-amber-300",
        info: "border-sky-500/25 bg-sky-500/8 text-sky-300",
        debug: "border-zinc-600/25 bg-zinc-700/8 text-zinc-400",
    };

    return (
        <span className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            styles[level] || styles.info
        )}>
            <Icon className="h-3 w-3" />
            {level}
        </span>
    );
}

// ── Section ────────────────────────────────────────────────────────

export function OpsSection({
    title,
    description,
    actionHref,
    actionLabel,
    children,
}: {
    title: string;
    description?: string;
    actionHref?: string;
    actionLabel?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="space-y-4">
            <div className="flex items-end justify-between gap-4">
                <div className="space-y-1">
                    <h2 className="text-base font-semibold text-zinc-200">{title}</h2>
                    {description ? <p className="text-sm text-zinc-500">{description}</p> : null}
                </div>
                {actionHref && actionLabel ? (
                    <Link href={actionHref} className="shrink-0 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors">
                        {actionLabel} &rarr;
                    </Link>
                ) : null}
            </div>
            <div className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/30">
                {children}
            </div>
        </section>
    );
}

// ── Table ──────────────────────────────────────────────────────────

export function OpsTable({
    headers,
    children,
    empty,
}: {
    headers: string[];
    children: React.ReactNode;
    empty?: string;
}) {
    const rowCount = Children.count(children);

    return (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-800/50 text-sm">
                <thead>
                    <tr>
                        {headers.map((header) => (
                            <th key={header} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/30">
                    {rowCount > 0 ? (
                        children
                    ) : (
                        <tr>
                            <td className="px-4 py-8 text-center text-sm text-zinc-500" colSpan={headers.length}>
                                {empty || "No data."}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

// ── Card (general purpose) ─────────────────────────────────────────

export function OpsCard({
    title,
    value,
    detail,
}: {
    title: string;
    value: string;
    detail: string;
}) {
    return (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-5">
            <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{title}</div>
            <div className="mt-2 text-2xl font-bold text-zinc-100">{value}</div>
            <div className="mt-1 text-xs text-zinc-500">{detail}</div>
        </div>
    );
}

// ── Formatters ─────────────────────────────────────────────────────

export function formatDateTime(value: Date | string | null | undefined) {
    if (!value) return "Never";
    return new Date(value).toLocaleString();
}

export function formatDateOnly(value: Date | string | null | undefined) {
    if (!value) return "Never";
    return new Date(value).toLocaleDateString();
}

export function formatRelativeTime(value: Date | string | null | undefined) {
    if (!value) return "Never";
    const now = Date.now();
    const then = new Date(value).getTime();
    const diff = now - then;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return formatDateOnly(value);
}

// ── Quick Action Button ────────────────────────────────────────────

export function OpsQuickAction({
    label,
    icon: Icon,
    href,
}: {
    label: string;
    icon: React.ElementType;
    href: string;
}) {
    return (
        <Link
            href={href}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:bg-zinc-800/60 hover:text-zinc-100"
        >
            <Icon className="h-4 w-4 text-zinc-500" />
            {label}
        </Link>
    );
}
