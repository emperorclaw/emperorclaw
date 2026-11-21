import { NextRequest } from "next/server";
import { pairMobileWatch } from "@/lib/mobile-auth";
import { mobileJson, mobileError } from "@/lib/mobile-response";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
    const rate = consumeRateLimit({ key: `mobile:watch:${getClientIp(request)}`, limit: 30, windowMs: 60_000 });
    if (!rate.allowed) return mobileJson({ error: "Too many pairing requests" }, 429);
    try {
        const body = await request.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return mobileJson({ error: "Invalid request" }, 400);
        const replacing = body?.replacingDeviceId;
        if (replacing !== undefined && (typeof replacing !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replacing))) return mobileJson({ error: "Invalid device identifier" }, 400);
        return mobileJson(await pairMobileWatch(request, replacing));
    }
    catch (error) { return mobileError(error); }
}
