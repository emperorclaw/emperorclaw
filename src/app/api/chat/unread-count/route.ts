import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { loadMessagesListing, unreadCountsForUser } from "@/lib/messages-listing";

// Total unread agent messages across the conversations the Messages page lists
// for the current human (lib/messages-listing.ts). Used for the sidebar badge.
// An agent's Work log is not listed, so it is not counted here: the agent's
// panel shows its own unread count.
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { companyId, userId, role, scope } = access.ctx;

    try {
        const { listedThreadIds } = await loadMessagesListing({ companyId, userId, role, scope });
        let total = 0;
        for (const value of (await unreadCountsForUser(companyId, userId, listedThreadIds)).values()) total += value;
        return NextResponse.json({ count: total });
    } catch (error) {
        console.error("[/api/chat/unread-count] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
