import { db } from "@/db";
import { incidents } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import { IncidentRow } from "./incident-row";

export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allIncidents = await db.select().from(incidents)
        .where(and(eq(incidents.companyId, companyId), isNull(incidents.deletedAt)))
        .orderBy(desc(incidents.createdAt));

    return (
        <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex flex-col space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Needs Attention</h1>
                <p className="text-sm text-zinc-500 font-medium">Items that need a human or lead agent to review.</p>
            </div>

            <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl overflow-hidden shadow-sm">
                <div className="grid grid-cols-12 gap-4 p-4 border-b border-zinc-800/50 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    <div className="col-span-1">Level</div>
                    <div className="col-span-2">Task</div>
                    <div className="col-span-5">Item</div>
                    <div className="col-span-2">Time</div>
                    <div className="col-span-2 text-right">Action</div>
                </div>

                <div className="divide-y divide-zinc-800/30">
                    {allIncidents.length === 0 ? (
                        <div className="p-8 text-center text-sm text-zinc-500">
                            Nothing needs attention right now.
                        </div>
                    ) : (
                        allIncidents.map(inc => (
                            <IncidentRow
                                key={inc.id}
                                id={inc.id}
                                severity={inc.severity}
                                taskId={inc.taskId ? `TASK-${inc.taskId.substring(0, 8)}` : "System"}
                                summary={inc.summary}
                                time={new Date(inc.createdAt).toLocaleString()}
                                status={inc.status}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

