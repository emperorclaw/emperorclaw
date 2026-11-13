import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { PrivateChatError, updatePrivateChat } from "@/lib/private-chats";
import { CHAT_UPDATE_RATE_LIMIT, normalizeChatTitle } from "@/lib/multi-chat";
import { consumeRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/chat/threads/[id] with exactly one of
 * `{ title }` (rename an extra chat), `{ archived: true }` or `{ archived: false }`.
 * Only the chat's owner; anyone else gets 404.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const { id } = await params;
    const limit = consumeRateLimit({ key: `chat:update:${access.ctx.companyId}:${access.ctx.userId}`, ...CHAT_UPDATE_RATE_LIMIT });
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many changes. Try again in a minute.", code: "rate_limited" }, {
            status: 429, headers: { "Retry-After": Math.ceil(limit.retryAfterMs / 1000).toString() },
        });
    }
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const hasTitle = body !== null && body.title !== undefined;
    const hasArchived = body !== null && body.archived !== undefined;
    if (hasTitle === hasArchived) return NextResponse.json({ error: "Send either title or archived" }, { status: 400 });

    let patch: { title?: string; archived?: boolean };
    if (hasTitle) {
        const title = normalizeChatTitle(body!.title);
        if (!title) return NextResponse.json({ error: "title must be 1-120 characters" }, { status: 400 });
        patch = { title };
    } else {
        if (typeof body!.archived !== "boolean") return NextResponse.json({ error: "archived must be true or false" }, { status: 400 });
        patch = { archived: body!.archived };
    }

    try {
        const thread = await updatePrivateChat(access.ctx.companyId, access.ctx.userId, id, patch);
        return NextResponse.json({
            thread: {
                id: thread.id, title: thread.title, isMain: thread.isMain,
                archivedAt: thread.archivedAt ? thread.archivedAt.toISOString() : null, archiveReason: thread.archiveReason,
            },
        });
    } catch (error) {
        if (error instanceof PrivateChatError) return NextResponse.json(error.body(), { status: error.status });
        console.error("[/api/chat/threads/[id]] PATCH error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
