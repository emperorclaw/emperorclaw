import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { projects, tasks, companyMembers, customers } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import ArtifactsManager from "./artifacts-manager";

export const dynamic = "force-dynamic";

export default async function ArtifactsPage() {
    const sessionUser = (await getServerSession(authOptions))?.user as { id?: string } | undefined;
    if (!sessionUser?.id) {
        redirect("/api/auth/signin");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUser.id))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    const companyId = membership.companyId;

    const projectOptions = await db.select({
        id: projects.id,
        name: projects.goal,
        customerId: projects.customerId,
    }).from(projects)
        .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)))
        .orderBy(projects.goal);

    const taskOptions = await db.select({
        id: tasks.id,
        type: tasks.taskType,
        projectId: tasks.projectId,
    }).from(tasks)
        .where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt)))
        .orderBy(tasks.taskType);

    const customerOptions = await db.select({
        id: customers.id,
        name: customers.name,
    }).from(customers)
        .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)))
        .orderBy(customers.name);

    return (
        <ArtifactsManager
            projects={projectOptions}
            tasks={taskOptions}
            customers={customerOptions}
        />
    );
}
