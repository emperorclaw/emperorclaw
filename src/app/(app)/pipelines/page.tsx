// Pipelines registry — agent-first: agents register pipelines via MCP.
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companies, companyMembers, pipelines, pipelineRuns, agents, projects, customers, tasks, users } from "@/db/schema";
import { eq, desc, and, isNull, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import PipelinesClient from "./pipelines-client";
import { splitProjectTitle } from "@/lib/project-title";
import { companyTimezoneFrom, computeNextRunAt, cronExpression, describeCron, scheduleTimezone } from "@/lib/pipeline-schedule";
import { runTaskIds } from "@/lib/pipeline-runs";
import { RealtimeRefresh } from "@/lib/use-realtime";

export const dynamic = "force-dynamic";

export default async function PipelinesPage() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) {
        redirect("/login");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    if (!membership) {
        const t = await getTranslations("common");
        return <div className="p-8 text-zinc-400">{t("companyNotFound")}</div>;
    }

    const companyId = membership.companyId;
    const locale = await getLocale();

    const pipelineList = await db.select().from(pipelines)
        .where(and(eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt)))
        .orderBy(desc(pipelines.updatedAt));

    const pipelineIds = pipelineList.map(p => p.id);
    const recentRuns = pipelineIds.length > 0
        ? await db.select().from(pipelineRuns)
            .where(and(eq(pipelineRuns.companyId, companyId), inArray(pipelineRuns.pipelineId, pipelineIds)))
            .orderBy(desc(pipelineRuns.startedAt))
            .limit(200)
        : [];

    const [company] = await db.select({ agentRoutineJson: companies.agentRoutineJson }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const companyTz = companyTimezoneFrom(company?.agentRoutineJson);
    const now = new Date();

    const agentList = await db.select({
        id: agents.id, name: agents.name, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance, budgetStatus: agents.budgetStatus,
    }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
    const projectList = await db.select({ id: projects.id, goal: projects.goal }).from(projects)
        .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
    const customerList = await db.select({ id: customers.id, name: customers.name }).from(customers)
        .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));

    // People named on the page: who created an automation, who pressed Run now.
    const personIds = [...new Set([
        ...pipelineList.filter((p) => p.createdByType === "human" && p.createdById).map((p) => p.createdById!),
        ...recentRuns.filter((r) => r.triggeredByType === "user" && r.triggeredById).map((r) => r.triggeredById!),
    ])];
    const people = personIds.length > 0
        ? await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, personIds))
        : [];

    // Titles of the tasks the recent runs handed out, for the run history links.
    const taskIds = [...new Set(recentRuns.flatMap((run) => runTaskIds(run)))].slice(0, 500);
    const taskRows = taskIds.length > 0
        ? await db.select({ id: tasks.id, inputJson: tasks.inputJson }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds)))
        : [];

    const rows = pipelineList.map((pipeline) => {
        const cron = pipeline.trigger === "cron" ? cronExpression(pipeline.triggerConfig) : null;
        const next = pipeline.status !== "active" ? null
            : pipeline.scheduledBy === "emperor" && pipeline.nextRunAt ? pipeline.nextRunAt
                : computeNextRunAt(pipeline, companyTz, now);
        return {
            ...pipeline,
            schedule: pipeline.trigger === "cron" ? {
                cron,
                description: cron ? describeCron(cron, locale) : null,
                timezone: scheduleTimezone(pipeline.triggerConfig, companyTz),
                nextRunAt: next ? next.toISOString() : null,
            } : null,
        };
    });

    return (
        <>
            <RealtimeRefresh topics={["automations"]} />
            <PipelinesClient
                initialPipelines={JSON.parse(JSON.stringify(rows))}
                initialRuns={JSON.parse(JSON.stringify(recentRuns))}
                agents={JSON.parse(JSON.stringify(agentList))}
                agentsMap={Object.fromEntries(agentList.map(a => [a.id, a.name]))}
                projectsMap={Object.fromEntries(projectList.map(p => [p.id, splitProjectTitle(p.goal).name]))}
                customersMap={Object.fromEntries(customerList.map(c => [c.id, c.name]))}
                peopleMap={Object.fromEntries(people.map((p) => [p.id, p.displayName || p.email]))}
                tasksMap={Object.fromEntries(taskRows.map((task) => {
                    const title = (task.inputJson as { title?: unknown } | null)?.title;
                    return [task.id, typeof title === "string" ? title : ""];
                }))}
                canEdit={membership.role !== "viewer"}
            />
        </>
    );
}
