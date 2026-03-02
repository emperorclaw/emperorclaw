import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { playbooks, schedules, companyMembers, projects } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import PipelinesClient from "./pipelines-client";

export const dynamic = "force-dynamic";

export default async function PipelinesPage() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user || !(session.user as any).id) {
        redirect("/api/auth/signin");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, (session.user as any).id))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    const companyId = membership.companyId;

    // Fetch Playbooks
    const playbookList = await db.select().from(playbooks)
        .where(eq(playbooks.companyId, companyId))
        .orderBy(desc(playbooks.createdAt));

    // Fetch Schedules
    const scheduleList = await db.select().from(schedules)
        .where(eq(schedules.companyId, companyId))
        .orderBy(desc(schedules.createdAt));

    // Fetch Projects map for the human-readable table (just id to Name)
    const projectList = await db.select({ id: projects.id, goal: projects.goal }).from(projects).where(eq(projects.companyId, companyId));

    // Convert to dictionary
    const projectsMap: Record<string, string> = {};
    projectList.forEach(p => {
        projectsMap[p.id] = p.goal;
    });

    return <PipelinesClient
        initialPlaybooks={playbookList}
        initialSchedules={scheduleList}
        projectsMap={projectsMap}
    />;
}
