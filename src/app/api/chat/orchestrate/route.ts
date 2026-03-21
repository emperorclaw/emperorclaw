import { NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";

export async function POST() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    return NextResponse.json({
        error: "Mission orchestration has been retired. Create projects/tasks directly or send directives through the real agent thread surfaces.",
    }, { status: 410 });
}
