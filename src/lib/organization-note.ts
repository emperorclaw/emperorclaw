import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, scopedResources } from "@/db/schema";
import { loadOrganization, organizationNames } from "@/lib/organization";
import {
    ORGANIZATION_NOTE_DISPLAY_NAME,
    ORGANIZATION_NOTE_NAME,
    ORGANIZATION_NOTE_PATH,
    ORGANIZATION_NOTE_SUMMARY,
    organizationTreeText,
    renderOrganizationNote,
} from "@/lib/organization-briefing";
import { createScopedResource, updateScopedResource } from "@/lib/resources";

/** The note lists everyone; agents get the capped tree in their briefing instead. */
const NOTE_MAX_PEOPLE = 500;

/**
 * Keep the system-maintained "Organization chart" note (Company folder) in
 * step with the chart: created once there is a chart, rewritten only when its
 * text changed (each rewrite is a new version, so an edit made in the note is
 * still in its history), never recreated after someone deleted it. It is
 * on_request: found by search and humans, never pushed into agent prompts
 * (the organization briefing already carries the agent's place).
 */
export async function refreshOrganizationNote(companyId: string): Promise<"created" | "updated" | "unchanged" | "skipped"> {
    const org = await loadOrganization(companyId);
    const tree = organizationTreeText({ nodes: org.config.nodes ?? [], leader: org.config.leader, teams: org.teams, names: organizationNames(org), maxPeople: NOTE_MAX_PEOPLE });
    const content = renderOrganizationNote({ companyName: org.companyName, tree });
    return db.transaction(async (tx) => {
        // Serialize per company so two refreshes never create two notes.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`organization-note:${companyId}`}))`);
        const rows = await tx.select({ id: scopedResources.id, configText: scopedResources.configText, deletedAt: scopedResources.deletedAt }).from(scopedResources).where(and(
            eq(scopedResources.companyId, companyId),
            eq(scopedResources.scopeType, "company"),
            isNull(scopedResources.scopeId),
            eq(scopedResources.resourceType, "knowledge_base"),
            eq(scopedResources.name, ORGANIZATION_NOTE_NAME),
        ));
        const live = rows.find((row) => !row.deletedAt);
        if (!live) {
            // Deleted on purpose, or nothing to show yet: leave it alone.
            if (rows.length || (!org.configured && !tree)) return "skipped";
            await createScopedResource({
                companyId,
                scopeType: "company",
                scopeId: null,
                provider: "knowledge",
                resourceType: "knowledge_base",
                name: ORGANIZATION_NOTE_NAME,
                displayName: ORGANIZATION_NOTE_DISPLAY_NAME,
                path: ORGANIZATION_NOTE_PATH,
                configText: content,
                status: "active",
                ownership: "managed",
                inject: "on_request",
                summary: ORGANIZATION_NOTE_SUMMARY,
                changeSummary: "Generated from the organization chart",
                createdByType: "system",
            });
            return "created";
        }
        if (live.configText === content) return "unchanged";
        await updateScopedResource({
            companyId,
            resourceId: live.id,
            patch: { configText: content, summary: ORGANIZATION_NOTE_SUMMARY, changeSummary: "Regenerated from the organization chart", createdByType: "system", createdById: null },
        });
        return "updated";
    });
}

/**
 * Heal notes a lost debounced refresh (a restart) left stale: every company
 * with a chart, once per slow lifecycle tick. Cheap when nothing changed (one
 * read per company, no write). Returns how many notes were written.
 */
export async function reconcileOrganizationNotes(): Promise<number> {
    const rows = await db.select({ id: companies.id }).from(companies).where(and(isNull(companies.deletedAt), sql`${companies.organizationJson} IS NOT NULL`));
    let written = 0;
    for (const { id } of rows) {
        try {
            const result = await refreshOrganizationNote(id);
            if (result === "created" || result === "updated") written += 1;
        } catch (error) {
            console.warn("[organization-note] reconcile failed for a company:", error instanceof Error ? error.message : error);
        }
    }
    return written;
}
