import { NextResponse } from "next/server";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvals } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";

/** Pending approvals for the sidebar badge. */
export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const [row] = await db.select({ value: count() }).from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
    return NextResponse.json({ count: Number(row?.value) || 0 });
}
