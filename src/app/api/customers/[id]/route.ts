import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeCustomer } from "@/lib/member-scope";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        const { id } = await params;
        const body = await req.json();
        const { name, notes } = body;

        const [existing] = await db.select().from(customers).where(and(
            eq(customers.companyId, companyId),
            eq(customers.id, id),
            isNull(customers.deletedAt),
        )).limit(1);

        if (!existing || !memberMaySeeCustomer(access.ctx.scope, existing.id)) {
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }

        const [customer] = await db.update(customers).set({
            name: typeof name === "string" && name.trim().length > 0 ? name.trim() : existing.name,
            notes: typeof notes === "string" ? notes : existing.notes,
        }).where(eq(customers.id, id)).returning();

        return NextResponse.json({ customer });
    } catch (error) {
        console.error("Customer update error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
