import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companyNotificationWebhooks } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { canManageSecrets, encryptSecretPayload } from "@/lib/secrets";
import { detectWebhookFormat, NOTIFICATION_KINDS, type WebhookFormat } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const DEFAULT_WEBHOOK_KINDS = ["decision", "approval", "agent_failed", "incident"];

function hintFor(url: URL): string {
    return `${url.protocol}//${url.hostname}/…${url.pathname.slice(-4)}`;
}

async function admin() {
    return requireRole("admin")();
}

function authFailure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("[notifications] webhook:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** The company's webhook, without its URL (a credential): format, kinds, last delivery. */
export async function GET() {
    try {
        const { companyId } = await admin();
        const [hook] = await db.select().from(companyNotificationWebhooks).where(eq(companyNotificationWebhooks.companyId, companyId)).limit(1);
        return NextResponse.json({
            canStoreSecrets: canManageSecrets(),
            kinds: NOTIFICATION_KINDS,
            webhook: hook ? {
                urlHint: hook.urlHint,
                format: hook.format,
                kinds: hook.kinds,
                enabled: hook.enabled,
                lastDeliveryAt: hook.lastDeliveryAt,
                lastError: hook.lastError,
            } : null,
        });
    } catch (error) {
        return authFailure(error);
    }
}

/** Set or update: { url?, format?, kinds?, enabled? }. The URL is stored encrypted. */
export async function PUT(req: NextRequest) {
    try {
        const { companyId } = await admin();
        const body = await req.json().catch(() => ({}));
        const [existing] = await db.select().from(companyNotificationWebhooks).where(eq(companyNotificationWebhooks.companyId, companyId)).limit(1);

        const kinds = Array.isArray(body.kinds)
            ? body.kinds.filter((k: unknown): k is string => typeof k === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(k))
            : existing?.kinds ?? DEFAULT_WEBHOOK_KINDS;
        const enabled = typeof body.enabled === "boolean" ? body.enabled : existing?.enabled ?? true;

        let encryptedUrl = existing?.encryptedUrl;
        let urlHint = existing?.urlHint;
        let format = (["slack", "discord", "generic"].includes(body.format) ? body.format : existing?.format) as WebhookFormat | undefined;
        if (typeof body.url === "string" && body.url.trim()) {
            if (!canManageSecrets()) {
                return NextResponse.json({ error: "Set EMPEROR_CLAW_MASTER_KEY to store a webhook URL: it is a credential and is kept encrypted." }, { status: 400 });
            }
            let url: URL;
            try {
                url = new URL(body.url.trim());
            } catch {
                return NextResponse.json({ error: "That isn't a valid URL" }, { status: 400 });
            }
            if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
                return NextResponse.json({ error: "Webhook URLs must use https" }, { status: 400 });
            }
            encryptedUrl = encryptSecretPayload({ url: url.toString() })!.encryptedSecret;
            urlHint = hintFor(url);
            if (!["slack", "discord", "generic"].includes(body.format)) format = detectWebhookFormat(url.toString());
        }
        if (!encryptedUrl || !urlHint) return NextResponse.json({ error: "A webhook URL is required" }, { status: 400 });

        const values = { encryptedUrl, urlHint, format: format ?? "generic", kinds, enabled, updatedAt: new Date() };
        await db.insert(companyNotificationWebhooks).values({ companyId, ...values })
            .onConflictDoUpdate({ target: companyNotificationWebhooks.companyId, set: values });
        return NextResponse.json({ ok: true, webhook: { urlHint, format: values.format, kinds, enabled } });
    } catch (error) {
        return authFailure(error);
    }
}

export async function DELETE() {
    try {
        const { companyId } = await admin();
        await db.delete(companyNotificationWebhooks).where(eq(companyNotificationWebhooks.companyId, companyId));
        return NextResponse.json({ ok: true });
    } catch (error) {
        return authFailure(error);
    }
}
