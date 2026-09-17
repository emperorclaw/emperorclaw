import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { saveThreadMessageReasoning } from "@/lib/control-plane";
import { REASONING_HISTORY_MAX_CHARS } from "@/lib/reasoning-history";

/**
 * POST /api/mcp/chat/reasoning — persist the reasoning transcript for one
 * agent message the caller has just posted.
 *
 * Sibling of /api/mcp/chat/status, and deliberately separate from it: status is
 * an ephemeral 3-second ping that is cleared when typing stops, while this is a
 * single durable write at the end of a turn. Mixing them would mean every status
 * ping carried a reasoning payload.
 *
 * The write is opt-in on the runtime side (EMPEROR_CLAW_REASONING_HISTORY=on);
 * this route is simply never called when it is off.
 */
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { messageId, agentId, reasoning } = body;

        if (typeof messageId !== "string" || !messageId) {
            return NextResponse.json({ error: "messageId is required" }, { status: 400 });
        }
        if (!agentId) {
            return NextResponse.json({ error: "agentId is required" }, { status: 400 });
        }
        if (typeof reasoning !== "string" || !reasoning.trim()) {
            return NextResponse.json({ error: "reasoning is required" }, { status: 400 });
        }

        const resolvedAgentId = (await resolveBoundAgentId(companyId, auth.companyToken!, agentId))!;

        // The cap is re-applied inside saveThreadMessageReasoning. The client's
        // own cap is a courtesy to the network, never a guarantee: a client can
        // send any length, so the only cap that protects the table is this one.
        const stored = await saveThreadMessageReasoning({
            companyId,
            messageId,
            agentId: resolvedAgentId,
            reasoning,
        });

        if (!stored) {
            // Either the message is not in this company or it is not an agent
            // message authored by this agent. Both are "not yours to annotate";
            // do not distinguish them, which would confirm a foreign id exists.
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }

        return NextResponse.json({ ok: true, maxChars: REASONING_HISTORY_MAX_CHARS });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message.startsWith("Access denied") ? 403 : 500 });
    }
}
