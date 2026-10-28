import { NextRequest, NextResponse } from "next/server";
import { resolveBoundAgentId, verifyMcpToken } from "@/lib/mcp";
import { EXTERNAL_ACTION_KEYS } from "@/lib/action-policy";
import { checkExternalAction } from "@/lib/action-policy-server";

/**
 * POST /api/mcp/action-policies/check { action, details, agentId? } — the
 * REST form of the check_action tool: may this agent do an action outside
 * Emperor now? Always 200 with { decision, mayProceed, approvalId, message }.
 */
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const action = typeof body?.action === "string" ? body.action : "";
    if (!EXTERNAL_ACTION_KEYS.includes(action)) {
        return NextResponse.json({ error: `action must be one of: ${EXTERNAL_ACTION_KEYS.join(", ")}` }, { status: 400 });
    }
    const details = body?.details;
    if (details !== undefined && (details === null || typeof details !== "object" || Array.isArray(details))) {
        return NextResponse.json({ error: "details must be an object describing what you are about to do" }, { status: 400 });
    }

    try {
        const agentId = await resolveBoundAgentId(companyId, auth.companyToken!, typeof body?.agentId === "string" ? body.agentId : null);
        return NextResponse.json(await checkExternalAction({ companyId, agentId, tokenId: auth.companyToken!.id, action, details: details ?? {} }));
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : message.startsWith("Access denied") ? 403 : 500;
        if (status === 500) console.error("Action check error:", error);
        return NextResponse.json({ error: status === 500 ? "Internal Server Error" : message }, { status });
    }
}
