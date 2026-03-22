import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { artifacts, projects, tasks, companyMembers, customers } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import ArtifactsClient from "./artifacts-client";

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

    const initialArtifacts = await db.select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        artifactClass: artifacts.artifactClass,
        importance: artifacts.importance,
        contentType: artifacts.contentType,
        contentText: artifacts.contentText,
        storageUrl: artifacts.storageUrl,
        originalFilename: artifacts.originalFilename,
        sizeBytes: artifacts.sizeBytes,
        isCanonical: artifacts.isCanonical,
        createdAt: artifacts.createdAt,
        projectId: projects.id,
        projectGoal: projects.goal,
        customerId: customers.id,
        customerName: customers.name,
        taskType: tasks.taskType,
    }).from(artifacts)
        .leftJoin(projects, eq(artifacts.projectId, projects.id))
        .leftJoin(customers, eq(projects.customerId, customers.id))
        .leftJoin(tasks, eq(artifacts.taskId, tasks.id))
        .where(and(eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt)))
        .orderBy(desc(artifacts.createdAt));

    return <ArtifactsClient initialArtifacts={initialArtifacts} />;
}
