import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { resourceRouteAccess } from "@/lib/resource-access";
import { memberMaySeeCustomer } from "@/lib/member-scope";
import { humanActor, recordAudit } from "@/lib/audit";
import { lengthError, NAME_MAX } from "@/lib/input-limits";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    // Resource-aware (0.20): editors and admins of this customer may rename it.
    const access = await resourceRouteAccess({ type: "customer", id }, "member", { module: "customers" });
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        const body = await req.json();
        const { name, notes } = body;
        const tooLong = lengthError("name", name, NAME_MAX);
        if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });

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
        await recordAudit({ companyId, actor: humanActor(access.ctx.userId), action: "customer.updated", target: { type: "customer", id }, before: { name: existing.name }, after: { name: customer.name }, meta: { label: customer.name } });

        return NextResponse.json({ customer });
    } catch (error) {
        console.error("Customer update error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
