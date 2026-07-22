import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { createScopedResource, listScopedResources, resolveResourceScope } from "@/lib/resources";
import { scopedResources } from "@/db/schema";

function sanitizeResource(resource: typeof scopedResources.$inferSelect) {
  return {
    ...resource,
    ...resolveResourceScope(resource),
    secretText: undefined,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId } = await params;
  const { searchParams } = new URL(req.url);
  const resourceType = searchParams.get("resourceType");
  const isSharedParam = searchParams.get("isShared");
  const isShared = isSharedParam === null ? undefined : isSharedParam === "true";

  try {
    const resources = await listScopedResources({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      resourceType,
      provider: searchParams.get("provider"),
      name: searchParams.get("name"),
      displayName: searchParams.get("displayName"),
      search: searchParams.get("search") || searchParams.get("q"),
      status: searchParams.get("status"),
      isShared,
    });
    return NextResponse.json({ resources: resources.map(sanitizeResource) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const companyId = auth.companyToken!.companyId;
    const { projectId } = await params;
    const body = await req.json();

    if (!body.name || !body.resourceType || !body.provider) {
      return NextResponse.json({ error: "name, resourceType, and provider are required" }, { status: 400 });
    }

    const resource = await createScopedResource({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      name: body.name,
      displayName: body.displayName || null,
      path: body.path || null,
      resourceType: body.resourceType,
      provider: body.provider,
      configText: body.configJson || body.configText || "",
      secretText: body.secretJson || body.secretText || "",
      status: body.status || "active",
      ownership: body.ownership || "managed",
      isShared: typeof body.isShared === "boolean" ? body.isShared : undefined,
    });

    return NextResponse.json({ resource: sanitizeResource(resource) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
