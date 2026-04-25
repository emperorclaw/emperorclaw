import { desc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { OpsSection, OpsTable, formatDateOnly, formatDateTime } from "../ui";

export const dynamic = "force-dynamic";

export default async function OpsUsersPage() {
    const rows = await db.select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        emailVerifiedAt: users.emailVerifiedAt,
        companyCount: sql<number>`(
            select count(distinct company_id)
            from company_members
            where company_members.user_id = ${users.id}
        )`,
        lastSessionAt: sql<Date | null>`(
            select max(created_at)
            from sessions
            where sessions.user_id = ${users.id}
        )`,
    }).from(users).where(isNull(users.deletedAt)).orderBy(desc(users.createdAt));

    return (
        <OpsSection
            title="Users"
            description="Platform-wide account list with verification and recent activity."
        >
            <OpsTable headers={["Email", "Created", "Verified", "Companies", "Last Session"]} empty="No users found.">
                {rows.map((user) => (
                    <tr key={user.id}>
                        <td className="px-4 py-3">
                            <div className="font-medium text-zinc-200">{user.email}</div>
                            <div className="text-xs text-zinc-500">{user.id}</div>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">{formatDateOnly(user.createdAt)}</td>
                        <td className="px-4 py-3 text-zinc-400">
                            {user.emailVerifiedAt ? (
                                <span className="text-emerald-300">{formatDateTime(user.emailVerifiedAt)}</span>
                            ) : (
                                <span className="text-amber-300">Pending</span>
                            )}
                        </td>
                        <td className="px-4 py-3 text-zinc-400">{user.companyCount}</td>
                        <td className="px-4 py-3 text-zinc-400">{formatDateTime(user.lastSessionAt)}</td>
                    </tr>
                ))}
            </OpsTable>
        </OpsSection>
    );
}
