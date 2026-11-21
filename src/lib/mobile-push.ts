import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings, mobilePushDevices, mobileSessions, notifications, sessions, users } from "@/db/schema";
import { decryptSecretPayload } from "@/lib/secrets";
import { filterNotificationsForMember, loadMemberScope } from "@/lib/member-scope";
import { filterNotificationsForAgentUse } from "@/lib/agent-access-server";
import { mobileCompanies } from "@/lib/mobile-auth";

/** A push-relay problem the person can act on (shown as-is by the mobile API). */
export class PushRelayError extends Error {
    constructor(message: string, readonly status = 503) { super(message); }
}

export function mobilePushConfigured() { return Boolean(process.env.MOBILE_PUSH_RELAY_URL && process.env.MOBILE_PUSH_RELAY_KEY); }
export async function relayPush(path: "enroll" | "confirm" | "push", input: Record<string, unknown>) {
    if (!mobilePushConfigured()) throw new PushRelayError("Push notifications aren't set up on this server yet. Its administrator needs to configure the Apple push relay (MOBILE_PUSH_RELAY_URL and MOBILE_PUSH_RELAY_KEY).");
    const url = new URL(process.env.MOBILE_PUSH_RELAY_URL!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new PushRelayError("The push relay address must be a plain HTTPS origin.");
    const [installation] = await db.select().from(instanceSettings).where(eq(instanceSettings.key, "mobile_installation_id"));
    if (typeof installation?.value !== "string") throw new PushRelayError("Mobile discovery must be completed first");
    const body = JSON.stringify({ ...input, installationId: installation.value, timestamp: Date.now() });
    const signature = createHmac("sha256", process.env.MOBILE_PUSH_RELAY_KEY!).update(body).digest("hex");
    let response: Response;
    try {
        response = await fetch(new URL(`/v1/${path}`, url), { method: "POST", headers: { "Content-Type": "application/json", "X-Emperor-Signature": signature }, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch {
        throw new PushRelayError("The push relay couldn't be reached. Try again shortly.");
    }
    if (!response.ok) throw new PushRelayError(response.status === 401 ? "The push relay rejected this server's key." : `The push relay rejected the request (${response.status}).`, 502);
    return response.json();
}

/** What a phone may show: sealed for that device so neither the relay nor APNs reads it. */
export type PushContent = {
    title: string;
    body: string | null;
    category: "approval" | "reply" | "attention";
    approvalId?: string | null;
    agentId?: string | null;
    threadId?: string | null;
};

/**
 * AES-256-GCM with the device's own 32-byte key, as `nonce ‖ ciphertext ‖ tag`
 * (CryptoKit's `AES.GCM.SealedBox(combined:)`), base64url.
 */
export function sealForDevice(contentKey: string, content: PushContent): string | null {
    const key = Buffer.from(contentKey, "base64url");
    if (key.length !== 32) return null;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const plain = JSON.stringify({
        t: content.title.slice(0, 120), b: content.body ? content.body.slice(0, 280) : null, c: content.category,
        ap: content.approvalId ?? undefined, a: content.agentId ?? undefined, th: content.threadId ?? undefined,
    });
    const sealed = Buffer.concat([nonce, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return sealed.toString("base64url");
}

type PushRow = Pick<typeof notifications.$inferSelect, "id" | "userId" | "kind" | "title" | "body" | "sourceType" | "sourceId">;
type ReplyTarget = { agentId: string | null; threadId: string };

function contentFor(row: PushRow, reply?: ReplyTarget): PushContent {
    if (row.kind === "reply" && reply) return { title: row.title, body: row.body, category: "reply", agentId: reply.agentId, threadId: reply.threadId };
    if (row.sourceType === "approval" && row.sourceId) return { title: row.title, body: row.body, category: "approval", approvalId: row.sourceId };
    return { title: row.title, body: row.body, category: "attention" };
}

/** Notification payloads are authorized and scoped per device before delivery. The server inbox remains the source of truth. */
export async function deliverMobilePush(companyId: string, rows: PushRow[], replies?: Map<string, ReplyTarget>) {
    if (!mobilePushConfigured() || !rows.length) return;
    const devices = await db.select({ push: mobilePushDevices, userId: sessions.userId, role: users.instanceRole, sessionId: sessions.id, deviceKind: mobileSessions.deviceKind, deviceId: mobileSessions.id }).from(mobilePushDevices)
        .innerJoin(mobileSessions, eq(mobileSessions.id, mobilePushDevices.deviceId)).innerJoin(sessions, eq(sessions.id, mobileSessions.sessionId))
        .innerJoin(users, eq(users.id, sessions.userId)).where(and(eq(mobilePushDevices.enabled, true), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt)));
    await Promise.allSettled(devices.map(async (device) => {
        const mine = rows.filter((row) => row.userId === device.userId && device.push.kinds.includes(row.kind));
        if (!mine.length) return;
        const identity = { userId: device.userId, instanceRole: device.role, sessionId: device.sessionId, deviceId: device.deviceId, deviceKind: device.deviceKind };
        const company = (await mobileCompanies(identity)).find((entry) => entry.id === companyId);
        if (!company) return;
        const scope = await loadMemberScope(device.userId, companyId);
        const ctx = { companyId, userId: device.userId, role: company.role, scope };
        const visible = await filterNotificationsForAgentUse(ctx, await filterNotificationsForMember(companyId, scope, mine));
        const secret = decryptSecretPayload(device.push.tokenEncrypted) as { token: string; contentKey?: string };
        for (const row of visible) {
            const content = contentFor(row, replies?.get(row.id));
            const sealed = secret.contentKey ? sealForDevice(secret.contentKey, content) : null;
            await relayPush("push", {
                deviceToken: secret.token, environment: device.push.environment, deviceKind: device.deviceKind, eventId: row.id, companyId,
                kind: row.sourceType === "approval" ? "approval" : row.sourceType === "task" ? "task" : "inbox",
                resourceId: row.sourceId && /^[0-9a-f-]{36}$/i.test(row.sourceId) ? row.sourceId : row.id,
                ...(sealed ? { sealed, category: content.category } : {}),
            });
        }
    }));
}

/**
 * A phone-only alert with no inbox row, email or webhook (an agent's reply in
 * your direct chat: the chat itself is the record). Same per-device scope checks.
 */
export async function pushOnlyToPhones(companyId: string, userIds: string[], input: { kind: "reply"; title: string; body: string | null; sourceType: "message"; sourceId: string; reply: ReplyTarget }) {
    if (!mobilePushConfigured()) return;
    const rows: PushRow[] = [...new Set(userIds)].map((userId) => ({ id: randomUUID(), userId, kind: input.kind, title: input.title.slice(0, 200), body: input.body ? input.body.slice(0, 500) : null, sourceType: input.sourceType, sourceId: input.sourceId }));
    await deliverMobilePush(companyId, rows, new Map(rows.map((row) => [row.id, input.reply])));
}
