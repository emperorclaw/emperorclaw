import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { HERMES_IMAGE } from "@/lib/hermes-provisioning";
import { getHermesImagePullState } from "@/lib/hermes-image-prefetch";

export const dynamic = "force-dynamic";

// GET /api/runtime/hermes-image — download progress of this release's Hermes
// runtime image, so the setup wizard can show the one-time pull instead of a
// bare spinner. Any company member may read it; it carries no company data.
export async function GET() {
    try {
        await requireRole("viewer")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }
    return NextResponse.json(getHermesImagePullState(HERMES_IMAGE), { headers: { "Cache-Control": "no-store" } });
}
