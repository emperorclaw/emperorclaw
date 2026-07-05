import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, opsEvents, runtimeNodes, users } from "@/db/schema";
import {
    OpsStatCard,
    OpsSection,
    OpsTable,
    OpsLevelBadge,
    OpsStatusBadge,
    OpsQuickAction,
    formatDateTime,
    formatRelativeTime,
} from "./ui";
import {
    Users,
    Building2,
    Bot,
    Radio,
    AlertTriangle,
    UserPlus,
    Search,
    Download,
    RefreshCw,
    Activity,
} from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OpsOverviewPage() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last1h = new Date(now.getTime() - 60 * 60 * 1000);

    const [
        [{ count: totalUsers }],
        [{ count: verifiedUsers }],
        [{ count: usersLast7d }],
        [{ count: totalCompanies }],
        [{ count: totalAgents }],
        [{ count: activeRuntimes }],
        [{ count: errorsLast24h }],
        [{ count: errorsLast1h }],
        recentErrors,
        recentUsers,
    ] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(users).where(isNull(users.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(users).where(and(isNull(users.deletedAt), sql`${users.emailVerifiedAt} is not null`)),
        db.select({ count: sql<number>`count(*)` }).from(users).where(and(isNull(users.deletedAt), gte(users.createdAt, last7d))),
        db.select({ count: sql<number>`count(*)` }).from(companies).where(isNull(companies.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(agents).where(isNull(agents.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(runtimeNodes).where(and(isNull(runtimeNodes.deletedAt), eq(runtimeNodes.status, "active"))),
        db.select({ count: sql<number>`count(*)` }).from(opsEvents).where(and(eq(opsEvents.level, "error"), gte(opsEvents.createdAt, last24h))),
        db.select({ count: sql<number>`count(*)` }).from(opsEvents).where(and(eq(opsEvents.level, "error"), gte(opsEvents.createdAt, last1h))),
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
            {/* Page header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-semibold text-zinc-100">Dashboard</h1>
                    <p className="mt-1 text-sm text-zinc-500">
                        Platform-wide metrics and recent activity
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search platform..."
                            className="h-9 w-56 rounded-lg border border-zinc-800 bg-zinc-900/60 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-indigo-500/40 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
                            readOnly
                        />
                    </div>
                    <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 text-sm text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 transition-colors">
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                    </button>
                </div>
            </div>

            {/* Quick actions */}
            <div className="flex flex-wrap gap-2">
                <OpsQuickAction label="Browse Users" icon={Users} href="/ops/users" />
                <OpsQuickAction label="View Companies" icon={Building2} href="/ops/companies" />
                <OpsQuickAction label="Error Feed" icon={AlertTriangle} href="/ops/errors" />
                <OpsQuickAction label="Runtimes" icon={Radio} href="/ops/runtimes" />
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                <OpsStatCard
                    title="Total Users"
                    value={String(totalUsers)}
                    detail={`${verifiedUsers} verified (${verificationRate}%)`}
                    icon={Users}
                    accent="indigo"
                    trend={{ direction: usersLast7d > 0 ? "up" : "down", label: `${usersLast7d} in 7d` }}
                />
                <OpsStatCard
                    title="Companies"
                    value={String(totalCompanies)}
                    detail="Active workspaces on the platform"
                    icon={Building2}
                    accent="violet"
                />
                <OpsStatCard
                    title="Agents"
                    value={String(totalAgents)}
                    detail="Registered durable worker identities"
                    icon={Bot}
                    accent="cyan"
                />
                <OpsStatCard
                    title="Active Runtimes"
                    value={String(activeRuntimes)}
                    detail="Runtime nodes reporting active status"
                    icon={Radio}
                    accent="emerald"
                />
                <OpsStatCard
                    title="Errors (24h)"
                    value={String(errorsLast24h)}
                    detail={`${errorsLast1h} in the last hour`}
                    icon={AlertTriangle}
                    accent={errorsLast24h > 0 ? "rose" : "emerald"}
                    trend={errorsLast24h > 0 ? { direction: "down", label: `${errorsLast1h}/hr` } : undefined}
                />
                <OpsStatCard
                    title="Recent Signups"
                    value={String(recentUsers.length)}
                    detail="Newest accounts on the platform"
                    icon={UserPlus}
                    accent="amber"
                />
            </div>

            {/* Tables */}
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
                <OpsSection
                    title="Recent Platform Errors"
                    description="Newest captured server and auth/mailer failures."
                    actionHref="/ops/errors"
                    actionLabel="View all errors"
                >
                    <OpsTable headers={["When", "Level", "Source", "Message"]} empty="No ops events recorded yet.">
                        {recentErrors.map((event) => (
                            <tr key={event.id} className="align-top transition-colors hover:bg-zinc-800/20">
                                <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">
                                    <div>{formatRelativeTime(event.createdAt)}</div>
                                    <div className="text-[10px] text-zinc-600">{formatDateTime(event.createdAt)}</div>
                                </td>
                                <td className="px-4 py-3">
                                    <OpsLevelBadge level={event.level} />
                                </td>
                                <td className="px-4 py-3">
                                    <div className="text-sm text-zinc-300">{event.source}</div>
                                    {event.category && (
                                        <div className="text-[10px] text-zinc-600">{event.category}</div>
                                    )}
                                </td>
                                <td className="max-w-xs px-4 py-3">
                                    <div className="truncate text-sm text-zinc-400" title={event.message}>
                                        {event.message}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </OpsTable>
                </OpsSection>

                <OpsSection
                    title="Newest Users"
                    description="Recent account creation and verification state."
                    actionHref="/ops/users"
                    actionLabel="View all users"
                >
                    <OpsTable headers={["Email", "Created", "Status"]} empty="No users found.">
                        {recentUsers.map((user) => (
                            <tr key={user.id} className="transition-colors hover:bg-zinc-800/20">
                                <td className="px-4 py-3">
                                    <div className="font-medium text-zinc-200">{user.email}</div>
                                    <div className="truncate text-[10px] text-zinc-600">{user.id}</div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500">
                                    <div>{formatRelativeTime(user.createdAt)}</div>
                                    <div className="text-[10px] text-zinc-600">{formatDateTime(user.createdAt)}</div>
                                </td>
                                <td className="px-4 py-3">
                                    {user.emailVerifiedAt ? (
                                        <OpsStatusBadge status="success" label="Verified" />
                                    ) : (
                                        <OpsStatusBadge status="pending" label="Pending" />
                                    )}
                                </td>
                            </tr>
                        ))}
                    </OpsTable>
                </OpsSection>
            </div>

            {/* Footer hint */}
            <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/20 px-5 py-3 text-xs text-zinc-600">
                <Activity className="mr-1.5 inline-block h-3 w-3 text-zinc-600" />
                Platform Ops Dashboard &mdash; Data refreshes on page load. Some metrics are cached.
            </div>
        </div>
    );
}
