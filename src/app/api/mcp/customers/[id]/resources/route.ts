import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { checkIdempotency, saveIdempotencyResponse, verifyMcpToken } from "@/lib/mcp";
import { createScopedResource, listScopedResources } from "@/lib/resources";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id } = await params;

    const [customer] = await db.select({ id: customers.id }).from(customers).where(and(
        eq(customers.companyId, companyId),
        eq(customers.id, id),
        isNull(customers.deletedAt),
    )).limit(1);

    if (!customer) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const isSharedParam = searchParams.get("isShared");
    const isShared = isSharedParam === null ? undefined : isSharedParam === "true";
    const resources = await listScopedResources({
        companyId,
        scopeType: "customer",
        scopeId: id,
        resourceType: searchParams.get("resourceType"),
        provider: searchParams.get("provider"),
        name: searchParams.get("name"),
        displayName: searchParams.get("displayName"),
        search: searchParams.get("search") || searchParams.get("q"),
        status: searchParams.get("status"),
        isShared,
    });
    return NextResponse.json({ resources });
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
    const { id } = await params;
    const endpoint = `/api/mcp/customers/${id}/resources`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const [customer] = await db.select({ id: customers.id }).from(customers).where(and(
        eq(customers.companyId, companyId),
        eq(customers.id, id),
        isNull(customers.deletedAt),
    )).limit(1);

    if (!customer) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    try {
        const body = await req.json();
        const { provider, resourceType, name, displayName, configJson, secretJson, ownership } = body;

        if (!provider || !resourceType || !name) {
            return NextResponse.json({ error: "provider, resourceType, and name are required" }, { status: 400 });
        }

        const resource = await createScopedResource({
            companyId,
            scopeType: "customer",
            scopeId: id,
            provider,
            resourceType,
            name,
            displayName: displayName || null,
            configText: configJson || body.configText || "",
            secretText: secretJson || body.secretText || "",
            ownership: ownership || null,
            isShared: typeof body.isShared === "boolean" ? body.isShared : undefined,
        });

        const res = { resource };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (routeError) {
        const message = routeError instanceof Error ? routeError.message : "Internal Server Error";
        const routeStatus = message.includes("required") || message.startsWith("Unsupported") ? 400 : 500;
        return NextResponse.json({ error: message }, { status: routeStatus });
    }
}
