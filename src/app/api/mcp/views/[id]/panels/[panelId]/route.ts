import { NextRequest, NextResponse } from "next/server";
import { updatePanel, viewErrorResponse } from "@/lib/views";
import { readJson, viewMcpCaller } from "../../../_shared";

/** update_panel: body {data}. Replaces one panel's values; the layout and its version are untouched. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; panelId: string }> }) {
    const resolved = await viewMcpCaller(req);
    if (resolved.response) return resolved.response;
    try {
        const { id, panelId } = await params;
        let decodedPanelId: string;
        try {
            decodedPanelId = decodeURIComponent(panelId);
        } catch {
            return NextResponse.json({ error: "Invalid panel id" }, { status: 400 });
        }
        const body = await readJson(req);
        if (!body || body.data === undefined) return NextResponse.json({ error: "Body {data} is required" }, { status: 400 });
        const panel = await updatePanel(resolved.companyId, resolved.caller, id, decodedPanelId, body.data);
        return NextResponse.json({ message: "Panel updated", panel: { id: panel.id, type: panel.type, updatedAt: panel.updatedAt } });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
