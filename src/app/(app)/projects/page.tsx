import { db } from "@/db";
import { tasks, projects, agents, customers, artifacts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import ProjectsClient from "./projects-client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allTasks = await db.select().from(tasks).where(eq(tasks.companyId, companyId));
    const allProjects = await db.select().from(projects).where(eq(projects.companyId, companyId));
    const allAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const allCustomers = await db.select().from(customers).where(eq(customers.companyId, companyId));
    const allArtifacts = await db.select().from(artifacts).where(eq(artifacts.companyId, companyId));

    return (
        <ProjectsClient
            initialTasks={allTasks}
            projects={allProjects}
            agents={allAgents}
            customers={allCustomers}
            artifacts={allArtifacts}
        />
    );
}
