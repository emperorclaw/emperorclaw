import { desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resellers } from "@/db/schema";
import { OpsSection, OpsTable, OpsStatusBadge, formatDateTime } from "../ui";

export const dynamic = "force-dynamic";

export default async function OpsResellersPage() {
    const rows = await db
        .select()
        .from(resellers)
        .where(isNull(resellers.deletedAt))
        .orderBy(desc(resellers.createdAt));

    return (
        <OpsSection
            title="Resellers"
            description="Partner resellers on the platform with commission and status tracking."
        >
            <OpsTable
                headers={["Name", "Email", "Commission", "Status", "Created"]}
                empty="No resellers found."
            >
                {rows.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-zinc-800/20">
                        <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                                {r.brandColor && (
                                    <span
                                        className="inline-block h-3 w-3 rounded-full ring-1 ring-white/10"
                                        style={{ backgroundColor: r.brandColor }}
                                    />
                                )}
                                <span className="font-medium text-zinc-200">{r.name}</span>
                            </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-zinc-400">{r.email}</td>
                        <td className="px-4 py-3 text-sm text-zinc-400">
                            {r.commissionRate ?? "0"}%
                        </td>
                        <td className="px-4 py-3">
                            <OpsStatusBadge status={r.status} label={r.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500">
                            {formatDateTime(r.createdAt)}
                        </td>
                    </tr>
                ))}
            </OpsTable>
        </OpsSection>
    );
}
