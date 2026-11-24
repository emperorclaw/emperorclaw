import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mobilePushDevices } from "@/db/schema";
import { mobileIdentity } from "@/lib/mobile-auth";
import { encryptSecretPayload } from "@/lib/secrets";
import { PushRelayError, relayPush } from "@/lib/mobile-push";
import { mobileJson, mobileError } from "@/lib/mobile-response";
import { consumeRateLimit } from "@/lib/rate-limit";
import { DEFAULT_MOBILE_PUSH_KINDS, MOBILE_PUSH_KINDS } from "@/lib/notifications";

export async function POST(request: Request) {
    try {
        const identity = await mobileIdentity(request);
        if (!consumeRateLimit({ key: `mobile:push:${identity.deviceId}`, limit: 10, windowMs: 60_000 }).allowed) return mobileJson({ error: "Too many requests" }, 429);
        const body = await request.json();
        if (!body || typeof body !== "object") return mobileJson({ error: "Invalid request" }, 400);
        if (body.enabled === false) { await db.delete(mobilePushDevices).where(eq(mobilePushDevices.deviceId, identity.deviceId)); return mobileJson({ enabled: false }); }
        if (typeof body.deviceToken !== "string" || !/^[a-f0-9]{64,200}$/i.test(body.deviceToken) || !["sandbox", "production"].includes(body.environment)) return mobileJson({ error: "Invalid push registration" }, 400);
        // Optional per-device key that seals notification content end to end (relay and APNs see ciphertext).
        if (body.contentKey !== undefined && (typeof body.contentKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.contentKey))) return mobileJson({ error: "Invalid content key" }, 400);
        const encrypted = encryptSecretPayload({ token: body.deviceToken, ...(body.contentKey ? { contentKey: body.contentKey } : {}) });
        if (!encrypted) return mobileJson({ error: "The server must configure EMPEROR_CLAW_MASTER_KEY before enabling notifications" }, 503);
        const kinds = Array.isArray(body.kinds) ? body.kinds.filter((kind: unknown): kind is string => typeof kind === "string" && (MOBILE_PUSH_KINDS as readonly string[]).includes(kind)) : DEFAULT_MOBILE_PUSH_KINDS;
        if (body.challenge !== undefined && (typeof body.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.challenge))) return mobileJson({ error: "Invalid challenge" }, 400);
        await relayPush(body.challenge ? "confirm" : "enroll", { deviceToken: body.deviceToken, environment: body.environment, deviceKind: identity.deviceKind, ...(body.challenge ? { challenge: body.challenge } : {}) });
        await db.insert(mobilePushDevices).values({ deviceId: identity.deviceId, tokenEncrypted: encrypted.encryptedSecret, environment: body.environment, kinds, enabled: Boolean(body.challenge) })
            .onConflictDoUpdate({ target: mobilePushDevices.deviceId, set: { tokenEncrypted: encrypted.encryptedSecret, environment: body.environment, kinds, enabled: Boolean(body.challenge), updatedAt: new Date() } });
        return mobileJson({ enabled: Boolean(body.challenge), confirmationRequired: !body.challenge });
    } catch (error) {
        if (error instanceof PushRelayError) return mobileJson({ error: error.message }, error.status);
        return mobileError(error);
    }
}
