import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { loadMessagesListing, markThreadsReadForUser } from "@/lib/messages-listing";

// "Mark all as read" in Messages: moves the current human's read cursor to now
// on exactly the conversations the Messages page lists (and the badge counts).
// Work logs and anything the list does not show keep their unread state.
// Marking read is the viewer's own presence, so any role may do it.
export async function POST() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { companyId, userId, role, scope } = access.ctx;

    try {
        const { listedThreadIds } = await loadMessagesListing({ companyId, userId, role, scope });
        const threads = await markThreadsReadForUser(companyId, userId, listedThreadIds);
        return NextResponse.json({ ok: true, threads });
    } catch (error) {
        console.error("[/api/chat/read-all] POST error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
