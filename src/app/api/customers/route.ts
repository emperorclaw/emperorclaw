import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";

export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await db.select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)))
        .orderBy(desc(customers.createdAt));

    return NextResponse.json({ customers: rows });
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { name, notes } = body;
        if (!name || typeof name !== "string") {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }

        const [existing] = await db.select().from(customers).where(and(
            eq(customers.companyId, companyId),
            eq(customers.name, name.trim()),
            isNull(customers.deletedAt),
        )).limit(1);

        if (existing) {
            return NextResponse.json({ error: "Customer already exists" }, { status: 409 });
        }

        const [customer] = await db.insert(customers).values({
            id: randomUUID(),
            companyId,
            name: name.trim(),
            notes: typeof notes === "string" ? notes : null,
        }).returning();

        return NextResponse.json({ customer }, { status: 201 });
    } catch (error) {
        console.error("Customer create error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
