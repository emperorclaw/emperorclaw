import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";
import { requestAgentControl } from "@/lib/agent-control";
import { validateAgentControl, type AgentControlAction } from "@/lib/agent-control-command";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const companyId = await getCompanyId(), userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => null);
    const error = validateAgentControl(body?.action, body?.prompt);
    if (error) return NextResponse.json({ error }, { status: 400 });
    try {
        return NextResponse.json(await requestAgentControl(companyId, userId, (await params).id, body.action as AgentControlAction, body.prompt || ""));
    } catch (e) {
        const error = e instanceof Error ? e.message : "Control request failed";
        return NextResponse.json({ error }, { status: error === "Agent not found" ? 404 : error.startsWith("Runtime controls") ? 400 : 500 });
    }
}
