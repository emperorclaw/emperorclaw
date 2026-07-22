export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";
import { buildResourceFolderTree, createScopedResource, listScopedResources, resolveResourceScope } from "@/lib/resources";

async function getMembership() {
  const session = await getValidatedServerSession();
  const userId = session?.user?.id;
  if (!userId) {
    return null;
  }

  const [membership] = await db.select().from(companyMembers)
    .where(eq(companyMembers.userId, userId))
    .limit(1);

  return membership || null;
}

export async function GET() {
  try {
    const membership = await getMembership();
    if (!membership) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await listScopedResources({
      companyId: membership.companyId,
    });

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
    const membership = await getMembership();
    if (!membership) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid resource payload" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "Resource name is required" }, { status: 400 });
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
      changeSummary: typeof body.changeSummary === "string" ? body.changeSummary : "Operator created Company Brain note",
      createdByType: "user",
      createdById: membership.userId,
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
