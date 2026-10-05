import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { buildLiveFeed, clampMessageCount, etagMatches, liveFeedEtag } from "@/lib/live-feed";

/**
 * GET /api/mcp/live — the live agent feed for screens and dashboards.
 *
 * The one endpoint a read_only token may call (mcp_full and mcp_danger may
 * too; a requests token may not). It only reads. Poll it every few seconds
 * with If-None-Match: unchanged feeds answer 304 with an empty body.
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req, { allowReadOnlyScope: true });
    if (auth.error || !auth.companyToken) return NextResponse.json({ error: auth.error ?? "Unauthorized" }, { status: auth.status ?? 401 });

    const messages = clampMessageCount(new URL(req.url).searchParams.get("messages"));

    try {
        const feed = await buildLiveFeed(auth.companyToken.companyId, { messages });
        const etag = liveFeedEtag(feed);
        const headers = { ETag: etag, "Cache-Control": "no-store" };
        if (etagMatches(req.headers.get("if-none-match"), etag)) {
            return new NextResponse(null, { status: 304, headers });
        }
        return new NextResponse(JSON.stringify(feed), {
            status: 200,
            headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        });
    } catch (error) {
        console.error("[/api/mcp/live] GET error:", error);
        return NextResponse.json({ error: "Unable to build the live feed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
}
