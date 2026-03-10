import { db } from "@/db";
import { tasks, projects, agents, customers, artifacts, taskEvents, chatMessages } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import ProjectsClient from "./projects-client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allTasks = await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt)));
    const allProjects = await db.select().from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
    const allAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
    const allCustomers = await db.select().from(customers).where(eq(customers.companyId, companyId));
    const allArtifacts = await db.select().from(artifacts).where(eq(artifacts.companyId, companyId));
    const allEvents = await db.select().from(taskEvents).where(eq(taskEvents.companyId, companyId));
    const allMessages = await db.select().from(chatMessages).where(eq(chatMessages.companyId, companyId)).limit(50).orderBy(chatMessages.createdAt);

    return (
        <ProjectsClient
            initialTasks={allTasks}
            projects={allProjects}
            agents={allAgents}
            customers={allCustomers}
            artifacts={allArtifacts}
            taskEvents={allEvents}
            initialMessages={allMessages}
        />
    );
}
