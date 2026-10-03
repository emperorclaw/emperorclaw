import { NextRequest } from "next/server";
import { archiveGroup, getGroup, updateGroup } from "@/lib/groups";
import { announceGroup, groupRoute } from "@/lib/group-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
    const { id } = await params;
    return groupRoute(async ({ companyId }) => ({ group: await getGroup(companyId, id) }));
}

/** Rename or re-describe: { title?, description? }. */
export async function PATCH(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupRoute(async ({ companyId }) => {
        const group = await updateGroup(companyId, id, body);
        announceGroup(companyId, id, "updated");
        return { group };
    });
}

/** Archive the group. Its history is kept; it just leaves the sidebar and stops delivering. */
export async function DELETE(_req: NextRequest, { params }: Params) {
    const { id } = await params;
    return groupRoute(async ({ companyId }) => {
        await archiveGroup(companyId, id);
        announceGroup(companyId, id, "archived");
        return { ok: true };
    });
}
