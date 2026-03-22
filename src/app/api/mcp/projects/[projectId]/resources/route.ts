import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { createScopedResource, listScopedResources, resolveResourceScope } from "@/lib/resources";
import { scopedResources } from "@/db/schema";

function sanitizeResource(resource: typeof scopedResources.$inferSelect) {
  return {
    ...resource,
    ...resolveResourceScope(resource),
    secretJson: undefined,
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

  try {
    const resources = await listScopedResources({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      resourceType,
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
      resourceType: body.resourceType,
      provider: body.provider,
      configJson: body.configJson || {},
      secretJson: body.secretJson || {},
      status: body.status || "active",
      ownership: body.ownership || "managed",
    });

    return NextResponse.json({ resource: sanitizeResource(resource) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
