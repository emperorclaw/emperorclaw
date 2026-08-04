import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
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
 * A fresh setup token is minted on every recreate rather than reusing the
 * old one — simpler than tracking/validating token liveness, and the old
 * token is naturally orphaned (and harmless) once its container is gone.
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
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
