import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { buildLiveFeed, clampMessageCount, etagMatches, liveFeedEtag, scopeLiveFeed } from "@/lib/live-feed";
import { getScopedAgentIds, loadMemberScope } from "@/lib/member-scope";
import { moduleGuard } from "@/lib/modules-server";

/**
 * GET /api/mcp/live — the live agent feed for screens and dashboards.
 *
 * The one endpoint a read_only token may call (mcp_full and mcp_danger may
 * too; a requests token may not). It only reads. Poll it every few seconds
 * with If-None-Match: unchanged feeds answer 304 with an empty body.
 *
 * `dm` is always present and empty unless the token was minted with
 * includePrivateChats by a user who is still a member of the company.
 * Per-agent `thought` is sent only to read_only tokens minted with
 * includeAgentThoughts; for every other token reasoning is never queried.
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req, { allowReadOnlyScope: true });
    if (auth.error || !auth.companyToken) return NextResponse.json({ error: auth.error ?? "Unauthorized" }, { status: auth.status ?? 401 });

    // A screen (read_only token) goes dark while Display screens is off; other callers still read the feed.
    if (auth.companyToken.scope === "read_only") {
        const moduleOff = await moduleGuard(auth.companyToken.companyId, "displays");
        if (moduleOff) return moduleOff;
    }

    const messages = clampMessageCount(new URL(req.url).searchParams.get("messages"));

    try {
        // Only an opted-in read_only token carries its creator's own direct chats.
        const token = auth.companyToken;
        const privateChatsUserId = token.scope === "read_only" && token.includePrivateChats ? token.createdByUserId : null;
        const agentThoughts = token.scope === "read_only" && token.includeAgentThoughts === true;
        // A screen shows what its creator may see: a token minted by someone who
        // is now a restricted member carries that member's current agent scope.
        const creatorScope = token.createdByUserId ? await loadMemberScope(token.createdByUserId, token.companyId) : null;
        const feed = scopeLiveFeed(await buildLiveFeed(token.companyId, { messages, privateChatsUserId, agentThoughts }), getScopedAgentIds(creatorScope));
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
