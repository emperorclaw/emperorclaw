import { NextRequest, NextResponse } from "next/server";
import { resolveBoundAgentId, verifyMcpToken } from "@/lib/mcp";
import { GATEWAY_TOPOLOGIES, findDuplicateRuntime, registerRuntimeNode, sharedHostOk } from "@/lib/control-plane";
import { RICH_REPLY_GUIDE, SERVER_CAPABILITIES } from "@/lib/rich-reply-guide";
import { bridgeUpdateState, hermesBridgeInfo } from "@/lib/hermes-bridge-version";

/** A short reported string (version, transport…), or null when absent/invalid. */
function shortString(value: unknown, max = 100): string | null {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function smallInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000_000 ? value : null;
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { runtimeId, name, hostname, gatewayVersion, capabilitiesJson, startedAt } = body;

        if (!runtimeId || !name) {
            return NextResponse.json({ error: "runtimeId and name are required" }, { status: 400 });
        }

        // The agent this runtime serves: the token's bound agent (bridge 0.3.x
        // never sends agentId, and its token is bound). Used for D19.
        let agentId: string | null;
        try {
            agentId = await resolveBoundAgentId(companyId, auth.companyToken!, shortString(body.agentId, 200));
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Access denied";
            if (msg.startsWith("Access denied")) return NextResponse.json({ error: msg }, { status: 403 });
            // An unknown agentId never blocks registration; it only skips D19.
            agentId = null;
        }

        const runtimeNode = await registerRuntimeNode({
            companyId,
            runtimeId,
            name,
            hostname: hostname || null,
            gatewayVersion: gatewayVersion || null,
            capabilitiesJson: Array.isArray(capabilitiesJson) ? capabilitiesJson : [],
            startedAt: startedAt ? new Date(startedAt) : null,
            agentId,
            // Bridge 0.9+ only; absent fields are stored as null (legacy).
            bridgeVersion: shortString(body.bridgeVersion),
            bridgeProtocol: smallInt(body.bridgeProtocol),
            hermesVersion: shortString(body.hermesVersion),
            transport: shortString(body.transport, 40),
            deployMode: shortString(body.deployMode, 40),
            hostFingerprint: shortString(body.hostFingerprint, 128),
            gatewayTopology: (GATEWAY_TOPOLOGIES as readonly string[]).includes(body.gatewayTopology) ? body.gatewayTopology : null,
        });

        // One runtime per agent: bridge 0.9 enters standby while this is set.
        const duplicateRuntime = agentId
            ? await findDuplicateRuntime({ companyId, agentId, runtimeId: runtimeNode.runtimeId })
            : null;

        // Capability handshake: a runtime learns what THIS server can render
        // and gets the matching reply-format guide to hand its agent. Older
        // runtimes ignore the extra fields; older servers never send them,
        // so their agents keep writing plain Markdown.
        return NextResponse.json({
            runtimeNode,
            serverCapabilities: SERVER_CAPABILITIES,
            replyFormatGuide: RICH_REPLY_GUIDE,
            bridge: { ...hermesBridgeInfo(), updateState: bridgeUpdateState(runtimeNode) },
            duplicateRuntime,
            // D21: bridge 0.9 in shared mode refuses to dispatch when false.
            sharedHostOk: await sharedHostOk({
                companyId,
                hostFingerprint: runtimeNode.hostFingerprint,
                gatewayTopology: runtimeNode.gatewayTopology,
            }),
        });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
