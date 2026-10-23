import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { memberMaySeeAgent } from "@/lib/member-scope";
import { recreateHermesContainer } from "@/lib/hermes-provisioning";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/[id]/recreate-runtime
 *
 * Stops+removes the agent's existing Hermes sibling container (if any) and
 * re-provisions it from the agent's current DB row. Backs the "Recreate
 * Runtime" action in the UI and is the same primitive used for: Hermes image
 * updates (ops/update route), LLM key rotation (after PATCH), and
 * repairing a crashed/manually-removed container.
 *
 * A fresh setup token is minted on every recreate and the previous
 * container's token is revoked once that container is gone, so a leaked or
 * copied runtime token stops working at the next recreate. The container runs
 * this release's pinned runtime image, and the old one is stopped with the
 * managed stop timeout (75 s) so in-flight turns drain first.
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    let ctx;
    try {
        ctx = await requireRole("member")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    const { id } = await params;
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, ctx.companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent || !memberMaySeeAgent(ctx.scope, agent.id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    if (agent.provider !== "hermes" || agent.deploymentMode !== "local") {
        return NextResponse.json({ error: "Recreate Runtime is only available for local Hermes agents." }, { status: 400 });
    }

    const result = await recreateHermesContainer(agent.id);

    return NextResponse.json({
        success: result.success,
        message: result.message,
        outputs: result.outputs,
    });
}
