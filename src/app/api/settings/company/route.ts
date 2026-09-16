import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function PATCH(req: NextRequest) {
    try {
        // contextNotes is injected into every agent's MCP instructions block, so
        // letting any member edit it is a prompt-injection path into agents that
        // run with terminal/web tools. Restrict writes to admins.
        const ctx = await requireRole("admin")();
        const userId = ctx.userId;

        const { contextNotes } = await req.json();

        const [updatedCompany] = await db.update(companies)
            .set({ contextNotes })
            .where(eq(companies.id, ctx.companyId))
            .returning();

        await broadcastMcpEvent(ctx.companyId, {
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
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.statusCode });
        }
        console.error("Error updating company context:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
