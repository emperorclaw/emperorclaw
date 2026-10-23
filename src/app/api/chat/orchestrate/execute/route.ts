import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";

export async function POST() {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;

    return NextResponse.json({
        error: "Mission execution has been retired. Use explicit project/task CRUD or direct agent threads instead.",
    }, { status: 410 });
}
