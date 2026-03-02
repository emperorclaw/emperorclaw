import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companies, companyMembers } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function PATCH(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user || !(session.user as any).id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userId = (session.user as any).id;

        // Verify the user is a member of a company
        const [membership] = await db.select().from(companyMembers)
            .where(eq(companyMembers.userId, userId))
            .limit(1);

        if (!membership) {
            return NextResponse.json({ error: "No associated company found" }, { status: 404 });
        }

        const { contextNotes } = await req.json();

        // Update the company context
        const [updatedCompany] = await db.update(companies)
            .set({ contextNotes, deletedAt: null }) // Setting deletedAt temporarily to ensure update payload maps cleanly in simple schema update cases
            .where(eq(companies.id, membership.companyId))
            .returning();

        return NextResponse.json({
            message: "Company context updated",
            company: updatedCompany
        });

    } catch (error) {
        console.error("Error updating company context:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
