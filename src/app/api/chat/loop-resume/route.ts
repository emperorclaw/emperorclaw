import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { appendThreadMessage, currentAgentStreak } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { firstForwardedHost } from "@/lib/env";
import { isAgentPairThread } from "@/lib/groups";
import { agentLoopMaxTurnsFor } from "@/lib/message-routing";
import { AuthError, requireRole, roleGte } from "@/lib/roles";

/**
 * Same-origin guard for the cookie-authenticated mutating route: a cross-site
 * POST (CSRF) sends an Origin header that does not match the request host.
 * Requests without an Origin header (non-browser clients) pass, matching how
 * the rest of the app relies on the SameSite session cookie.
 */
function isSameOrigin(req: NextRequest): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    const host = firstForwardedHost(req.headers.get("x-forwarded-host")) || req.headers.get("host");
    if (!host) return true;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

/**
 * The "Resume" action on a loop-pause notice: posts a system marker that resets
 * the agent streak, so the paused conversation may continue. Members+ (not
 * viewers) may resume; a pair thread still requires owner/admin to read it.
 */
export async function POST(req: NextRequest) {
    try {
        if (!isSameOrigin(req)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { companyId, userId, role } = await requireRole("member")();

        const { threadId } = await req.json();
        if (!threadId || typeof threadId !== "string") {
            return NextResponse.json({ error: "threadId is required" }, { status: 400 });
        }

        const [thread] = await db.select().from(messageThreads)
            .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId)))
            .limit(1);
        if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

        // Only shared threads (team, group, and pair threads which are group
        // threads) can be paused; a direct thread never pauses.
        if (thread.type !== "team" && thread.type !== "group") {
            return NextResponse.json({ error: "This thread type cannot be paused" }, { status: 400 });
        }
        if (isAgentPairThread(thread) && !roleGte(role, "admin")) {
            return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }

        // Only resume when the thread is actually paused (else 409), so a
        // spurious resume marker never silently resets a healthy streak.
        const max = agentLoopMaxTurnsFor(isAgentPairThread(thread));
        if ((await currentAgentStreak(companyId, threadId, max + 5)) < max + 1) {
            return NextResponse.json({ error: "Thread is not paused" }, { status: 409 });
        }

        const message = await appendThreadMessage({
            companyId,
            threadId: thread.id,
            senderType: "system",
            senderId: userId,
            text: "Resumed by a human.",
            metadataJson: { loopGuardResume: true },
            deliveryState: "resolved",
        });

        broadcastMcpEvent(companyId, { type: "thread_message", thread, message });
        return NextResponse.json({ ok: true, message });
    } catch (error: unknown) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
