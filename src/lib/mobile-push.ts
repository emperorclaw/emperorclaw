import { createHmac } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings, mobilePushDevices, mobileSessions, notifications, sessions, users } from "@/db/schema";
import { decryptSecretPayload } from "@/lib/secrets";
import { filterNotificationsForMember, loadMemberScope } from "@/lib/member-scope";
import { filterNotificationsForAgentUse } from "@/lib/agent-access-server";
import { mobileCompanies } from "@/lib/mobile-auth";

export function mobilePushConfigured() { return Boolean(process.env.MOBILE_PUSH_RELAY_URL && process.env.MOBILE_PUSH_RELAY_KEY); }
export async function relayPush(path: "enroll" | "confirm" | "push", input: Record<string, unknown>) {
    if (!mobilePushConfigured()) throw new Error("Notifications are not configured on this server. Ask its administrator to configure the Apple push relay.");
    const url = new URL(process.env.MOBILE_PUSH_RELAY_URL!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Push relay requires a trusted HTTPS origin");
    const [installation] = await db.select().from(instanceSettings).where(eq(instanceSettings.key, "mobile_installation_id"));
    if (typeof installation?.value !== "string") throw new Error("Mobile discovery must be completed first");
    const body = JSON.stringify({ ...input, installationId: installation.value, timestamp: Date.now() });
    const signature = createHmac("sha256", process.env.MOBILE_PUSH_RELAY_KEY!).update(body).digest("hex");
    const response = await fetch(new URL(`/v1/${path}`, url), { method: "POST", headers: { "Content-Type": "application/json", "X-Emperor-Signature": signature }, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Push relay rejected the request (${response.status})`);
    return response.json();
}

/** Notification payloads are generic; authorization and scope are refreshed
 * before delivery. The server inbox remains the source of truth. */
export async function deliverMobilePush(companyId: string, rows: (typeof notifications.$inferSelect)[]) {
    if (!mobilePushConfigured() || !rows.length) return;
    const devices = await db.select({ push: mobilePushDevices, userId: sessions.userId, role: users.instanceRole, sessionId: sessions.id, deviceKind: mobileSessions.deviceKind, deviceId: mobileSessions.id }).from(mobilePushDevices)
        .innerJoin(mobileSessions, eq(mobileSessions.id, mobilePushDevices.deviceId)).innerJoin(sessions, eq(sessions.id, mobileSessions.sessionId))
        .innerJoin(users, eq(users.id, sessions.userId)).where(and(eq(mobilePushDevices.enabled, true), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt)));
    await Promise.allSettled(devices.map(async (device) => {
        const mine = rows.filter((row) => row.userId === device.userId && device.push.kinds.includes(row.kind));
        if (!mine.length) return;
        const identity = { userId: device.userId, instanceRole: device.role, sessionId: device.sessionId, deviceId: device.deviceId, deviceKind: device.deviceKind };
        if (!(await mobileCompanies(identity)).some((company) => company.id === companyId)) return;
        const scope = await loadMemberScope(device.userId, companyId);
        const ctx = { companyId, userId: device.userId, role: (await mobileCompanies(identity)).find((company) => company.id === companyId)!.role, scope };
        const visible = await filterNotificationsForAgentUse(ctx, await filterNotificationsForMember(companyId, scope, mine));
        const token = (decryptSecretPayload(device.push.tokenEncrypted) as { token: string }).token;
        for (const row of visible) await relayPush("push", { deviceToken: token, environment: device.push.environment, deviceKind: device.deviceKind, eventId: row.id, companyId,
            kind: row.sourceType === "approval" ? "approval" : row.sourceType === "task" ? "task" : "inbox", resourceId: row.sourceId && /^[0-9a-f-]{36}$/i.test(row.sourceId) ? row.sourceId : row.id });
    }));
}
