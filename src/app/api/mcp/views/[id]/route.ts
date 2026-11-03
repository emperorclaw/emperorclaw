import { NextRequest, NextResponse } from "next/server";
import { VIEW_MAINTAINER_AGENT_REFUSED, getView, updateView, viewErrorResponse } from "@/lib/views";
import { readJson, viewMcpCaller } from "../_shared";

/** get_view: layout, every panel's values and who updated them. Missing and out-of-scope are both 404. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const resolved = await viewMcpCaller(req);
    if (resolved.response) return resolved.response;
    try {
        const { id } = await params;
        return NextResponse.json({ view: await getView(resolved.companyId, resolved.caller, id) });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/** update_view: {title?, description?, panels?, refreshEveryMinutes?}. A title or layout change saves a new version. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const resolved = await viewMcpCaller(req);
    if (resolved.response) return resolved.response;
    try {
        const { id } = await params;
        const body = await readJson(req);
        if (!body) return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        // Who maintains a view is a person's choice, in Emperor (PUT /api/views/{id}/maintainer).
        if ("maintainerAgentId" in body || "maintainer" in body) {
            return NextResponse.json({ error: VIEW_MAINTAINER_AGENT_REFUSED }, { status: 403 });
        }
        const view = await updateView(resolved.companyId, resolved.caller, id, {
            title: body.title, description: body.description, panels: body.panels, refreshEveryMinutes: body.refreshEveryMinutes,
        });
        return NextResponse.json({ message: "View updated", view });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
