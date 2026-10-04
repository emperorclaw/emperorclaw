import { NextRequest, NextResponse } from "next/server";
import { normalizeCompanyTokenScope, verifyMcpToken } from "@/lib/mcp";
import { AgentRequestError, createAgentRequest, listAgentRequests } from "@/lib/agent-requests";
import { consumeRateLimit } from "@/lib/rate-limit";

const CREATE_LIMIT_PER_MINUTE = 60;

/**
 * Send work to an agent from another platform. A "requests" token (Settings →
 * Access Tokens) can only use this endpoint; its name is the source shown to
 * the agent. A company token may name the source in the body.
 */
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req, { allowRequestsScope: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const token = auth.companyToken!;
    if (token.agentId) {
        return NextResponse.json({ error: "Agent tokens can't send requests; use create_task or send_message" }, { status: 403 });
    }
    const limit = consumeRateLimit({ key: `requests:token:${token.id}`, limit: CREATE_LIMIT_PER_MINUTE, windowMs: 60_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
    const isRequestsToken = normalizeCompanyTokenScope(token.scope) === "requests";

    try {
        const { request, created } = await createAgentRequest({
            companyId: token.companyId,
            tokenId: token.id,
            source: isRequestsToken ? token.name : (typeof body.source === "string" && body.source.trim() ? body.source : token.name),
            agent: String(body.agentId ?? body.agent ?? ""),
            prompt: body.prompt,
            title: body.title,
            requestedBy: body.requestedBy,
            externalRef: body.externalRef,
            idempotencyKey: req.headers.get("Idempotency-Key") ?? body.idempotencyKey,
            projectId: body.projectId,
            priority: body.priority,
        });
        return NextResponse.json({ request, created }, { status: created ? 201 : 200 });
    } catch (error) {
        if (error instanceof AgentRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Agent request error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

/** Requests, newest first. A requests token sees only its own. */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req, { allowRequestsScope: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const token = auth.companyToken!;
    const { searchParams } = new URL(req.url);
    const requests = await listAgentRequests(token.companyId, {
        tokenId: normalizeCompanyTokenScope(token.scope) === "requests" ? token.id : null,
        externalRef: searchParams.get("externalRef"),
        status: searchParams.get("status"),
        limit: Number(searchParams.get("limit")) || undefined,
    });
    return NextResponse.json({ requests });
}
