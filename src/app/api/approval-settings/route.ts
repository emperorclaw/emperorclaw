import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { canAdmin } from "@/lib/role-matrix";
import { parseApproverSetting, parseEscalateAfterMinutes, type ApproverSetting } from "@/lib/approval-routing";
import { ApprovalSettingsError, approverPickerOptions, chartTeams, loadCompanyApprovalSettings, saveCompanyApprovalSettings } from "@/lib/approval-routing-server";

export const dynamic = "force-dynamic";

async function view(companyId: string, canEdit: boolean) {
    const [settings, teams, options] = await Promise.all([loadCompanyApprovalSettings(companyId), chartTeams(companyId), approverPickerOptions(companyId)]);
    return { ...settings, teams, options, canEdit };
}

/** GET /api/approval-settings — the escalation time and team approvers (Settings → Approvals, owners and admins). */
export async function GET() {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    return NextResponse.json(await view(access.ctx.companyId, canAdmin(access.ctx.role)));
}

/**
 * PUT /api/approval-settings { escalateAfterMinutes?: number, teamApprovers?: { teamId: setting | null } }
 * Owners and admins only. A null (or "auto") team setting removes it.
 */
export async function PUT(req: NextRequest) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const body = await req.json().catch(() => null) as { escalateAfterMinutes?: unknown; teamApprovers?: unknown } | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
    const input: { escalateAfterMinutes?: number; teamApprovers?: Record<string, ApproverSetting | null> } = {};
    if (body.escalateAfterMinutes !== undefined) {
        const parsed = parseEscalateAfterMinutes(body.escalateAfterMinutes);
        if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
        input.escalateAfterMinutes = parsed.minutes;
    }
    if (body.teamApprovers !== undefined) {
        if (!body.teamApprovers || typeof body.teamApprovers !== "object" || Array.isArray(body.teamApprovers)) {
            return NextResponse.json({ error: "teamApprovers must be an object of { teamId: approvers }" }, { status: 400 });
        }
        input.teamApprovers = {};
        for (const [teamId, raw] of Object.entries(body.teamApprovers as Record<string, unknown>)) {
            if (raw === null) { input.teamApprovers[teamId] = null; continue; }
            const parsed = parseApproverSetting(raw);
            if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
            input.teamApprovers[teamId] = parsed.setting;
        }
    }
    try {
        await saveCompanyApprovalSettings(access.ctx.companyId, input, access.ctx.userId);
        return NextResponse.json(await view(access.ctx.companyId, true));
    } catch (error) {
        if (error instanceof ApprovalSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Approval settings update failed:", error);
        return NextResponse.json({ error: "Could not save the approval settings. Try again." }, { status: 500 });
    }
}
