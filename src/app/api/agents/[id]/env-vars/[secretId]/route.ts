import { NextRequest, NextResponse } from "next/server";
import { deleteAgentSecret, getAgentSecretName, isRuntimeRoutingName } from "@/lib/agent-secrets";
import { humanActor, recordAudit } from "@/lib/audit";
import { authorizeAgentSecrets } from "../auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string; secretId: string }> },
) {
    const { id, secretId } = await params;
    const authorized = await authorizeAgentSecrets(id);
    if (authorized.response) return authorized.response;

    if (!UUID_RE.test(secretId)) {
        return NextResponse.json({ error: "Secret not found" }, { status: 404 });
    }

    const name = await getAgentSecretName(authorized.auth.companyId, id, secretId);
    // Removing a routing override (a proxy or base URL an admin set) changes
    // where the runtime sends requests, so it needs the same role as setting it.
    if (name && isRuntimeRoutingName(name) && !authorized.auth.isAdmin) {
        return NextResponse.json(
            { error: "Only a company owner or admin can delete this variable." },
            { status: 403 },
        );
    }
    const deleted = await deleteAgentSecret(authorized.auth.companyId, id, secretId);
    if (!deleted) return NextResponse.json({ error: "Secret not found" }, { status: 404 });
    try {
        await recordAudit({
            companyId: authorized.auth.companyId,
            actor: humanActor(authorized.auth.userId),
            action: "agent_secrets.delete",
            target: { type: "agent", id },
            meta: { label: name ?? secretId },
        });
    } catch (auditError) {
        console.error("Failed to record agent secret delete audit:", auditError);
    }
    return new NextResponse(null, { status: 204 });
}
