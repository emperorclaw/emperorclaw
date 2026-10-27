export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { archiveScopedResource, resolveResourceScope, resourceNameError, updateScopedResource } from "@/lib/resources";
import { companyRouteAccess } from "@/lib/company-access";
import { memberResourceDenied } from "../_shared";
import { memberMaySeeResource } from "@/lib/member-scope";
import { humanActor } from "@/lib/audit";


export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const membership = access.ctx;

    const { id } = await params;
    const denied = await memberResourceDenied(membership, id);
    if (denied) return denied;
    const archived = await archiveScopedResource(membership.companyId, id, humanActor(membership.userId));
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
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const membership = access.ctx;

    const { id } = await params;
    const denied = await memberResourceDenied(membership, id);
    if (denied) return denied;
    const body = await request.json();

    const patch: {
      name?: string;
      displayName?: string | null;
      path?: string | null;
      resourceType?: string;
      provider?: string;
      configText?: string;
      secretText?: string;
      isShared?: boolean;
      inject?: string;
      summary?: string | null;
      scopeType?: string;
      scopeId?: string | null;
      changeSummary?: string;
      createdByType?: string;
      createdById?: string;
    } = {};
    if (body.name !== undefined) patch.name = typeof body.name === "string" ? body.name.trim() : "";
    if (body.displayName !== undefined) patch.displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    // Moving a note between folders. null/"" files it at the vault root.
    if (body.path !== undefined) patch.path = typeof body.path === "string" ? body.path : null;
    if (body.resourceType !== undefined) patch.resourceType = typeof body.resourceType === "string" ? body.resourceType : "external_account";
    if (body.provider !== undefined) patch.provider = typeof body.provider === "string" ? body.provider.trim() || "generic" : "generic";
    if (body.configJson !== undefined) patch.configText = body.configJson;
    if (body.configText !== undefined) patch.configText = body.configText;
    if (body.secretText !== undefined) patch.secretText = body.secretText;
    if (body.secretJson !== undefined) patch.secretText = body.secretJson;
    if (body.isShared !== undefined) patch.isShared = typeof body.isShared === "boolean" ? body.isShared : false;
    if (body.inject !== undefined) patch.inject = typeof body.inject === "string" ? body.inject : "index";
    if (body.summary !== undefined) patch.summary = typeof body.summary === "string" ? body.summary : null;
    if (body.scopeType !== undefined) patch.scopeType = typeof body.scopeType === "string" ? body.scopeType : "company";
    if (body.scopeId !== undefined) patch.scopeId = typeof body.scopeId === "string" && body.scopeId.trim() ? body.scopeId.trim() : null;
    if (body.changeSummary !== undefined && typeof body.changeSummary === "string") patch.changeSummary = body.changeSummary.trim();
    const nameError = resourceNameError(patch);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
    if ((patch.scopeType !== undefined || patch.scopeId !== undefined)
      && !(await memberMaySeeResource(membership.companyId, membership.scope, { scopeType: patch.scopeType ?? "company", scopeId: patch.scopeId ?? null }))) {
      return NextResponse.json({ error: "That scope is outside your access" }, { status: 403 });
    }
    patch.createdByType = "user";
    patch.createdById = membership.userId;

    const updated = await updateScopedResource({
      companyId: membership.companyId,
      resourceId: id,
      patch,
      actor: humanActor(membership.userId),
    });

    if (!updated) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    return NextResponse.json({ resource: { ...updated, ...resolveResourceScope(updated), secretText: undefined } });
  } catch (error) {
    console.error("Error updating scoped resource:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
