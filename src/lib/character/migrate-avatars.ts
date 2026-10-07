import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { legacyAvatarToAppearance } from "./model";

/**
 * One-time data step: retire stored DiceBear URLs. Each agent's seed is turned
 * into an explicit `avatar_appearance` (so the look is preserved exactly) and
 * `avatar_url` is cleared for drawn characters. Uploaded https photos are left
 * untouched. Idempotent: already-migrated rows are skipped.
 */
export async function backfillLegacyAvatars(): Promise<{ scanned: number; migrated: number }> {
    const rows = await db
        .select({ id: agents.id, avatarUrl: agents.avatarUrl })
        .from(agents)
        .where(and(isNotNull(agents.avatarUrl), isNull(agents.avatarAppearance)));

    let migrated = 0;
    for (const row of rows) {
        const appearance = legacyAvatarToAppearance(row.avatarUrl);
        if (!appearance) continue;
        await db.update(agents).set({ avatarAppearance: appearance, avatarUrl: null }).where(eq(agents.id, row.id));
        migrated += 1;
    }
    return { scanned: rows.length, migrated };
}
