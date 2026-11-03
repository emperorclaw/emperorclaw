/**
 * Debounced regeneration of the "Organization chart" Company Brain note
 * (lib/organization-note.ts). Called after chart, group/membership and agent
 * name/role changes; a burst of edits regenerates once. It also drops this
 * process's cached chart (organization-cache.ts). Only import-free modules are
 * imported statically, so lib/groups.ts and lib/agents-crud.ts can call it
 * without an import cycle.
 * A refresh that fails is logged; the next change regenerates the note.
 */
import { invalidateOrganizationCache } from "@/lib/organization-cache";

const ORGANIZATION_NOTE_DEBOUNCE_MS = 1500;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleOrganizationNoteRefresh(companyId: string | null | undefined, delayMs = ORGANIZATION_NOTE_DEBOUNCE_MS): void {
    if (!companyId) return;
    invalidateOrganizationCache(companyId);
    const previous = pending.get(companyId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
        pending.delete(companyId);
        import("@/lib/organization-note")
            .then((module) => module.refreshOrganizationNote(companyId))
            .catch((error) => console.warn("[organization-note] refresh failed:", error instanceof Error ? error.message : error));
    }, delayMs);
    // Never keeps a process (a test run, a script) alive on its own.
    timer.unref?.();
    pending.set(companyId, timer);
}
