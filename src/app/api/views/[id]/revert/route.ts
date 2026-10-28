import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { revertView, memberViewCaller, viewErrorResponse } from "@/lib/views";

/** Members and up: bring back an earlier layout as a new version. Body {version}. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("member", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const body = await req.json().catch(() => null) as { version?: unknown } | null;
        const view = await revertView(access.ctx.companyId, memberViewCaller(access.ctx), id, body?.version);
        return NextResponse.json({ view });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
