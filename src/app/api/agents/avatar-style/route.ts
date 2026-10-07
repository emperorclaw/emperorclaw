import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import {
    normalizeAppearance, resolveAppearance, resolveAvatarPhoto,
    type CharacterAccessory, type CharacterKind,
} from "@/lib/character/model";

export const dynamic = "force-dynamic";

const KINDS: CharacterKind[] = ["robot", "human"];
const ACCESSORIES: CharacterAccessory[] = ["none", "glasses", "headset", "cap", "bow"];

/**
 * Give the whole team a shared look: { kind?, hue?, accessory? }. Every agent
 * keeps its own seed, so they still look different while reading as one cast.
 * Agents with an uploaded photo are left alone.
 */
export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const kind = body.kind === undefined ? undefined : (KINDS.includes(body.kind as CharacterKind) ? body.kind as CharacterKind : null);
    const hue = body.hue === undefined ? undefined : (typeof body.hue === "number" && Number.isFinite(body.hue) ? Math.round(body.hue) : null);
    const accessory = body.accessory === undefined ? undefined : (ACCESSORIES.includes(body.accessory as CharacterAccessory) ? body.accessory as CharacterAccessory : null);
    if (kind === null || hue === null || accessory === null) {
        return NextResponse.json({ error: "kind, hue or accessory is not valid" }, { status: 400 });
    }
    if (hue !== undefined && (hue < 0 || hue > 359)) {
        return NextResponse.json({ error: "hue must be between 0 and 359" }, { status: 400 });
    }
    if (kind === undefined && hue === undefined && accessory === undefined) {
        return NextResponse.json({ error: "Nothing to apply" }, { status: 400 });
    }

    const rows = await db
        .select({ id: agents.id, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance })
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), isNull(agents.deletedAt)));

    let updated = 0;
    for (const row of rows) {
        if (resolveAvatarPhoto({ avatarUrl: row.avatarUrl })) continue;
        const base = resolveAppearance(row);
        const next = normalizeAppearance({
            ...base,
            kind: kind ?? base.kind,
            hue: hue ?? base.hue,
            accessory: accessory ?? base.accessory,
        });
        if (!next) continue;
        await db.update(agents).set({ avatarAppearance: next, avatarUrl: null }).where(eq(agents.id, row.id));
        updated += 1;
    }
    return NextResponse.json({ updated });
}
