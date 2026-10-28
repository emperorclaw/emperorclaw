import { NextRequest } from "next/server";
import { addResourceAccess, getResourceAccess, removeResourceAccess, updateResourceAccess } from "@/lib/resource-access-api";

// Who has access to this project (lib/resource-access-api.ts): anyone who can
// see it reads the list (people with access through its client included); its
// admins (company, client or project) change it.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
    return getResourceAccess("project", (await params).projectId);
}

export async function POST(req: NextRequest, { params }: Params) {
    return addResourceAccess(req, "project", (await params).projectId);
}

export async function PATCH(req: NextRequest, { params }: Params) {
    return updateResourceAccess(req, "project", (await params).projectId);
}

export async function DELETE(req: NextRequest, { params }: Params) {
    return removeResourceAccess(req, "project", (await params).projectId);
}
