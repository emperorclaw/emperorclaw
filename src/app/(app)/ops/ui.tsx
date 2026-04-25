import { Children } from "react";
import Link from "next/link";

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
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="text-sm font-medium text-zinc-500">{title}</div>
            <div className="mt-3 text-3xl font-semibold text-zinc-100">{value}</div>
            <div className="mt-2 text-xs text-zinc-500">{detail}</div>
        </div>
    );
}

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
                    <h2 className="text-lg font-medium text-zinc-200">{title}</h2>
                    {description ? <p className="text-sm text-zinc-500">{description}</p> : null}
                </div>
                {actionHref && actionLabel ? (
                    <Link href={actionHref} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                        {actionLabel}
                    </Link>
                ) : null}
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
                {children}
            </div>
        </section>
    );
}

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
            <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-950/70">
                    <tr>
                        {headers.map((header) => (
                            <th key={header} className="px-4 py-3 text-left font-medium text-zinc-400">
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                    {rowCount > 0 ? children : (
                        <tr>
                            <td className="px-4 py-6 text-zinc-500" colSpan={headers.length}>
                                {empty || "No data."}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

export function formatDateTime(value: Date | string | null | undefined) {
    if (!value) return "Never";
    return new Date(value).toLocaleString();
}

export function formatDateOnly(value: Date | string | null | undefined) {
    if (!value) return "Never";
    return new Date(value).toLocaleDateString();
}
