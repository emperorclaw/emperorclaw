import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings } from "@/db/schema";
import { MOBILE_API_VERSION, MOBILE_CALLBACK } from "@/lib/mobile-contract";
import { mobileJson, mobileError } from "@/lib/mobile-response";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        // Stable across restarts/domain changes. Never derive identity from a
        // caller-supplied Host header or expose company/account metadata here.
        const key = "mobile_installation_id";
        await db.insert(instanceSettings).values({ key, value: randomUUID() }).onConflictDoNothing();
        const [row] = await db.select({ value: instanceSettings.value }).from(instanceSettings).where(eq(instanceSettings.key, key));
        return mobileJson({ product: "EmperorClaw", apiVersion: MOBILE_API_VERSION, installationId: row.value, callback: MOBILE_CALLBACK,
            capabilities: ["user_sessions", "companies", "agent_snapshot", "watch_pairing"],
            authorizationPath: "/mobile/authorize", tokenPath: "/api/mobile/v1/token" });
    } catch (error) { return mobileError(error); }
}
