import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { appearanceHash, resolveAppearance } from "@/lib/character/model";
import { renderAvatarSvg } from "@/lib/character/draw";
import { isMissingSchemaError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

const DEFAULT_SIZE = 128;
const MIN_SIZE = 16;
const MAX_SIZE = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampSize(raw: string | null): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_SIZE;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(parsed)));
}

/**
 * Public, unauthenticated drawing of an agent's avatar. Agent ids are
 * unguessable UUIDs; the response contains only the drawing (no name, no
 * metadata), so external clients (Telegram, email, OpenClaw/Hermes bridges)
 * can hotlink it. Deleted agents 404.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
    const { agentId } = await params;
    if (!UUID.test(agentId)) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

    let row: { id: string; avatarUrl: string | null; avatarAppearance: unknown } | undefined;
    try {
        [row] = await db
            .select({ id: agents.id, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance })
            .from(agents)
            .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
            .limit(1);
    } catch (error) {
        if (!isMissingSchemaError(error)) throw error;
    }

    if (!row) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

    const appearance = resolveAppearance(row);
    const size = clampSize(req.nextUrl.searchParams.get("size"));
    const etag = `"${appearanceHash(appearance)}-${size}"`;

    if (req.headers.get("if-none-match") === etag) {
        return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE } });
    }

    const svg = renderAvatarSvg(appearance, size);
    return new NextResponse(svg, {
        status: 200,
        headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": CACHE,
            ETag: etag,
            "X-Content-Type-Options": "nosniff",
        },
    });
}

const CACHE = "public, max-age=3600, stale-while-revalidate=604800";
