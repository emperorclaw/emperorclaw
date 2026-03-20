import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { agentIntegrations, agents, integrationSecretVersions } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { canManageSecrets, encryptSecretPayload } from "@/lib/secrets";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> } // In Next.js 15, params is a Promise
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;

    try {
        // Verify agent exists and belongs to company
        const [existingAgent] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existingAgent) {
            return NextResponse.json({ error: "Agent not found or unauthorized." }, { status: 404 });
        }

        // Fetch integrations
        const activeIntegrations = await db.select().from(agentIntegrations).where(
            and(
                eq(agentIntegrations.agentId, agentId),
                eq(agentIntegrations.companyId, companyId),
                eq(agentIntegrations.status, 'active')
            )
        );

        return NextResponse.json({
            integrations: activeIntegrations.map(({ secretJson, ...integration }) => ({
                ...integration,
                secretConfigured: integration.ownership === "managed",
                secretJson: undefined,
            })),
        }, { status: 200 });

    } catch (err) {
        console.error(`Error fetching integrations for agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;
    const endpoint = `/api/mcp/agents/${agentId}/integrations`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { provider, name, configJson, secretJson } = body;

        if (!provider || !name) {
            return NextResponse.json({ error: "provider and name are required" }, { status: 400 });
        }

        // Verify agent exists
        const [existingAgent] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existingAgent) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        const ownership = canManageSecrets() ? "managed" : "local_runtime";
        const [newIntegration] = await db.insert(agentIntegrations).values({
            companyId,
            agentId,
            provider,
            name,
            ownership,
            configJson: configJson || {},
            secretJson: ownership === "managed" ? {} : {},
            status: 'active'
        }).returning();

        if (ownership === "managed" && secretJson && Object.keys(secretJson).length > 0) {
            const encrypted = encryptSecretPayload(secretJson);
            if (!encrypted) {
                throw new Error("Managed secret storage is unavailable");
            }

            await db.insert(integrationSecretVersions).values({
                companyId,
                integrationId: newIntegration.id,
                version: 1,
                encryptedSecret: encrypted.encryptedSecret,
                keyVersion: encrypted.keyVersion,
            });
        }

        const res = {
            message: "Integration added successfully",
            integration: {
                ...newIntegration,
                secretJson: undefined,
                secretConfigured: ownership === "managed",
            },
        };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });

    } catch (err) {
        console.error(`Error adding integration for agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;
    const { searchParams } = new URL(req.url);
    const integrationId = searchParams.get('integrationId');

    if (!integrationId) {
        return NextResponse.json({ error: "integrationId search param is required" }, { status: 400 });
    }

    try {
        const [existing] = await db.select().from(agentIntegrations).where(
            and(
                eq(agentIntegrations.id, integrationId),
                eq(agentIntegrations.agentId, agentId),
                eq(agentIntegrations.companyId, companyId),
                eq(agentIntegrations.status, 'active')
            )
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Integration not found or unauthorized" }, { status: 404 });
        }

        await db.update(agentIntegrations)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(eq(agentIntegrations.id, integrationId));

        return NextResponse.json({ message: "Integration archived successfully" }, { status: 200 });

    } catch (err) {
        console.error(`Error deleting integration for agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
