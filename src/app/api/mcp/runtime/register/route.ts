import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { registerRuntimeNode } from "@/lib/control-plane";
import { RICH_REPLY_GUIDE, SERVER_CAPABILITIES } from "@/lib/rich-reply-guide";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    try {
        const body = await req.json();
        const { runtimeId, name, hostname, gatewayVersion, capabilitiesJson, startedAt } = body;

        if (!runtimeId || !name) {
            return NextResponse.json({ error: "runtimeId and name are required" }, { status: 400 });
        }

        const runtimeNode = await registerRuntimeNode({
            companyId: auth.companyToken!.companyId,
            runtimeId,
            name,
            hostname: hostname || null,
            gatewayVersion: gatewayVersion || null,
            capabilitiesJson: Array.isArray(capabilitiesJson) ? capabilitiesJson : [],
            startedAt: startedAt ? new Date(startedAt) : null,
        });

        // Capability handshake: a runtime learns what THIS server can render
        // and gets the matching reply-format guide to hand its agent. Older
        // runtimes ignore the extra fields; older servers never send them,
        // so their agents keep writing plain Markdown.
        return NextResponse.json({
            runtimeNode,
            serverCapabilities: SERVER_CAPABILITIES,
            replyFormatGuide: RICH_REPLY_GUIDE,
        });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
