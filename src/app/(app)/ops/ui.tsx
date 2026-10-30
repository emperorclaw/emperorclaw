import { Children } from "react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

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

export async function OpsTable({
    headers,
    children,
    empty,
}: {
    headers: string[];
    children: React.ReactNode;
    empty?: string;
}) {
    const rowCount = Children.count(children);
    const t = await getTranslations("ops");

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
                                {empty || t("noData")}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

type DateValue = Date | string | null | undefined;

/** Date, number and "Never" formatting for the ops pages, in the viewer's language and time zone. */
export async function getOpsFormat() {
    const [t, format] = await Promise.all([getTranslations("ops"), getFormatter()]);
    return {
        dateTime: (value: DateValue) => (value ? format.dateTime(new Date(value), { dateStyle: "short", timeStyle: "medium" }) : t("never")),
        dateOnly: (value: DateValue) => (value ? format.dateTime(new Date(value), { dateStyle: "short" }) : t("never")),
        number: (value: number) => format.number(value),
    };
}
