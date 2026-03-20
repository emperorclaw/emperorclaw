import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { getLatestManagedSecret, logCredentialAccess } from "@/lib/control-plane";
import { decryptSecretPayload } from "@/lib/secrets";
import { getAgentIntegration, updateIntegrationLeaseState } from "@/lib/agent-integrations";
import { isMissingSchemaError } from "@/lib/schema-compat";

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; integrationId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId, integrationId } = await params;

    try {
        const body = await req.json();
        const { sessionId, reason } = body;

        const integration = await getAgentIntegration(companyId, agentId, integrationId);

        if (!integration) {
            return NextResponse.json({ error: "Integration not found" }, { status: 404 });
        }

        const resolvedAgentId = await resolveAgentId(companyId, agentId);

        if (integration.compatMode === "legacy-inline" && integration.secretJson && Object.keys(integration.secretJson).length > 0) {
            await logCredentialAccess({
                companyId,
                integrationId,
                agentId: resolvedAgentId,
                sessionId: sessionId || null,
                action: "lease",
                status: "success",
                reason: "legacy inline secret storage",
                metadataJson: { ownership: integration.ownership, requestedReason: reason || null },
            });

            return NextResponse.json({
                integration: {
                    id: integration.id,
                    provider: integration.provider,
                    name: integration.name,
                    ownership: integration.ownership,
                    configJson: integration.configJson || {},
                },
                managed: true,
                configJson: integration.configJson || {},
                secretJson: integration.secretJson || {},
                lease: {
                    version: "legacy-inline",
                    keyVersion: "legacy-inline",
                },
            });
        }

        if (integration.ownership !== "managed") {
            await logCredentialAccess({
                companyId,
                integrationId,
                agentId: resolvedAgentId,
                sessionId: sessionId || null,
                action: "lease",
                status: "metadata_only",
                reason: "integration is local-runtime managed",
                metadataJson: { ownership: integration.ownership, requestedReason: reason || null },
            });

            return NextResponse.json({
                integration,
                managed: false,
                configJson: integration.configJson || {},
            });
        }

        const secretVersion = await getLatestManagedSecret(integrationId, companyId);
        if (!secretVersion) {
            await logCredentialAccess({
                companyId,
                integrationId,
                agentId: resolvedAgentId,
                sessionId: sessionId || null,
                action: "lease",
                status: "failed",
                reason: "no managed secret version available",
            });

            return NextResponse.json({ error: "No managed secret available" }, { status: 404 });
        }

        const secretJson = decryptSecretPayload(secretVersion.encryptedSecret);

        await logCredentialAccess({
            companyId,
            integrationId,
            agentId: resolvedAgentId,
            sessionId: sessionId || null,
            action: "lease",
            status: "success",
            metadataJson: { requestedReason: reason || null, version: secretVersion.version },
        });

        await updateIntegrationLeaseState(integrationId, {
            lastUsedAt: new Date(),
            lastFailureAt: null,
            lastFailureReason: null,
        });

        return NextResponse.json({
            integration: {
                id: integration.id,
                provider: integration.provider,
                name: integration.name,
                ownership: integration.ownership,
                configJson: integration.configJson || {},
            },
            managed: true,
            secretJson,
            lease: {
                version: secretVersion.version,
                keyVersion: secretVersion.keyVersion,
            },
        });
    } catch (error: any) {
        if (!isMissingSchemaError(error)) {
            await updateIntegrationLeaseState(integrationId, {
                lastFailureAt: new Date(),
                lastFailureReason: error.message || "lease failed",
            });
        }

        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
