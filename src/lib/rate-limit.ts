import type { NextRequest } from "next/server";

type RateLimitEntry = {
    count: number;
    resetAt: number;
};

const rateLimitStore = new Map<string, RateLimitEntry>();

export function getClientIp(request: NextRequest | Request): string {
    const forwarded =
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-real-ip") ||
        request.headers.get("x-forwarded-for");

    if (forwarded) {
        const first = forwarded.split(",")[0]?.trim();
        if (first) return first;
    }

    return "unknown";
}

export function consumeRateLimit(input: {
    key: string;
    limit: number;
    windowMs: number;
    now?: number;
}) {
    const now = input.now ?? Date.now();
    const current = rateLimitStore.get(input.key);

    if (!current || current.resetAt <= now) {
        const next: RateLimitEntry = {
            count: 1,
            resetAt: now + input.windowMs,
        };
        rateLimitStore.set(input.key, next);
        cleanupRateLimitStore(now);
        return {
            allowed: true,
            remaining: Math.max(input.limit - 1, 0),
            retryAfterMs: input.windowMs,
        };
    }

    current.count += 1;
    rateLimitStore.set(input.key, current);
    cleanupRateLimitStore(now);

    const retryAfterMs = Math.max(current.resetAt - now, 0);
    return {
        allowed: current.count <= input.limit,
        remaining: Math.max(input.limit - current.count, 0),
        retryAfterMs,
    };
}

function cleanupRateLimitStore(now: number) {
    if (rateLimitStore.size < 5000) return;

    for (const [key, value] of rateLimitStore.entries()) {
        if (value.resetAt <= now) {
            rateLimitStore.delete(key);
        }
    }
}
