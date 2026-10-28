import { cache } from "react";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { humanActor, recordAudit } from "@/lib/audit";
import { MODULE_KEYS, moduleOffMessage, resolveModules, type CompanyTemplateId, type ModuleKey, type ModuleState } from "@/lib/modules";

/**
 * The company's modules, read once per request (React cache(); a plain call
 * outside a render). An unknown company, or a read that fails (say, before
 * the migration ran), reads as everything on: guards never invent a restriction.
 */
export const loadCompanyModules = cache(async (companyId: string): Promise<ModuleState> => {
    try {
        const [row] = await db.select({ modulesJson: companies.modulesJson }).from(companies).where(eq(companies.id, companyId)).limit(1);
        return resolveModules(row?.modulesJson);
    } catch (error) {
        console.error("[modules] read failed, treating every module as on:", error);
        return resolveModules(null);
    }
});

/** THE guard: used by pages, API routes, MCP tools and nav. */
export async function moduleEnabled(companyId: string, key: ModuleKey): Promise<boolean> {
    return (await loadCompanyModules(companyId))[key];
}

export function moduleOffResponse(key: ModuleKey): NextResponse {
    return NextResponse.json({ error: moduleOffMessage(key), code: "module_off", module: key }, { status: 403 });
}

/** Route convenience: `const off = await moduleGuard(companyId, "views"); if (off) return off;` */
export async function moduleGuard(companyId: string, key: ModuleKey): Promise<NextResponse | null> {
    return (await moduleEnabled(companyId, key)) ? null : moduleOffResponse(key);
}

/** Audit fields for a module state: one boolean per module ("viewsModule": false). */
function auditFields(state: ModuleState): Record<string, boolean> {
    return Object.fromEntries(MODULE_KEYS.map((key) => [`${key}Module`, state[key]]));
}

/**
 * Store a new module state (only the changed keys need be passed). Data of a
 * module is never touched. Audited with before/after when anything changed.
 */
export async function updateCompanyModules(input: {
    companyId: string;
    userId: string;
    changes: Partial<ModuleState>;
    template?: CompanyTemplateId;
}): Promise<{ before: ModuleState; after: ModuleState; changed: ModuleKey[] }> {
    const before = await readModulesUncached(input.companyId);
    const after: ModuleState = { ...before };
    for (const key of MODULE_KEYS) if (typeof input.changes[key] === "boolean") after[key] = input.changes[key]!;
    const changed = MODULE_KEYS.filter((key) => before[key] !== after[key]);
    if (changed.length === 0) return { before, after, changed };

    // Merge only the changed keys in SQL, so two admins toggling different modules don't overwrite each other.
    const patch = Object.fromEntries(changed.map((key) => [key, after[key]]));
    await db.update(companies)
        .set({ modulesJson: sql`coalesce(${companies.modulesJson}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(companies.id, input.companyId));
    const changedBefore = Object.fromEntries(changed.map((key) => [`${key}Module`, before[key]]));
    const changedAfter = Object.fromEntries(changed.map((key) => [`${key}Module`, after[key]]));
    await recordAudit({
        companyId: input.companyId,
        actor: humanActor(input.userId),
        action: "company.settings_changed",
        target: { type: "company", id: input.companyId },
        before: input.template ? auditFields(before) : changedBefore,
        after: input.template ? auditFields(after) : changedAfter,
        meta: { setting: "modules", ...(input.template ? { template: input.template } : {}) },
    });
    return { before, after, changed };
}

/** A write must compare against the stored row, not a value cached earlier in the request. */
async function readModulesUncached(companyId: string): Promise<ModuleState> {
    const [row] = await db.select({ modulesJson: companies.modulesJson }).from(companies).where(eq(companies.id, companyId)).limit(1);
    return resolveModules(row?.modulesJson);
}
