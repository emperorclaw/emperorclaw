import { NextRequest, NextResponse } from "next/server";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companies, companyMembers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function PATCH(req: NextRequest) {
    try {
        const session = await getValidatedServerSession();
        const sessionUserId = session?.user?.id;
        if (!sessionUserId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userId = sessionUserId;

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

        await broadcastMcpEvent(membership.companyId, {
            type: "company_context_updated",
            actorUserId: userId,
            company: {
                id: updatedCompany.id,
                contextNotes: updatedCompany.contextNotes,
            },
        });

        return NextResponse.json({
            message: "Company context updated",
            company: updatedCompany
        });

    } catch (error) {
        console.error("Error updating company context:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
