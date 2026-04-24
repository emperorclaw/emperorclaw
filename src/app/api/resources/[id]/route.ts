export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";
import { archiveScopedResource, updateScopedResource } from "@/lib/resources";

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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const membership = await getMembership();
    if (!membership) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const archived = await archiveScopedResource(membership.companyId, id);
    if (!archived) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error archiving scoped resource:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}


export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const membership = await getMembership();
    if (!membership) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();

    const patch: any = {};
    if (body.name !== undefined) patch.name = typeof body.name === "string" ? body.name.trim() : "";
    if (body.displayName !== undefined) patch.displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    if (body.resourceType !== undefined) patch.resourceType = typeof body.resourceType === "string" ? body.resourceType : "external_account";
    if (body.provider !== undefined) patch.provider = typeof body.provider === "string" ? body.provider.trim() || "generic" : "generic";
    if (body.configJson !== undefined) patch.configText = body.configJson;
    if (body.configText !== undefined) patch.configText = body.configText;
    if (body.secretText !== undefined) patch.secretText = body.secretText;
    if (body.secretJson !== undefined) patch.secretText = body.secretJson;
    if (body.isShared !== undefined) patch.isShared = typeof body.isShared === "boolean" ? body.isShared : false;

    const updated = await updateScopedResource({
      companyId: membership.companyId,
      resourceId: id,
      patch
    });

    if (!updated) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    return NextResponse.json({ resource: updated });
  } catch (error) {
    console.error("Error updating scoped resource:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
