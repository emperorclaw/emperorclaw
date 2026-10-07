import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { upgradeStarterDoctrine } from "@/lib/starter-knowledge";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("[starter-doctrine]", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** Admins: bring the company's starter Knowledge & Rules up to the current doctrine. */
export async function POST() {
    try {
        const { companyId } = await requireRole("admin")();
        const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
        if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
        const result = await upgradeStarterDoctrine({ companyId, companyName: company.name });
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        return failure(error);
    }
}
