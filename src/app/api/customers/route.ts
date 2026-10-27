import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";
import { memberCustomerCondition, memberMaySeeCustomer } from "@/lib/member-scope";
import { humanActor, recordAudit } from "@/lib/audit";
import { lengthError, NAME_MAX } from "@/lib/input-limits";

export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const rows = await db.select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt), memberCustomerCondition(access.ctx.scope, customers.id)))
        .orderBy(desc(customers.createdAt));

    return NextResponse.json({ customers: rows });
}

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        const body = await req.json();
        const { name, notes } = body;
        if (!name || typeof name !== "string") {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        const tooLong = lengthError("name", name, NAME_MAX);
        if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });

        const [existing] = await db.select().from(customers).where(and(
            eq(customers.companyId, companyId),
            eq(customers.name, name.trim()),
            isNull(customers.deletedAt),
        )).limit(1);

        if (existing && !memberMaySeeCustomer(access.ctx.scope, existing.id)) {
            // Upsert-by-name must not let a restricted member touch a customer outside their scope.
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }
        if (existing) {
            return NextResponse.json({ error: "Customer already exists" }, { status: 409 });
        }

        const [customer] = await db.insert(customers).values({
            id: randomUUID(),
            companyId,
            name: name.trim(),
            notes: typeof notes === "string" ? notes : null,
        }).returning();
        await recordAudit({ companyId, actor: humanActor(access.ctx.userId), action: "customer.created", target: { type: "customer", id: customer.id }, after: { name: customer.name } });

        return NextResponse.json({ customer }, { status: 201 });
    } catch (error) {
        console.error("Customer create error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
