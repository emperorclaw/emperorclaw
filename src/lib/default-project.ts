import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { recordProjectAudit, type AuditActor } from "@/lib/audit";

/** Where the first task of a workspace with no projects goes. */
export const DEFAULT_PROJECT_GOAL = "General";

/**
 * Every task lives in a project, and a new workspace has none, so its first
 * "Create task" could not be submitted. The task dialog offers this instead of
 * a project picker: the company's "General" project, created on first use and
 * reused after that. Serialized per company so two first tasks share one.
 */
export async function ensureDefaultProject(companyId: string, actor: AuditActor): Promise<string> {
    const { id, created } = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`default-project:${companyId}`}))`);
        const [existing] = await tx.select({ id: projects.id }).from(projects)
            .where(and(eq(projects.companyId, companyId), eq(projects.goal, DEFAULT_PROJECT_GOAL), isNull(projects.deletedAt))).limit(1);
        if (existing) return { id: existing.id, created: null };
        const [project] = await tx.insert(projects).values({ companyId, goal: DEFAULT_PROJECT_GOAL, status: "active" }).returning();
        return { id: project.id, created: project };
    });
    if (created) await recordProjectAudit(companyId, actor, "project.created", created);
    return id;
}
