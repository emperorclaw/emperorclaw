import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companyMembers, projects, tasks, users } from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { getScopeFromSession, getScopedAgentIds } from "@/lib/member-scope";
import {
    entityKey,
    MAX_ENTITY_REFS,
    parseEntityKey,
    taskTitle,
    type EntityRef,
    type EntitySummary,
} from "@/lib/emperor-entities";

export const dynamic = "force-dynamic";

/**
 * Live summaries for `emperor://` record links in chat messages.
 *
 * GET /api/ui/entities?refs=task:<uuid>,project:<uuid>,agent:<uuid>
 *
 * Visibility mirrors the app: records are always company-scoped, and agents
 * honor a restricted member's agent scope exactly like the Agents page. A ref
 * the viewer can't see — another company's, deleted, out of scope — comes back
 * as null, indistinguishable from one that doesn't exist.
 */
export async function GET(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const session = await getValidatedServerSession();
    const scopedAgentIds = session ? getScopedAgentIds(getScopeFromSession(session)) : undefined;

    const refs: EntityRef[] = [];
    const seen = new Set<string>();
    for (const raw of (req.nextUrl.searchParams.get("refs") || "").split(",")) {
        const ref = parseEntityKey(raw.trim());
        if (!ref || seen.has(entityKey(ref))) continue;
        seen.add(entityKey(ref));
        refs.push(ref);
        if (refs.length >= MAX_ENTITY_REFS) break;
    }
    const entities: Record<string, EntitySummary | null> = Object.fromEntries(refs.map((r) => [entityKey(r), null]));
    if (refs.length === 0) return NextResponse.json({ entities });

    const idsOf = (kind: EntityRef["kind"]) => refs.filter((r) => r.kind === kind).map((r) => r.id);
    const taskIds = idsOf("task");
    const projectIds = idsOf("project");
    let agentIds = idsOf("agent");
    if (scopedAgentIds) {
        const allowed = new Set(scopedAgentIds);
        agentIds = agentIds.filter((id) => allowed.has(id));
    }

    try {
        const [taskRows, projectRows, agentRows] = await Promise.all([
            taskIds.length
                ? db.select().from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds), isNull(tasks.deletedAt)))
                : Promise.resolve([]),
            projectIds.length
                ? db.select().from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds), isNull(projects.deletedAt)))
                : Promise.resolve([]),
            agentIds.length
                ? db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds), isNull(agents.deletedAt)))
                : Promise.resolve([]),
        ]);

        // Names for the people and agents those records point at, plus the
        // task counts shown on project and agent cards.
        const relatedAgentIds = [...new Set([
            ...taskRows.map((t) => t.assignedAgentId),
            ...projectRows.map((p) => p.leadAgentId),
        ].filter((id): id is string => Boolean(id)))];
        const memberIds = [...new Set(taskRows.map((t) => t.assignedMemberId).filter((id): id is string => Boolean(id)))];
        const taskProjectIds = [...new Set(taskRows.map((t) => t.projectId))];

        const [relatedAgents, members, taskProjects, projectCounts, agentCounts] = await Promise.all([
            relatedAgentIds.length
                ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, relatedAgentIds)))
                : Promise.resolve([]),
            memberIds.length
                ? db.select({ id: companyMembers.id, displayName: users.displayName, email: users.email })
                    .from(companyMembers)
                    .innerJoin(users, eq(users.id, companyMembers.userId))
                    .where(and(eq(companyMembers.companyId, companyId), inArray(companyMembers.id, memberIds)))
                : Promise.resolve([]),
            taskProjectIds.length
                ? db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, taskProjectIds)))
                : Promise.resolve([]),
            projectRows.length
                ? db.select({
                    projectId: tasks.projectId,
                    done: sql<number>`count(*) filter (where ${tasks.state} = 'done')`,
                    open: sql<number>`count(*) filter (where ${tasks.state} <> 'done')`,
                }).from(tasks)
                    .where(and(eq(tasks.companyId, companyId), inArray(tasks.projectId, projectRows.map((p) => p.id)), isNull(tasks.deletedAt)))
                    .groupBy(tasks.projectId)
                : Promise.resolve([]),
            agentRows.length
                ? db.select({ agentId: tasks.assignedAgentId, open: sql<number>`count(*)` }).from(tasks)
                    .where(and(
                        eq(tasks.companyId, companyId),
                        inArray(tasks.assignedAgentId, agentRows.map((a) => a.id)),
                        sql`${tasks.state} <> 'done'`,
                        isNull(tasks.deletedAt),
                    ))
                    .groupBy(tasks.assignedAgentId)
                : Promise.resolve([]),
        ]);

        const agentName = new Map(relatedAgents.map((a) => [a.id, a.name]));
        const memberName = new Map(members.map((m) => [m.id, m.displayName || m.email]));
        const projectName = new Map(taskProjects.map((p) => [p.id, p.goal]));
        const projectCount = new Map(projectCounts.map((c) => [c.projectId, c]));
        const agentOpen = new Map(agentCounts.map((c) => [c.agentId, Number(c.open) || 0]));

        for (const t of taskRows) {
            entities[`task:${t.id}`] = {
                kind: "task",
                id: t.id,
                title: taskTitle(t),
                state: t.state,
                priority: t.priority,
                assignee: t.assignedAgentId ? agentName.get(t.assignedAgentId) ?? null : t.assignedMemberId ? memberName.get(t.assignedMemberId) ?? null : null,
                project: projectName.get(t.projectId) ?? null,
                dueAt: t.slaDueAt ? t.slaDueAt.toISOString() : null,
                updatedAt: t.updatedAt.toISOString(),
                href: `/projects?project=${t.projectId}&task=${t.id}`,
            };
        }
        for (const p of projectRows) {
            const counts = projectCount.get(p.id);
            entities[`project:${p.id}`] = {
                kind: "project",
                id: p.id,
                title: p.goal,
                status: p.status,
                lead: p.leadAgentId ? agentName.get(p.leadAgentId) ?? null : null,
                openTasks: Number(counts?.open) || 0,
                doneTasks: Number(counts?.done) || 0,
                href: `/projects?project=${p.id}`,
            };
        }
        for (const a of agentRows) {
            entities[`agent:${a.id}`] = {
                kind: "agent",
                id: a.id,
                title: a.name,
                role: a.role,
                status: a.status,
                load: a.currentLoad,
                openTasks: agentOpen.get(a.id) ?? 0,
                avatarUrl: a.avatarUrl,
                lastSeenAt: a.lastSeenAt ? a.lastSeenAt.toISOString() : null,
                href: `/agents/${a.id}`,
            };
        }
        return NextResponse.json({ entities }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("Entity lookup failed:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
