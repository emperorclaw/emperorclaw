import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { canAdmin } from "@/lib/role-matrix";
import {
    canOfferSampleClient, createSampleClient, removeSampleData, SampleClientConflict, sampleClientStatus,
} from "@/lib/sample-client";

export const dynamic = "force-dynamic";

/** GET — whether this workspace has the sample client, and whether it may add one. */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const status = await sampleClientStatus(access.ctx.companyId);
    return NextResponse.json({
        hasSample: status.hasSample,
        canOffer: canOfferSampleClient({ isAdmin: canAdmin(access.ctx.role), ...status }),
    });
}

/** POST — add "Sample: Harbor Dental" (owners/admins, only while there are no customers). */
export async function POST() {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    try {
        const created = await createSampleClient(access.ctx.companyId, access.ctx.userId);
        return NextResponse.json({ sample: created }, { status: 201 });
    } catch (error) {
        if (error instanceof SampleClientConflict) return NextResponse.json({ error: error.message }, { status: 409 });
        console.error("Sample client create failed:", error);
        return NextResponse.json({ error: "Could not add the sample client." }, { status: 500 });
    }
}

/** DELETE — remove exactly the rows the sample created (owners/admins). */
export async function DELETE() {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    try {
        const removed = await removeSampleData(access.ctx.companyId, access.ctx.userId);
        return NextResponse.json({ removed });
    } catch (error) {
        console.error("Sample data removal failed:", error);
        return NextResponse.json({ error: "Could not remove the sample data." }, { status: 500 });
    }
}
