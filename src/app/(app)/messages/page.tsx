import { redirect } from "next/navigation";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { MessagingHub } from "@/components/messaging-hub";
import { ensureTeamThread, getThreadMessages } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allAgents = await db.select().from(agents).where(
        and(eq(agents.companyId, companyId), isNull(agents.deletedAt))
    );
    const teamThread = await ensureTeamThread(companyId);
    const teamMessages = await getThreadMessages(companyId, teamThread.id, 100);

    return (
        <div className="h-[calc(100vh-8rem)] flex flex-col bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-500">
            <MessagingHub agents={allAgents} initialTeamMessages={teamMessages} />
        </div>
    );
}
