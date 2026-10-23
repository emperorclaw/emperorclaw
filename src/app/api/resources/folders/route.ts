export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildResourceFolderTree, listScopedResources, moveResourceFolder, deleteResourceFolder } from "@/lib/resources";
import { companyRouteAccess } from "@/lib/company-access";
import { filterResourcesForMember } from "@/lib/member-scope";

function readScope(body: Record<string, unknown>): { scopeType: string | null; scopeId: string | null } {
  return {
    scopeType: typeof body.scopeType === "string" ? body.scopeType : null,
    scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
  };
}


/** The Knowledge & Rules folder tree, derived from note paths. */
export async function GET() {
  try {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const membership = access.ctx;

    const rows = await await filterResourcesForMember(membership.companyId, membership.scope, await listScopedResources({ companyId: membership.companyId }));
    return NextResponse.json({ folders: buildResourceFolderTree(rows) });
  } catch (error) {
    console.error("Error building resource folder tree:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Rename or move a folder.
 *
 * Folders are implicit — they exist only because notes reference them — so
 * this re-files every note under `fromPath`. There is no folder row to rename.
 */
export async function POST(request: Request) {
  try {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const membership = access.ctx;
    // Folder moves/deletes touch every note under a path, across scopes: only
    // members without a restricted scope may reorganise the vault.
    if (membership.scope) {
      return NextResponse.json({ error: "Restricted members cannot reorganise Knowledge folders" }, { status: 403 });
    }

    const body = await request.json();
    const fromPath = typeof body.fromPath === "string" ? body.fromPath : "";
    const toPath = typeof body.toPath === "string" ? body.toPath : "";

    if (!fromPath.trim()) {
      return NextResponse.json({ error: "fromPath is required" }, { status: 400 });
    }

    const moved = await moveResourceFolder({
      companyId: membership.companyId,
      fromPath,
      toPath,
      ...readScope(body),
    });

    const rows = await listScopedResources({ companyId: membership.companyId });
    return NextResponse.json({ moved, folders: buildResourceFolderTree(rows) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    // moveResourceFolder rejects moving a folder into its own subtree.
    const status = message.startsWith("Cannot move") ? 400 : 500;
    if (status === 500) console.error("Error moving resource folder:", error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** Delete a folder and every note inside it (and its subfolders), scoped. */
export async function DELETE(request: Request) {
  try {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const membership = access.ctx;
    // Folder moves/deletes touch every note under a path, across scopes: only
    // members without a restricted scope may reorganise the vault.
    if (membership.scope) {
      return NextResponse.json({ error: "Restricted members cannot reorganise Knowledge folders" }, { status: 403 });
    }

    const body = await request.json();
    const path = typeof body.path === "string" ? body.path : "";
    if (!path.trim()) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const deleted = await deleteResourceFolder({
      companyId: membership.companyId,
      path,
      ...readScope(body),
    });

    const rows = await listScopedResources({ companyId: membership.companyId });
    return NextResponse.json({ deleted, folders: buildResourceFolderTree(rows) });
  } catch (error) {
    console.error("Error deleting resource folder:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
