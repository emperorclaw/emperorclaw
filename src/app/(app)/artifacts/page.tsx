import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { artifacts, projects, tasks, companyMembers } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import ArtifactsClient from "./artifacts-client";

export const dynamic = "force-dynamic";

export default async function ArtifactsPage() {
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

    const initialArtifacts = await db.select({
        id: artifacts.id,
        kind: artifacts.kind,
        contentType: artifacts.contentType,
        contentText: artifacts.contentText,
        storageUrl: artifacts.storageUrl,
        sizeBytes: artifacts.sizeBytes,
        createdAt: artifacts.createdAt,
        projectGoal: projects.goal,
        taskType: tasks.taskType,
    }).from(artifacts)
        .leftJoin(projects, eq(artifacts.projectId, projects.id))
        .leftJoin(tasks, eq(artifacts.taskId, tasks.id))
        .where(and(eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt)))
        .orderBy(desc(artifacts.createdAt));

    return <ArtifactsClient initialArtifacts={initialArtifacts} />;
}
