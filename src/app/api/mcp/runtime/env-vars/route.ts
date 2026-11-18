import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { etagMatches } from "@/lib/live-feed";
import {
    AgentSecretsUnavailableError,
    logAgentSecretsRead,
    resolveAgentSecretsForRuntime,
} from "@/lib/agent-secrets";

/**
 * GET /api/mcp/runtime/env-vars — the runtime bridge's secrets for the token's
 * own agent. A company-wide token is refused: it is not bound to one agent.
 * Any caller-supplied agent id is ignored on purpose.
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const token = auth.companyToken!;
    if (!token.agentId) {
        return NextResponse.json({ error: "agent_bound_token_required" }, { status: 403 });
    }

    try {
        const { etag, secrets, failed } = await resolveAgentSecretsForRuntime(token.companyId, token.agentId);
        const headerEtag = `"${etag}"`;
        const ifNoneMatch = req.headers.get("if-none-match");
        if (etagMatches(ifNoneMatch, etag) || etagMatches(ifNoneMatch, headerEtag)) {
            return new NextResponse(null, {
                status: 304,
                headers: { ETag: headerEtag, "Cache-Control": "no-store" },
            });
        }

        await logAgentSecretsRead({
            companyId: token.companyId,
            agentId: token.agentId,
            names: secrets.map((secret) => secret.name),
            failed,
        });

        return NextResponse.json(
            { etag, secrets, failed },
            { headers: { ETag: headerEtag, "Cache-Control": "no-store" } },
        );
    } catch (error) {
        if (error instanceof AgentSecretsUnavailableError) {
            return NextResponse.json({ error: error.message }, { status: 503 });
        }
        throw error;
    }
}
