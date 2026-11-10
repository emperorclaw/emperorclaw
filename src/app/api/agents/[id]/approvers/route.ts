import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { companyRouteAccess, outOfMemberScope } from "@/lib/company-access";
import { agentUseFor } from "@/lib/agent-access-server";
import { canAdmin } from "@/lib/role-matrix";
import { normalizeApproverSetting, parseApproverSetting } from "@/lib/approval-routing";
import { ApprovalSettingsError, approverChainPreview, approverPickerOptions, saveAgentApprovers } from "@/lib/approval-routing-server";

export const dynamic = "force-dynamic";

async function view(companyId: string, agentId: string, canEdit: boolean) {
    const [agent] = await db.select({ approvalSettings: agents.approvalSettingsJson }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1);
    const [chain, options] = await Promise.all([approverChainPreview(companyId, agentId, { namePeople: canEdit }), canEdit ? approverPickerOptions(companyId) : null]);
    return {
        approvers: normalizeApproverSetting(agent?.approvalSettings),
        // "Asks go to: Architect → Jose → owners and admins" (what an ordinary ask gets now).
        chain: { steps: chain.steps, text: chain.text, skipped: chain.skipped.map(({ name, reason }) => ({ name, reason })) },
        canEdit,
        ...(options ? { options: { agents: options.agents.filter((a) => a.id !== agentId), people: options.people } } : {}),
    };
}

/**
 * GET /api/agents/{id}/approvers — who approves this agent's requests (the
 * setting) and the chain an ask gets now. Anyone who can see the agent reads
 * it; owners and admins also get the people and agents they can pick.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { id } = await params;
    if ((await agentUseFor(access.ctx, id)) === "none") return outOfMemberScope("Agent");
    return NextResponse.json(await view(access.ctx.companyId, id, canAdmin(access.ctx.role)));
}

/**
 * PUT /api/agents/{id}/approvers { approvers: { mode: "auto" } | { mode: "agent", agentId } | { mode: "people", userIds } }
 * Owners and admins only.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    if ((await agentUseFor(access.ctx, id)) === "none") return outOfMemberScope("Agent");
    const body = await req.json().catch(() => null) as { approvers?: unknown } | null;
    const parsed = parseApproverSetting(body?.approvers);
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
        await saveAgentApprovers(access.ctx.companyId, id, parsed.setting, access.ctx.userId);
        return NextResponse.json(await view(access.ctx.companyId, id, true));
    } catch (error) {
        if (error instanceof ApprovalSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Agent approvers update failed:", error);
        return NextResponse.json({ error: "Could not save who approves. Try again." }, { status: 500 });
    }
}
