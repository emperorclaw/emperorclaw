import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { getDirectChatMode } from "@/lib/control-plane";
import { isDirectChatMode } from "@/lib/direct-chat-mode";
import { humanActor, recordAudit } from "@/lib/audit";
import { getMultiChatSettings } from "@/lib/private-chats";
import { parseMultiChatSettingsPatch, type MultiChatSettings } from "@/lib/multi-chat";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("[direct-chats]", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

function multiChatFields(settings: MultiChatSettings) {
    return {
        multiChatEnabled: settings.enabled,
        multiChatMaxOpen: settings.maxOpen,
        multiChatIdleArchiveDays: settings.idleArchiveDays,
    };
}

/** The company's direct-chat mode ("shared" or "private") and its multiple-chats settings. */
export async function GET() {
    try {
        const { companyId } = await requireRole("member")();
        const [mode, multiChat] = await Promise.all([getDirectChatMode(companyId), getMultiChatSettings(companyId)]);
        return NextResponse.json({ mode, ...multiChatFields(multiChat) });
    } catch (error) {
        return failure(error);
    }
}

/**
 * Owners/admins change it: { mode?: "shared" | "private", multiChatEnabled?,
 * multiChatMaxOpen? (1-50), multiChatIdleArchiveDays? (7-90 or null = never) }.
 * Existing threads are never split, merged or archived by a change: the shared
 * thread stays (as the Operations thread in private mode), private threads
 * stay private, and extra chats stay usable when multiple chats are turned off.
 */
export async function PUT(req: NextRequest) {
    try {
        const { companyId, userId } = await requireRole("admin")();
        const body = await req.json().catch(() => ({}));
        const hasMode = body?.mode !== undefined;
        if (hasMode && !isDirectChatMode(body.mode)) {
            return NextResponse.json({ error: "mode must be \"shared\" or \"private\"" }, { status: 400 });
        }
        const parsed = parseMultiChatSettingsPatch(body);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        const { patch } = parsed;
        if (!hasMode && Object.keys(patch).length === 0) {
            return NextResponse.json({ error: "Send mode or a multiChat setting" }, { status: 400 });
        }

        const previous = await getDirectChatMode(companyId);
        const mode = hasMode ? body.mode as "shared" | "private" : previous;
        if (previous !== mode) {
            await db.update(companies).set({ directChatMode: mode }).where(eq(companies.id, companyId));
            await recordAudit({ companyId, actor: humanActor(userId), action: "company.settings_changed", target: { type: "company", id: companyId }, before: { directChatMode: previous }, after: { directChatMode: mode }, meta: { setting: "directChatMode" } });
        }

        const before = await getMultiChatSettings(companyId);
        const after: MultiChatSettings = { ...before, ...patch };
        const changed = before.enabled !== after.enabled || before.maxOpen !== after.maxOpen || before.idleArchiveDays !== after.idleArchiveDays;
        if (changed) {
            await db.update(companies).set({
                multiChatEnabled: after.enabled,
                multiChatMaxOpen: after.maxOpen,
                multiChatIdleArchiveDays: after.idleArchiveDays,
            }).where(eq(companies.id, companyId));
            await recordAudit({ companyId, actor: humanActor(userId), action: "company.settings_changed", target: { type: "company", id: companyId }, before: multiChatFields(before), after: multiChatFields(after), meta: { setting: "multiChat" } });
        }
        return NextResponse.json({ ok: true, mode, ...multiChatFields(after) });
    } catch (error) {
        return failure(error);
    }
}
