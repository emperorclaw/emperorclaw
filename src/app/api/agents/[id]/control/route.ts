import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeAgent } from "@/lib/member-scope";
import { AuthError } from "@/lib/roles";
import { DirectThreadNotAllowedError, requestAgentControl } from "@/lib/agent-control";
import { validateAgentControl, type AgentControlAction } from "@/lib/agent-control-command";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const { companyId, userId } = access.ctx;
    const agentId = (await params).id;
    if (!memberMaySeeAgent(access.ctx.scope, agentId)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const body = await req.json().catch(() => null);
    const error = validateAgentControl(body?.action, body?.prompt);
    if (error) return NextResponse.json({ error }, { status: 400 });
    try {
        const directThreadId = typeof body.directThreadId === "string" && body.directThreadId ? body.directThreadId : null;
        return NextResponse.json(await requestAgentControl(companyId, userId, agentId, body.action as AgentControlAction,
            body.prompt || "", directThreadId));
    } catch (e) {
        if (e instanceof AuthError) return NextResponse.json({error:e.message},{status:e.statusCode});
        if (e instanceof DirectThreadNotAllowedError) return NextResponse.json({ error: e.message }, { status: 404 });
        const error = e instanceof Error ? e.message : "Control request failed";
        return NextResponse.json({ error }, { status: error === "Agent not found" ? 404 : error.startsWith("Runtime controls") ? 400 : 500 });
    }
}
