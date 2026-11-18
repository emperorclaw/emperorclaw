import { NextRequest, NextResponse } from "next/server";
import {
    AgentSecretForbiddenError,
    AgentSecretsUnavailableError,
    AgentSecretValidationError,
    listAgentSecrets,
    setAgentSecret,
} from "@/lib/agent-secrets";
import { authorizeAgentSecrets } from "./auth";
import { humanActor, recordAudit } from "@/lib/audit";

/** List the agent's secret metadata. Values and ciphertext are never returned. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const authorized = await authorizeAgentSecrets(id);
    if (authorized.response) return authorized.response;

    const secrets = await listAgentSecrets(authorized.auth.companyId, id);
    return NextResponse.json({ secrets });
}

/** Create a secret, or rotate the value of the live secret with the same name. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const authorized = await authorizeAgentSecrets(id);
    if (authorized.response) return authorized.response;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
    }

    try {
        const secret = await setAgentSecret({
            companyId: authorized.auth.companyId,
            agentId: id,
            name: body.name,
            value: body.value,
            exposeToTools: body.exposeToTools,
            userId: authorized.auth.userId,
            canSetRoutingNames: authorized.auth.isAdmin,
        });
        try {
            await recordAudit({
                companyId: authorized.auth.companyId,
                actor: humanActor(authorized.auth.userId),
                action: "agent_secrets.set",
                target: { type: "agent", id },
                meta: { label: secret.name },
            });
        } catch (auditError) {
            console.error("Failed to record agent secret set audit:", auditError);
        }
        return NextResponse.json({ secret });
    } catch (error) {
        if (error instanceof AgentSecretForbiddenError) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        if (error instanceof AgentSecretValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof AgentSecretsUnavailableError) {
            return NextResponse.json({ error: error.message }, { status: 503 });
        }
        throw error;
    }
}
