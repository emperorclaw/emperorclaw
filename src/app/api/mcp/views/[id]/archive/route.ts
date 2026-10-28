import { NextRequest, NextResponse } from "next/server";
import { setViewArchived, viewErrorResponse } from "@/lib/views";
import { viewMcpCaller } from "../../_shared";

/** archive_view: hide a view that is no longer needed (people can restore it). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const resolved = await viewMcpCaller(req);
    if (resolved.response) return resolved.response;
    try {
        const { id } = await params;
        const result = await setViewArchived(resolved.companyId, resolved.caller, id, true);
        return NextResponse.json({ message: "View archived", ...result });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
