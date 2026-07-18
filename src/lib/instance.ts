import { DEPLOYMENT_MODE } from "@/lib/env";
import { db } from "@/db";
import { companies, instanceSettings } from "@/db/schema";
import { eq, isNull, sql } from "drizzle-orm";

// ── Deployment mode convenience helpers ──────────────────────────────────

export function isSelfHosted(): boolean {
    return DEPLOYMENT_MODE === "self-hosted";
}

export function isCloud(): boolean {
    return DEPLOYMENT_MODE === "cloud";
}

// ── Cached instance company lookup (∞ TTL, immutable after bootstrap) ────
// NFR-8: The self-hosted company ID never changes → cached forever.

let cachedCompanyId: string | null = null;
let companyIdPromise: Promise<string | null> | null = null;

export async function getInstanceCompany(): Promise<{ id: string; name: string } | null> {
    if (cachedCompanyId) {
        const [company] = await db
            .select()
            .from(companies)
            .where(eq(companies.id, cachedCompanyId))
            .limit(1);
        return company ? { id: company.id, name: company.name } : null;
    }

    // Deduplicate concurrent lookups
    if (!companyIdPromise) {
        companyIdPromise = (async () => {
            const [company] = await db
                .select()
                .from(companies)
                .where(isNull(companies.deletedAt))
                .limit(1);
            if (company) {
                cachedCompanyId = company.id;
                return company.id;
            }
            return null;
        })();
    }

    const id = await companyIdPromise;
    if (id) {
        const [company] = await db
            .select()
            .from(companies)
            .where(eq(companies.id, id))
            .limit(1);
        return company ? { id: company.id, name: company.name } : null;
    }
    return null;
}

export function clearInstanceCompanyCache(): void {
    cachedCompanyId = null;
    companyIdPromise = null;
}

// ── Instance settings cache (60s TTL) ─────────────────────────────────────
// NFR-7: Cached in-memory with TTL, invalidated on write.

interface SettingsCache {
    data: Record<string, unknown> | null;
    cachedAt: number;
}

const settingsCache: SettingsCache = {
    data: null,
    cachedAt: 0,
};

const SETTINGS_CACHE_TTL_MS = 60_000; // 60 seconds

export async function getInstanceSettings(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (settingsCache.data !== null && (now - settingsCache.cachedAt) < SETTINGS_CACHE_TTL_MS) {
        return settingsCache.data;
    }

    const rows = await db.select().from(instanceSettings);
    const result: Record<string, unknown> = {};
    for (const row of rows) {
        result[row.key] = row.value;
    }

    settingsCache.data = result;
    settingsCache.cachedAt = now;
    return result;
}

export function clearInstanceSettingsCache(): void {
    settingsCache.data = null;
    settingsCache.cachedAt = 0;
}

export async function setInstanceSetting(key: string, value: unknown): Promise<void> {
    await db
        .insert(instanceSettings)
        .values({
            key,
            value: value as Record<string, unknown>,
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: instanceSettings.key,
            set: {
                value: value as Record<string, unknown>,
                updatedAt: new Date(),
            },
        });

    clearInstanceSettingsCache();
}

export async function setInstanceSettingsBatch(settings: Record<string, unknown>): Promise<void> {
    // Simple UPSERT per key within a transaction
    await db.transaction(async (tx) => {
        for (const [key, value] of Object.entries(settings)) {
            await tx
                .insert(instanceSettings)
                .values({
                    key,
                    value: value as Record<string, unknown>,
                    updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                    target: instanceSettings.key,
                    set: {
                        value: value as Record<string, unknown>,
                        updatedAt: new Date(),
                    },
                });
        }
    });

    clearInstanceSettingsCache();
}

// ── Convenience: Registration mode ────────────────────────────────────────

export async function getRegistrationMode(): Promise<"invite-only" | "open"> {
    const settings = await getInstanceSettings();
    const mode = settings["registration_mode"];
    if (mode === "open") return "open";
    return "invite-only";
}

export async function isRegistrationOpen(): Promise<boolean> {
    return (await getRegistrationMode()) === "open";
}
