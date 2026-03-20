import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { registerRuntimeNode } from "@/lib/control-plane";

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

        return NextResponse.json({ runtimeNode });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
