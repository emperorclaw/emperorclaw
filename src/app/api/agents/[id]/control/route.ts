import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMayUseAgent } from "@/lib/agent-access-server";
import { AuthError } from "@/lib/roles";
import { DirectThreadNotAllowedError, canStopAgentEverywhere, requestAgentControl } from "@/lib/agent-control";
import { validateAgentControl, type AgentControlAction } from "@/lib/agent-control-command";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const { companyId, userId } = access.ctx;
    const agentId = (await params).id;
    if (!(await memberMayUseAgent(access.ctx, agentId))) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const body = await req.json().catch(() => null);
    const error = validateAgentControl(body?.action, body?.prompt);
    if (error) return NextResponse.json({ error }, { status: 400 });
    // `scope: "agent"` stops or replaces the agent's work in every chat (an agent-wide Stop);
    // without it a Stop in a person's own private chat only stops that chat when the runtime can.
    if (body.scope !== undefined && body.scope !== "agent") return NextResponse.json({ error: "scope must be \"agent\" when given" }, { status: 400 });
    // It cancels other people's work too: company owners/admins and the agent's own owner only.
    if (body.scope === "agent" && !(await canStopAgentEverywhere(access.ctx, agentId))) {
        return NextResponse.json({ error: "Only owners, admins and the agent's owner can stop all of its chats", code: "agent_scope_forbidden" }, { status: 403 });
    }
    try {
        const directThreadId = typeof body.directThreadId === "string" && body.directThreadId ? body.directThreadId : null;
        return NextResponse.json(await requestAgentControl(companyId, userId, agentId, body.action as AgentControlAction,
            body.prompt || "", directThreadId, { agentWide: body.scope === "agent" }));
    } catch (e) {
        if (e instanceof AuthError) return NextResponse.json({error:e.message},{status:e.statusCode});
        if (e instanceof DirectThreadNotAllowedError) return NextResponse.json({ error: e.message }, { status: 404 });
        const error = e instanceof Error ? e.message : "Control request failed";
        return NextResponse.json({ error }, { status: error === "Agent not found" ? 404 : error.startsWith("Runtime controls") ? 400 : 500 });
    }
}
