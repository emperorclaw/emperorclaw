import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { agentIntegrations } from "@/db/schema";
import { getLatestManagedSecret, logCredentialAccess } from "@/lib/control-plane";
import { decryptSecretPayload } from "@/lib/secrets";

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

        const [integration] = await db.select().from(agentIntegrations).where(
            and(
                eq(agentIntegrations.id, integrationId),
                eq(agentIntegrations.companyId, companyId),
                eq(agentIntegrations.agentId, agentId),
                eq(agentIntegrations.status, "active")
            )
        ).limit(1);

        if (!integration) {
            return NextResponse.json({ error: "Integration not found" }, { status: 404 });
        }

        const resolvedAgentId = await resolveAgentId(companyId, agentId);

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

        await db.update(agentIntegrations).set({
            lastUsedAt: new Date(),
            lastFailureAt: null,
            lastFailureReason: null,
            updatedAt: new Date(),
        }).where(eq(agentIntegrations.id, integrationId));

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
        await db.update(agentIntegrations).set({
            lastFailureAt: new Date(),
            lastFailureReason: error.message || "lease failed",
            updatedAt: new Date(),
        }).where(eq(agentIntegrations.id, integrationId));

        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
