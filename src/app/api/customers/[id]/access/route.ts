import { NextRequest } from "next/server";
import { addResourceAccess, getResourceAccess, removeResourceAccess, updateResourceAccess } from "@/lib/resource-access-api";

// Who has access to this client (lib/resource-access-api.ts): anyone who can
// see it reads the list; its admins (company or client) change it.
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
    return getResourceAccess("customer", (await params).id);
}

export async function POST(req: NextRequest, { params }: Params) {
    return addResourceAccess(req, "customer", (await params).id);
}

export async function PATCH(req: NextRequest, { params }: Params) {
    return updateResourceAccess(req, "customer", (await params).id);
}

export async function DELETE(req: NextRequest, { params }: Params) {
    return removeResourceAccess(req, "customer", (await params).id);
}
