export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildResourceFolderTree, createScopedResource, listScopedResources, resolveResourceScope, resourceNameError } from "@/lib/resources";
import { companyRouteAccess } from "@/lib/company-access";
import { filterResourcesForMember, memberMaySeeResource } from "@/lib/member-scope";
import { humanActor } from "@/lib/audit";


export async function GET() {
  try {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const membership = access.ctx;

    const rows = await filterResourcesForMember(membership.companyId, membership.scope, await listScopedResources({
      companyId: membership.companyId,
    }));

    return NextResponse.json({
      resources: rows.map((resource) => ({
        ...resource,
        ...resolveResourceScope(resource),
        secretText: undefined,
      })),
      folders: buildResourceFolderTree(rows),
    });
  } catch (error) {
    console.error("Error fetching scoped resources:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const membership = access.ctx;

    const body = await request.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid resource payload" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "Resource name is required" }, { status: 400 });
    }
    const nameError = resourceNameError({ name, displayName: body.displayName });
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

    const targetScope = {
      scopeType: typeof body.scopeType === "string" ? body.scopeType : "company",
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
    };
    if (!(await memberMaySeeResource(membership.companyId, membership.scope, targetScope))) {
      return NextResponse.json({ error: "That scope is outside your access" }, { status: 403 });
    }

    const resource = await createScopedResource({
      companyId: membership.companyId,
      scopeType: typeof body.scopeType === "string" ? body.scopeType : "company",
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      provider: typeof body.provider === "string" ? body.provider.trim() || "generic" : "generic",
      resourceType: typeof body.resourceType === "string" ? body.resourceType : "external_account",
      name,
      displayName: typeof body.displayName === "string" ? body.displayName.trim() : null,
      path: typeof body.path === "string" ? body.path : null,
      configText: typeof body.configJson === "string" ? body.configJson : body.configText || "",
      secretText: typeof body.secretJson === "string" ? body.secretJson : body.secretText || "",
      status: "active",
      ownership: "managed",
      isShared: typeof body.isShared === "boolean" ? body.isShared : false,
      inject: typeof body.inject === "string" ? body.inject : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      changeSummary: typeof body.changeSummary === "string" ? body.changeSummary : "Operator created Company Brain note",
      createdByType: "user",
      createdById: membership.userId,
      actor: humanActor(membership.userId),
    });

    return NextResponse.json({
      resource: {
        ...resource,
        ...resolveResourceScope(resource),
        secretText: undefined,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("Error creating scoped resource:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
