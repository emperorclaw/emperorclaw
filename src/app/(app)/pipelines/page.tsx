import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { playbooks, schedules, companyMembers, projects, customers } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import PipelinesClient from "./pipelines-client";

export const dynamic = "force-dynamic";

export default async function PipelinesPage() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user || !(session.user as any).id) {
        redirect("/login");
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

    // Fetch Projects map for the human-readable table
    const projectList = await db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));

    const projectsMap: Record<string, string> = {};
    projectList.forEach(p => {
        projectsMap[p.id] = p.goal;
    });

    // Fetch Customers map
    const customerList = await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, companyId));

    const customersMap: Record<string, string> = {};
    customerList.forEach(c => {
        customersMap[c.id] = c.name;
    });

    return <PipelinesClient
        initialPlaybooks={playbookList}
        initialSchedules={scheduleList}
        projectsMap={projectsMap}
        customersMap={customersMap}
    />;
}
