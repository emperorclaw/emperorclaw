import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, opsEvents, runtimeNodes, users } from "@/db/schema";
import { OpsCard, OpsSection, OpsTable, formatDateTime } from "./ui";

export const dynamic = "force-dynamic";

export default async function OpsOverviewPage() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
        [{ count: totalUsers }],
        [{ count: verifiedUsers }],
        [{ count: totalCompanies }],
        [{ count: totalAgents }],
        [{ count: activeRuntimes }],
        [{ count: errorsLast24h }],
        recentErrors,
        recentUsers,
    ] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(users).where(isNull(users.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(users).where(and(isNull(users.deletedAt), sql`${users.emailVerifiedAt} is not null`)),
        db.select({ count: sql<number>`count(*)` }).from(companies).where(isNull(companies.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(agents).where(isNull(agents.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(runtimeNodes).where(and(isNull(runtimeNodes.deletedAt), eq(runtimeNodes.status, "active"))),
        db.select({ count: sql<number>`count(*)` }).from(opsEvents).where(and(eq(opsEvents.level, "error"), gte(opsEvents.createdAt, last24h))),
        db.select().from(opsEvents).orderBy(desc(opsEvents.createdAt)).limit(10),
        db.select({
            id: users.id,
            email: users.email,
            createdAt: users.createdAt,
            emailVerifiedAt: users.emailVerifiedAt,
        }).from(users).where(isNull(users.deletedAt)).orderBy(desc(users.createdAt)).limit(8),
    ]);

    const verificationRate = totalUsers > 0 ? Math.round((verifiedUsers / totalUsers) * 100) : 0;

    return (
        <div className="space-y-8 pb-12">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <OpsCard title="Users" value={String(totalUsers)} detail={`${verifiedUsers} verified (${verificationRate}%)`} />
                <OpsCard title="Companies" value={String(totalCompanies)} detail="Active workspaces on the platform" />
                <OpsCard title="Agents" value={String(totalAgents)} detail="Registered durable worker identities" />
                <OpsCard title="Active Runtimes" value={String(activeRuntimes)} detail="Runtime nodes reporting active status" />
                <OpsCard title="Errors (24h)" value={String(errorsLast24h)} detail="Ops events recorded at error level in the last 24 hours" />
                <OpsCard title="Recent Signups" value={String(recentUsers.length)} detail="Newest accounts created on the platform" />
            </div>

            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
                <OpsSection
                    title="Recent Platform Errors"
                    description="Newest captured server and auth/mailer failures."
                    actionHref="/ops/errors"
                    actionLabel="Open full error feed"
                >
                    <OpsTable headers={["When", "Level", "Source", "Message"]} empty="No ops events recorded yet.">
                        {recentErrors.map((event) => (
                            <tr key={event.id} className="align-top">
                                <td className="px-4 py-3 text-zinc-400">{formatDateTime(event.createdAt)}</td>
                                <td className="px-4 py-3">
                                    <span className={`rounded border px-2 py-1 text-xs uppercase tracking-wider ${
                                        event.level === "error"
                                            ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                                            : event.level === "warn"
                                                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                                : "border-zinc-700 bg-zinc-800/60 text-zinc-300"
                                    }`}>
                                        {event.level}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-zinc-300">{event.source}</td>
                                <td className="px-4 py-3 text-zinc-400">{event.message}</td>
                            </tr>
                        ))}
                    </OpsTable>
                </OpsSection>

                <OpsSection
                    title="Newest Users"
                    description="Recent account creation and verification state."
                    actionHref="/ops/users"
                    actionLabel="Open user directory"
                >
                    <OpsTable headers={["Email", "Created", "Verified"]} empty="No users found.">
                        {recentUsers.map((user) => (
                            <tr key={user.id}>
                                <td className="px-4 py-3 text-zinc-200">{user.email}</td>
                                <td className="px-4 py-3 text-zinc-400">{formatDateTime(user.createdAt)}</td>
                                <td className="px-4 py-3 text-zinc-400">
                                    {user.emailVerifiedAt ? (
                                        <span className="text-emerald-300">Verified</span>
                                    ) : (
                                        <span className="text-amber-300">Pending</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </OpsTable>
                </OpsSection>
            </div>
        </div>
    );
}
