/**
 * Sample client for a new workspace (roadmap 12.7): one clearly labelled
 * customer, one project, three tasks in different states and one knowledge
 * note, so the board, the customer page and Knowledge & Rules aren't empty
 * on day one.
 *
 * Every sample row is tagged in a JSON field that already exists (no
 * migration), and removal deletes only rows that carry the tag:
 *   - project: kpi_targets_json.sample = { kind, customerId, noteId }
 *     (the manifest; kpi_targets_json is otherwise unused)
 *   - tasks:   input_json.sample = SAMPLE_TAG
 *   - note:    a resource_tags row "sample-client", and its id in the manifest
 *   - customer: has no JSON column, so it is the manifest's customerId, and
 *     only while its name still starts with "Sample:".
 * Anything a person or agent added later (another task in the sample
 * project, another project for the sample customer) is never deleted; the
 * container it lives in is kept too.
 *
 * Tasks are created in states the automation leaves alone (done, blocked,
 * review with no assignee), so no agent picks sample work up and spends on it.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, projects, resourceTags, scopedResources, tasks } from "@/db/schema";
import { createScopedResource } from "@/lib/resources";
import { humanActor, recordAudit } from "@/lib/audit";
import { TASK_STATES } from "@/lib/task-state";

export const SAMPLE_TAG = "sample_client";
export const SAMPLE_RESOURCE_TAG = "sample-client";
export const SAMPLE_CUSTOMER_NAME = "Sample: Harbor Dental";
const SAMPLE_NAME_PREFIX = "Sample:";

export type SampleManifest = { kind: typeof SAMPLE_TAG; customerId: string; noteId: string | null };

export type SamplePlan = {
    customer: { name: string; notes: string };
    project: { goal: string };
    tasks: { title: string; state: string; description: string; priority: number }[];
    note: { name: string; displayName: string; body: string };
};

/** The rows the sample creates. Pure, so the content is unit-tested. */
export function sampleClientPlan(): SamplePlan {
    return {
        customer: {
            name: SAMPLE_CUSTOMER_NAME,
            notes: "Sample data to explore Emperor. A two-clinic dental practice that wants more new-patient bookings. Remove it any time in Settings.",
        },
        project: { goal: "Sample: Harbor Dental — new-patient campaign" },
        tasks: [
            {
                title: "Sample: Audit the booking page",
                state: TASK_STATES.done,
                priority: 1,
                description: "Check the online booking flow on mobile and desktop and list what slows a new patient down.",
            },
            {
                title: "Sample: Draft three Google Ads headlines",
                state: TASK_STATES.review,
                priority: 2,
                description: "Write three headline options for the cleaning-and-checkup offer, then send them for review.",
            },
            {
                title: "Sample: Collect five patient reviews",
                state: TASK_STATES.blocked,
                priority: 0,
                description: "Blocked until the clinic sends the list of patients who agreed to be contacted.",
            },
        ],
        note: {
            name: "sample-harbor-dental-brief",
            displayName: "Sample: Harbor Dental brief",
            body: [
                "# Harbor Dental (sample)",
                "",
                "This is sample data. Remove it in Settings → Remove sample data.",
                "",
                "- Two clinics, open Monday to Saturday.",
                "- Goal: 40 new-patient bookings a month.",
                "- Tone: warm and plain; never promise prices in ads.",
            ].join("\n"),
        },
    };
}

/** Does this JSON value carry the sample tag (task input_json)? */
export function hasSampleTag(json: unknown): boolean {
    return Boolean(json && typeof json === "object" && (json as { sample?: unknown }).sample === SAMPLE_TAG);
}

/** The manifest in a sample project's kpi_targets_json, else null. */
export function sampleManifest(json: unknown): SampleManifest | null {
    const sample = json && typeof json === "object" ? (json as { sample?: unknown }).sample : null;
    if (!sample || typeof sample !== "object") return null;
    const m = sample as Partial<SampleManifest>;
    if (m.kind !== SAMPLE_TAG || typeof m.customerId !== "string") return null;
    return { kind: SAMPLE_TAG, customerId: m.customerId, noteId: typeof m.noteId === "string" ? m.noteId : null };
}

/** Offer the sample only to owners/admins of a workspace with no customers and no sample yet. */
export function canOfferSampleClient(input: { isAdmin: boolean; customerCount: number; hasSample: boolean }): boolean {
    return input.isAdmin && input.customerCount === 0 && !input.hasSample;
}

const sampleProjectCondition = (companyId: string) => and(
    eq(projects.companyId, companyId),
    sql`${projects.kpiTargetsJson} -> 'sample' ->> 'kind' = ${SAMPLE_TAG}`,
);

export async function sampleClientStatus(companyId: string): Promise<{ hasSample: boolean; customerCount: number }> {
    const [[sample], [count]] = await Promise.all([
        db.select({ id: projects.id }).from(projects).where(sampleProjectCondition(companyId)).limit(1),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt))),
    ]);
    return { hasSample: Boolean(sample), customerCount: count?.n ?? 0 };
}

export class SampleClientConflict extends Error {}

export type CreatedSample = { customerId: string; projectId: string; taskIds: string[]; noteId: string };

export async function createSampleClient(companyId: string, userId: string | null): Promise<CreatedSample> {
    const plan = sampleClientPlan();
    const created = await db.transaction(async (tx) => {
        // One at a time per company: a double click must not seed twice.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sample-client:${companyId}`}))`);
        const [existing] = await tx.select({ id: projects.id }).from(projects).where(sampleProjectCondition(companyId)).limit(1);
        if (existing) throw new SampleClientConflict("This workspace already has the sample client.");
        const [count] = await tx.select({ n: sql<number>`COUNT(*)::int` }).from(customers)
            .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));
        if ((count?.n ?? 0) > 0) throw new SampleClientConflict("The sample client is only for a workspace with no customers yet.");

        const [customer] = await tx.insert(customers).values({ companyId, name: plan.customer.name, notes: plan.customer.notes }).returning();
        const manifest: SampleManifest = { kind: SAMPLE_TAG, customerId: customer.id, noteId: null };
        const [project] = await tx.insert(projects).values({
            companyId, customerId: customer.id, goal: plan.project.goal, status: "active", kpiTargetsJson: { sample: manifest },
        }).returning();
        const taskRows = await tx.insert(tasks).values(plan.tasks.map((task) => ({
            companyId,
            projectId: project.id,
            taskType: "work",
            state: task.state,
            priority: task.priority,
            inputJson: { title: task.title, description: task.description, sample: SAMPLE_TAG },
        }))).returning({ id: tasks.id });
        return { customerId: customer.id, projectId: project.id, taskIds: taskRows.map((row) => row.id), manifest };
    });

    // Knowledge notes go through their own helper (versions, brain metadata,
    // audit); it is not transactional, so a failure here removes the rest.
    try {
        const note = await createScopedResource({
            companyId,
            scopeType: "customer",
            scopeId: created.customerId,
            provider: "knowledge",
            resourceType: "knowledge_base",
            name: plan.note.name,
            displayName: plan.note.displayName,
            path: "",
            configText: plan.note.body,
            status: "active",
            ownership: "managed",
            // Only surfaced on request: sample text never enters an agent's context on its own.
            inject: "on_request",
            changeSummary: "Sample client",
            createdByType: "human",
            createdById: userId,
            actor: humanActor(userId),
        });
        await db.insert(resourceTags).values({ companyId, resourceId: note.id, tag: SAMPLE_RESOURCE_TAG });
        await db.update(projects).set({ kpiTargetsJson: { sample: { ...created.manifest, noteId: note.id } } }).where(eq(projects.id, created.projectId));
        await recordAudit({ companyId, actor: humanActor(userId), action: "customer.created", target: { type: "customer", id: created.customerId }, after: { name: plan.customer.name }, meta: { sample: true } });
        return { customerId: created.customerId, projectId: created.projectId, taskIds: created.taskIds, noteId: note.id };
    } catch (error) {
        await removeSampleData(companyId, userId).catch(() => undefined);
        throw error;
    }
}

export type RemovedSample = { customers: number; projects: number; tasks: number; notes: number; keptProjects: number; keptCustomers: number };

/**
 * Delete exactly the tagged rows. A sample project that now holds untagged
 * tasks is kept (with those tasks); a sample customer that still has other
 * projects is kept.
 */
export async function removeSampleData(companyId: string, userId: string | null = null): Promise<RemovedSample> {
    const removedCustomers: string[] = [];
    const result = await db.transaction(async (tx) => {
        const sampleProjects = await tx.select({ id: projects.id, customerId: projects.customerId, kpiTargetsJson: projects.kpiTargetsJson })
            .from(projects).where(sampleProjectCondition(companyId)).for("update");
        const result: RemovedSample = { customers: 0, projects: 0, tasks: 0, notes: 0, keptProjects: 0, keptCustomers: 0 };
        if (sampleProjects.length === 0) return result;
        const projectIds = sampleProjects.map((p) => p.id);
        const manifests = sampleProjects.map((p) => sampleManifest(p.kpiTargetsJson)).filter((m): m is SampleManifest => m !== null);

        const deletedTasks = await tx.delete(tasks).where(and(
            eq(tasks.companyId, companyId),
            inArray(tasks.projectId, projectIds),
            sql`${tasks.inputJson} ->> 'sample' = ${SAMPLE_TAG}`,
        )).returning({ id: tasks.id });
        result.tasks = deletedTasks.length;

        // Projects with nothing else in them go; the rest stay, untagged.
        const remaining = await tx.select({ projectId: tasks.projectId, n: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), inArray(tasks.projectId, projectIds))).groupBy(tasks.projectId);
        const busy = new Set(remaining.filter((r) => r.n > 0).map((r) => r.projectId));
        const removable = projectIds.filter((id) => !busy.has(id));
        if (removable.length) {
            const gone = await tx.delete(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, removable))).returning({ id: projects.id });
            result.projects = gone.length;
        }
        const kept = projectIds.filter((id) => busy.has(id));
        if (kept.length) {
            await tx.update(projects).set({ kpiTargetsJson: null }).where(and(eq(projects.companyId, companyId), inArray(projects.id, kept)));
            result.keptProjects = kept.length;
        }

        // The note: by id from the manifest, and only while it still carries the tag.
        const noteIds = manifests.map((m) => m.noteId).filter((id): id is string => Boolean(id));
        const taggedNotes = noteIds.length
            ? await tx.select({ id: resourceTags.resourceId }).from(resourceTags).where(and(
                eq(resourceTags.companyId, companyId), inArray(resourceTags.resourceId, noteIds), eq(resourceTags.tag, SAMPLE_RESOURCE_TAG),
            ))
            : [];
        if (taggedNotes.length) {
            const gone = await tx.delete(scopedResources).where(and(eq(scopedResources.companyId, companyId), inArray(scopedResources.id, taggedNotes.map((n) => n.id)))).returning({ id: scopedResources.id });
            result.notes = gone.length;
        }

        // The customer: still named as a sample, and nothing else under it.
        for (const customerId of new Set(manifests.map((m) => m.customerId))) {
            const [customer] = await tx.select({ id: customers.id, name: customers.name }).from(customers)
                .where(and(eq(customers.companyId, companyId), eq(customers.id, customerId))).limit(1);
            if (!customer || !customer.name.startsWith(SAMPLE_NAME_PREFIX)) continue;
            const [others] = await tx.select({ n: sql<number>`COUNT(*)::int` }).from(projects)
                .where(and(eq(projects.companyId, companyId), eq(projects.customerId, customerId)));
            if ((others?.n ?? 0) > 0) { result.keptCustomers += 1; continue; }
            // Notes or files someone added to the sample customer keep it too.
            const [scoped] = await tx.select({ n: sql<number>`COUNT(*)::int` }).from(scopedResources)
                .where(and(eq(scopedResources.companyId, companyId), eq(scopedResources.scopeType, "customer"), eq(scopedResources.scopeId, customerId)));
            if ((scoped?.n ?? 0) > 0) { result.keptCustomers += 1; continue; }
            await tx.delete(customers).where(and(eq(customers.companyId, companyId), eq(customers.id, customerId)));
            removedCustomers.push(customerId);
            result.customers += 1;
        }
        return result;
    });
    for (const customerId of removedCustomers) {
        await recordAudit({ companyId, actor: humanActor(userId), action: "customer.deleted", target: { type: "customer", id: customerId }, before: { name: SAMPLE_CUSTOMER_NAME }, meta: { sample: true } });
    }
    return result;
}
