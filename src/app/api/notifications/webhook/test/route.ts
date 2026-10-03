import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companyNotificationWebhooks } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { postWebhook } from "@/lib/notifications";

/** Send a test notification to the company webhook. */
export async function POST() {
    try {
        const { companyId } = await requireRole("admin")();
        const [hook] = await db.select().from(companyNotificationWebhooks).where(eq(companyNotificationWebhooks.companyId, companyId)).limit(1);
        if (!hook) return NextResponse.json({ error: "No webhook configured" }, { status: 404 });
        const result = await postWebhook(hook, {
            kind: "incident",
            title: "Test notification from EmperorClaw",
            body: "If you can read this, notifications reach this channel.",
            link: "/settings",
        });
        return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
