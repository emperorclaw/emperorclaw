import { NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";

export async function POST() {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    return NextResponse.json({
        error: "Mission execution has been retired. Use explicit project/task CRUD or direct agent threads instead.",
    }, { status: 410 });
}
