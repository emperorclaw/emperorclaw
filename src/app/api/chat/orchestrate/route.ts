import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";

export async function POST() {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;

    return NextResponse.json({
        error: "Mission orchestration has been retired. Create projects/tasks directly or send directives through the real agent thread surfaces.",
    }, { status: 410 });
}
